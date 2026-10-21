"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * Cursor connect modal, laid out like Claude Code:
 * popup login, plus a manual callback URL paste.
 * Each login still gets its own machine ID.
 */
export default function CursorAuthModal({ isOpen, onSuccess, onClose }) {
  const [mode, setMode] = useState("login");
  const [loginUrl, setLoginUrl] = useState("");
  const [loginId, setLoginId] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [placeholderUrl, setPlaceholderUrl] = useState("http://localhost:20128/callback?code=...");
  const [waiting, setWaiting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [machineId, setMachineId] = useState("");
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);
  const [windowsManual, setWindowsManual] = useState(false);
  const pollRef = useRef(null);
  const loginIdRef = useRef("");
  const { copied, copy } = useCopyToClipboard();

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const finish = () => {
    stopPolling();
    setWaiting(false);
    onSuccess?.();
    onClose();
  };

  const pollOnce = async (id, pastedUrl) => {
    const res = await fetch("/api/oauth/cursor/login/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginId: id,
        ...(pastedUrl ? { callbackUrl: pastedUrl } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      setPlaceholderUrl(`${window.location.origin}/callback?code=...`);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      stopPolling();
      loginIdRef.current = "";
      setMode("login");
      setLoginUrl("");
      setLoginId("");
      setCallbackUrl("");
      setError(null);
      setWaiting(false);
      setConnecting(false);
      setAccessToken("");
      setMachineId("");
      setAutoDetected(false);
      setWindowsManual(false);
      return undefined;
    }

    let cancelled = false;
    (async () => {
      stopPolling();
      setError(null);
      setWaiting(true);
      try {
        const res = await fetch("/api/oauth/cursor/login/start", { method: "POST" });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.loginUrl || !data.loginId) {
          throw new Error(data.error || "Could not start Cursor login");
        }
        loginIdRef.current = data.loginId;
        setLoginId(data.loginId);
        setLoginUrl(data.loginUrl);
        window.open(data.loginUrl, "cursor_login", "width=600,height=760");
        pollRef.current = setInterval(async () => {
          try {
            const { res: pollRes, data: pollData } = await pollOnce(data.loginId);
            if (cancelled || pollData.pending) return;
            if (pollData.success) {
              finish();
              return;
            }
            if (pollData.fatal || pollRes.status === 400) {
              stopPolling();
              setWaiting(false);
              setError(pollData.error || "Cursor login failed");
            }
          } catch {
            // Keep polling through a single network blip.
          }
        }, 2000);
      } catch (err) {
        if (cancelled) return;
        stopPolling();
        setWaiting(false);
        setError(err.message);
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || mode !== "login") return undefined;

    const applyCallback = (data) => {
      const fullUrl = data?.fullUrl;
      if (!fullUrl || !loginIdRef.current) return;
      setCallbackUrl(fullUrl);
      submitCallback(fullUrl);
    };

    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "oauth_callback") applyCallback(event.data.data);
    };
    const onStorage = (event) => {
      if (event.key !== "oauth_callback" || !event.newValue) return;
      try {
        applyCallback(JSON.parse(event.newValue));
      } catch {
        // Ignore a malformed callback payload.
      }
    };

    let channel;
    try {
      channel = new BroadcastChannel("oauth_callback");
      channel.onmessage = (event) => applyCallback(event.data);
    } catch {
      channel = null;
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
      channel?.close();
    };
  }, [isOpen, mode]);

  const submitCallback = async (rawUrl) => {
    const input = (rawUrl ?? callbackUrl).trim();
    if (!input) return;
    if (!loginIdRef.current) {
      setError("Cursor login expired. Close this dialog and start again.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const { res, data } = await pollOnce(loginIdRef.current, input);
      if (data.success) {
        finish();
        return;
      }
      if (data.pending) {
        setError("Cursor has not finished this login yet. Approve it in the browser, then paste the callback URL again.");
        return;
      }
      setError(data.error || (res.ok ? "Cursor login failed" : "Could not use that callback URL"));
    } catch {
      setError("Could not use that callback URL");
    } finally {
      setConnecting(false);
    }
  };

  const runAutoDetect = async () => {
    setAutoDetecting(true);
    setError(null);
    setAutoDetected(false);
    setWindowsManual(false);
    try {
      const res = await fetch("/api/oauth/cursor/auto-import");
      const data = await res.json();
      if (data.found) {
        setAccessToken(data.accessToken);
        setMachineId(data.machineId);
        setAutoDetected(true);
      } else if (data.windowsManual) {
        setWindowsManual(true);
      } else {
        setError(data.error || "Could not auto-detect tokens");
      }
    } catch {
      setError("Failed to auto-detect tokens");
    } finally {
      setAutoDetecting(false);
    }
  };

  const handleImportToken = async () => {
    if (!accessToken.trim() || !machineId.trim()) {
      setError("Access token and machine ID are required");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/cursor/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: accessToken.trim(),
          machineId: machineId.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect Cursor" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {mode === "login" && (
          <>
            <div className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg bg-sidebar/50">
              <span className="material-symbols-outlined text-base text-primary animate-spin">
                progress_activity
              </span>
              <span className="text-sm">
                {waiting ? "Waiting for popup authorization…" : "Starting Cursor login…"}
              </span>
            </div>

            <div className="flex items-center gap-3 my-1">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-text-muted uppercase tracking-wider">Or paste callback URL manually</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium mb-2">Step 1: Open this URL in your browser</p>
                <div className="flex gap-2">
                  <Input value={loginUrl} readOnly className="flex-1 font-mono text-xs" />
                  <Button
                    variant="secondary"
                    icon={copied === "auth_url" ? "check" : "content_copy"}
                    onClick={() => copy(loginUrl, "auth_url")}
                    disabled={!loginUrl}
                  >
                    Copy
                  </Button>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-2">Step 2: Paste the callback URL here</p>
                <p className="text-xs text-text-muted mb-2">
                  After authorization, copy the full URL from your browser.
                </p>
                <Input
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  placeholder={placeholderUrl}
                  className="font-mono text-xs"
                />
              </div>
            </div>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <div className="flex gap-2">
              <Button onClick={() => submitCallback()} fullWidth disabled={!callbackUrl || connecting || !loginId}>
                {connecting ? "Connecting…" : "Connect"}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
            </div>

            <button
              type="button"
              className="text-xs text-text-muted hover:text-primary"
              onClick={() => {
                setMode("import");
                setError(null);
                if (!accessToken && !autoDetecting) runAutoDetect();
              }}
            >
              Import the token from this IDE instead
            </button>
          </>
        )}

        {mode === "import" && (
          <>
            <button
              type="button"
              className="text-xs text-left text-text-muted hover:text-primary"
              onClick={() => { setMode("login"); setError(null); }}
            >
              Back to browser login
            </button>

            <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                Import uses this IDE&apos;s machine ID. Cursor only allows one account on that ID.
                Add any other account with browser login.
              </p>
            </div>

            {autoDetecting && (
              <p className="text-sm text-text-muted">Reading the Cursor IDE database…</p>
            )}
            {autoDetected && (
              <p className="text-sm text-green-700 dark:text-green-300">Tokens read from Cursor IDE.</p>
            )}
            {windowsManual && (
              <Button onClick={runAutoDetect} variant="outline" fullWidth>Retry</Button>
            )}

            <div>
              <label className="block text-sm font-medium mb-2">Access Token</label>
              <textarea
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Machine ID</label>
              <Input
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex gap-2">
              <Button
                onClick={handleImportToken}
                fullWidth
                disabled={importing || !accessToken.trim() || !machineId.trim()}
              >
                {importing ? "Importing…" : "Import Token"}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

CursorAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
