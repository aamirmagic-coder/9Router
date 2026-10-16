"""OpenAI-compatible sidecar for the muse.ai personal agent.

Why this process exists
-----------------------
9router is a Node application, but the muse.ai edge refuses a Node TLS
handshake and only answers a browser-like ClientHello. The Noise XX
handshake below was ported to Node and matched the reference byte for
byte, and the gateway still cut the connection — the differentiator is
the TLS fingerprint, not the protocol. curl_cffi provides that
fingerprint; Node cannot, short of native addons.

So: this small FastAPI process owns the transport and exposes a plain
OpenAI surface on localhost. The `muse-ai` provider in 9router points at
it. Nothing on the network boundary is special — it binds 127.0.0.1.

Endpoints
---------
  GET  /healthz                 liveness + account slots
  GET  /v1/models               OpenAI model list
  POST /v1/chat/completions     chat (streaming SSE + buffered JSON)
  GET  /admin/accounts          account state
  POST /admin/accounts          add/replace an account (label + cookies)

Run:  python server.py       (see README.md in this directory)
"""
import hashlib
import json
import os
import queue
import sys
import threading
import time
import uuid

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from gateway import AuthError, Gateway, GatewayError, TransportError, load_cookies

HERE = os.path.dirname(os.path.abspath(__file__))

# ── configuration ─────────────────────────────────────────────────────────
DEFAULTS = {
    "host": "127.0.0.1",
    "port": 18611,
    "api_key": "sk-muse-local",
    "accounts": [],
    "poll_interval": 1.2,      # history poll cadence while a reply streams
    "first_token_timeout": 90,  # fail if the agent has not started replying
    "idle_timeout": 45,         # stop once the reply stops growing this long
    "max_wait": 300,            # hard ceiling for one turn
}

# Muse has no published context/limit figures. These are conservative
# placeholders so downstream clients size prompts sanely; they are not
# measurements and should not be presented to users as specs.
CONTEXT_WINDOW = 100000
MAX_OUTPUT = 8192

MODEL_ALIASES = ["muse-chat", "gpt-4o", "gpt-5", "claude-sonnet-4", "muse-video"]
PRIMARY_MODEL = "muse-chat"

# Muse has no native function calling (confirmed: the upstream reference
# implementation tracks "emulated tool calling" as unstarted, and its own
# notes warn the agent may refuse to follow a tool schema at all). When a
# client sends `tools`, the bridge states this plainly in the prompt and
# returns an empty tool_calls list rather than inventing calls that would
# never run. Callers that need real tool use should route elsewhere.
TOOL_NOTICE = (
    "Tool notice: this request declared tools, but this backend has no "
    "function-calling support. Do not emit tool-call JSON; answer in plain "
    "text and describe what would need to be done."
)


def _load_config():
    cfg = dict(DEFAULTS)
    path = (os.environ.get("MUSE_BRIDGE_CONFIG")
            or os.path.join(HERE, "config.json")
            or "")
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    if os.environ.get("MUSE_BRIDGE_PORT"):
        cfg["port"] = int(os.environ["MUSE_BRIDGE_PORT"])
    if os.environ.get("MUSE_BRIDGE_API_KEY"):
        cfg["api_key"] = os.environ["MUSE_BRIDGE_API_KEY"]
    return cfg


CONFIG = _load_config()

app = FastAPI(title="muse-bridge", docs_url=None, redoc_url=None)


# ── accounts ──────────────────────────────────────────────────────────────
class Account:
    """One muse.ai login plus its long-lived gateway connection."""

    def __init__(self, label, cookies, vm_id=None):
        self.label = label
        self.cookies = cookies
        self.vm_id = vm_id
        # Deterministic node id so the agent sees a stable client identity
        # across restarts without persisting state anywhere.
        self.node_id = hashlib.sha256(label.encode()).hexdigest()[:16]
        self._gw = None
        self._gen = 0
        self._lock = threading.Lock()
        # One turn at a time per account. Two concurrent reads would pull
        # frames off the same socket and route them to the wrong stream
        # (the Noise transport is stateful, so it is not just misrouting —
        # interleaved decrypts corrupt it outright).
        self._turn = threading.Lock()
        self.last_ok = None
        self.last_error = None

    @property
    def generation(self):
        with self._lock:
            return self._gen

    def gateway(self):
        """Return the live gateway, connecting on first use.

        Raises whatever Gateway() raises so the caller can classify it
        (auth vs transient) before deciding to retry.
        """
        with self._lock:
            if self._gw is None:
                self._gw = Gateway(self.cookies, vm_id=self.vm_id)
            return self._gw

    def invalidate(self):
        """Drop the current connection; the next call reconnects."""
        with self._lock:
            self._gen += 1
            if self._gw is not None:
                gw, self._gw = self._gw, None
            else:
                gw = None
        if gw is not None:
            # Close outside the lock: ws.close() can block on a half-dead
            # socket and would otherwise stall every other request.
            gw.close()


ACCOUNTS = []


def _wire_accounts():
    cfg = CONFIG
    entries = list(cfg.get("accounts") or [])
    # Convenience: a bare cookies.txt next to this file is one account.
    if not entries:
        local = os.path.join(HERE, "cookies.txt")
        if os.path.exists(local):
            entries.append({"label": "default", "cookies_file": local})
    for e in entries:
        label = e.get("label") or "default"
        try:
            if e.get("cookies"):
                cookies = e["cookies"]
            else:
                cf = e.get("cookies_file") or os.path.join(HERE, "cookies.txt")
                if not os.path.isabs(cf):
                    cf = os.path.join(HERE, cf)
                cookies = load_cookies(cf)
        except (AuthError, OSError) as exc:
            print(f"[muse-bridge] account '{label}' skipped: {exc}", file=sys.stderr)
            continue
        ACCOUNTS.append(Account(label, cookies, e.get("vm_id")))
    if not ACCOUNTS:
        print("[muse-bridge] no usable accounts. Put cookies in "
              f"{os.path.join(HERE, 'cookies.txt')} or list them in config.json.",
              file=sys.stderr)


_wire_accounts()
_rr_lock = threading.Lock()
_rr_next = 0


def _pick_account():
    """Round-robin across accounts. One account = one personal VM, so a
    single-account setup simply always returns that account."""
    global _rr_next
    if not ACCOUNTS:
        raise HTTPException(503, "no muse.ai accounts configured")
    with _rr_lock:
        acc = ACCOUNTS[_rr_next % len(ACCOUNTS)]
        _rr_next += 1
    return acc


# ── message flattening ────────────────────────────────────────────────────
def _content_text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, str):
                out.append(part)
            elif isinstance(part, dict):
                if part.get("type") == "text" and part.get("text"):
                    out.append(part["text"])
                elif part.get("text"):
                    out.append(str(part["text"]))
        return "\n".join(out)
    return str(content)


def _flatten(messages):
    """Fold an OpenAI message array into one transcript.

    Muse drives a single conversational agent, not a message-array API, so
    prior turns are replayed as a labelled transcript. This is the honest
    shape: pretending each turn is a separate API call would lose the
    agent's own memory of the conversation.
    """
    labels = {"system": "System", "user": "User", "assistant": "Assistant",
              "developer": "System"}
    parts = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "user")
        text = _content_text(m.get("content")).strip()
        if role == "tool":
            name = m.get("name") or m.get("tool_call_id") or "result"
            label = f"Tool result ({name})"
            if not text:
                text = "(no output)"
        else:
            label = labels.get(role, role.title())
        if text:
            parts.append(f"{label}: {text}")
    return "\n\n".join(parts)


# ── history helpers ───────────────────────────────────────────────────────
def _assistant_text(ev, baseline, session_id=None):
    """Extract a genuine assistant reply, or None.

    Genuine replies are `message.assistant` events with no reply_to_message_id;
    proactive pushes (background task updates, Telegram drafts) are
    self-referential there and must not be mistaken for an answer.
    """
    if ev.get("event_name") != "message.assistant":
        return None
    if (ev.get("seq") or 0) <= baseline:
        return None
    p = ev.get("payload") if isinstance(ev.get("payload"), dict) else {}
    if ev.get("reply_to_message_id") or p.get("reply_to_message_id"):
        return None
    txt = p.get("display_text") or p.get("content") or ""
    if not txt:
        return None
    return txt, bool(p.get("display_text_ready", True))


def _baseline(gw, session_id=None):
    scope = {"session_id": session_id} if session_id else {}
    try:
        h = gw.call_json("chat.history", body={"limit": 1, **scope})
        evs = h.get("chat_events") or []
        if evs:
            return max((e.get("seq") or 0) for e in evs)
    except (GatewayError, TransportError, TimeoutError):
        pass
    return 0


# ── the streaming bridge ──────────────────────────────────────────────────
class _UpstreamError(RuntimeError):
    pass


def _run_in_thread(gen, deadline):
    """Drive `gen` in a worker thread and yield items here.

    The gateway client is blocking; running it inline would block the event
    loop that is also serving the SSE response. The worker owns every socket
    call for the turn, so exactly one thread consumes frames at a time —
    which the Noise transport requires.
    """
    q = queue.Queue()

    def worker():
        try:
            for item in gen:
                q.put(("item", item))
            q.put(("end", None))
        except BaseException as exc:  # noqa: BLE001 — re-raised in the caller
            q.put(("err", exc))

    threading.Thread(target=worker, daemon=True).start()
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise _UpstreamError("timed out waiting for the muse agent")
        try:
            kind, val = q.get(timeout=min(remaining, 5))
        except queue.Empty:
            continue
        if kind == "item":
            yield val
        elif kind == "end":
            return
        else:
            raise val


def _stream_turn(acc, prompt):
    """Yield text deltas for one turn, reconnecting once if the socket died.

    Holds the account's turn lock for the whole exchange. `generation` is
    read inside the lock so a concurrent invalidate() cannot land between
    the lock and the first frame.
    """
    with acc._turn:
        attempt = 0
        while True:
            gen = acc.generation
            try:
                gw = acc.gateway()
                yield from _stream_once(acc, gw, gen, prompt)
                return
            except (GatewayError, TransportError, TimeoutError, OSError) as exc:
                acc.last_error = f"{type(exc).__name__}: {exc}"[:200]
                acc.invalidate()
                if attempt >= 1:
                    raise
                attempt += 1


def _stream_once(acc, gw, gen, prompt):
    baseline = _baseline(gw)
    params = {
        "items": [{"type": "text", "text": prompt}],
        "node_id": acc.node_id,
        "capabilities": {},
    }
    # chat.stream returns only a send echo; the reply itself is read from
    # history. Live subscription frames use a different event shape and miss
    # threaded replies entirely, so polling history is the reliable path.
    gw._open("chat.stream", body=params)

    started = time.time()
    seen = ""
    last_growth = started
    while True:
        now = time.time()
        if now - started > CONFIG["max_wait"]:
            if seen:
                return
            raise _UpstreamError("muse agent did not answer within max_wait")
        if seen and now - last_growth > CONFIG["idle_timeout"]:
            return
        if not seen and now - started > CONFIG["first_token_timeout"]:
            raise _UpstreamError("muse agent never started replying")

        try:
            h = gw.call_json("chat.history", body={"limit": 10}, timeout=20)
        except (GatewayError, TransportError, TimeoutError):
            time.sleep(CONFIG["poll_interval"])
            continue

        for ev in sorted(h.get("chat_events") or [], key=lambda e: e.get("seq") or 0):
            if gen != acc.generation:
                # Another request reconnected this account; this stream is
                # reading a socket that is no longer live.
                return
            got = _assistant_text(ev, baseline)
            if not got:
                continue
            full, ready = got
            if full.startswith(seen) and len(full) > len(seen):
                delta = full[len(seen):]
                seen = full
                last_growth = time.time()
                yield delta
            if ready and full == seen:
                acc.last_ok = time.time()
                return
        time.sleep(CONFIG["poll_interval"])


# ── HTTP surface ──────────────────────────────────────────────────────────
def _auth(authorization):
    key = CONFIG.get("api_key") or ""
    if not key:
        return
    token = (authorization or "").removeprefix("Bearer ").strip()
    if token != key:
        raise HTTPException(401, "invalid api key")


def _chunk(cid, model, delta, finish=None):
    return {
        "id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _sse(payload):
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/healthz")
def healthz():
    return {
        "ok": bool(ACCOUNTS),
        "accounts": [
            {"label": a.label, "vm_id": a.vm_id, "last_ok": a.last_ok,
             "last_error": a.last_error}
            for a in ACCOUNTS
        ],
    }


@app.get("/v1/models")
def models():
    return {
        "object": "list",
        "data": [{"id": m, "object": "model", "owned_by": "muse.ai",
                  "context_window": CONTEXT_WINDOW, "max_output": MAX_OUTPUT}
                 for m in MODEL_ALIASES],
    }


@app.get("/admin/accounts")
def list_accounts(authorization: str = Header(None)):
    _auth(authorization)
    return {"accounts": [{"label": a.label, "vm_id": a.vm_id,
                          "last_ok": a.last_ok, "last_error": a.last_error}
                         for a in ACCOUNTS]}


@app.post("/admin/accounts")
async def add_account(request: Request, authorization: str = Header(None)):
    _auth(authorization)
    body = await request.json()
    label = (body.get("label") or "default").strip()
    cookies = body.get("cookies")
    if not cookies:
        cf = body.get("cookies_file") or os.path.join(HERE, "cookies.txt")
        if not os.path.isabs(cf):
            cf = os.path.join(HERE, cf)
        try:
            cookies = load_cookies(cf)
        except (AuthError, OSError) as exc:
            raise HTTPException(400, f"cannot read cookies: {exc}")
    for a in ACCOUNTS:
        if a.label == label:
            a.cookies = cookies
            a.vm_id = body.get("vm_id")
            a.invalidate()
            return {"replaced": label}
    ACCOUNTS.append(Account(label, cookies, body.get("vm_id")))
    return {"added": label}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, authorization: str = Header(None)):
    _auth(authorization)
    body = await request.json()
    messages = body.get("messages") or []
    if not messages:
        raise HTTPException(400, "messages is required")

    model = body.get("model") or PRIMARY_MODEL
    stream = bool(body.get("stream"))
    prompt = _flatten(messages)
    if body.get("tools") or body.get("functions"):
        prompt = f"{prompt}\n\n{TOOL_NOTICE}"

    acc = _pick_account()
    cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    deadline = time.time() + CONFIG["max_wait"] + 30

    if not stream:
        try:
            text = "".join(_run_in_thread(_stream_turn(acc, prompt), deadline))
        except _UpstreamError as exc:
            raise HTTPException(504, str(exc))
        except AuthError as exc:
            raise HTTPException(502, f"muse auth: {exc}")
        except (GatewayError, TransportError, TimeoutError, OSError) as exc:
            raise HTTPException(502, f"muse gateway: {exc}")
        except Exception as exc:  # noqa: BLE001 — never a blank 500; name the culprit
            raise HTTPException(500, f"muse bridge internal: {type(exc).__name__}: {exc}")
        return JSONResponse({
            "id": cid, "object": "chat.completion", "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": text,
                                     "tool_calls": []}}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })

    def event_stream():
        yield _sse(_chunk(cid, model, {"role": "assistant", "content": ""}))
        try:
            for delta in _run_in_thread(_stream_turn(acc, prompt), deadline):
                yield _sse(_chunk(cid, model, {"content": delta}))
        except _UpstreamError as exc:
            yield _sse({"error": {"message": str(exc), "type": "timeout"}})
            yield "data: [DONE]\n\n"
            return
        except AuthError as exc:
            yield _sse({"error": {"message": f"muse auth: {exc}",
                                  "type": "authentication_error"}})
            yield "data: [DONE]\n\n"
            return
        except (GatewayError, TransportError, TimeoutError, OSError) as exc:
            yield _sse({"error": {"message": f"muse gateway: {exc}",
                                  "type": "upstream_error"}})
            yield "data: [DONE]\n\n"
            return
        except Exception as exc:  # noqa: BLE001 — same reasoning as the buffered path
            yield _sse({"error": {"message": f"muse bridge internal: {type(exc).__name__}: {exc}",
                                  "type": "internal_error"}})
            yield "data: [DONE]\n\n"
            return
        yield _sse(_chunk(cid, model, {}, finish="stop"))
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    if not ACCOUNTS:
        print("[muse-bridge] refusing to start without an account", file=sys.stderr)
        sys.exit(1)
    print(f"[muse-bridge] listening on http://{CONFIG['host']}:{CONFIG['port']} "
          f"({len(ACCOUNTS)} account(s))")
    uvicorn.run(app, host=CONFIG["host"], port=CONFIG["port"], log_level="warning")
