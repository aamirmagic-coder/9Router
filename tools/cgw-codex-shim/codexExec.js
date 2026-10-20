import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function buildCodexArgs({ model, prompt, config }) {
  const providerKey = config.native.modelProvider;
  const args = [
    "exec",
    "--json",
    "--sandbox",
    config.native.sandbox,
    "--skip-git-repo-check",
    "-m",
    model,
    "-c",
    `model_provider=${tomlString(providerKey)}`,
    "-c",
    `model_providers.${providerKey}.base_url=${tomlString(config.native.baseUrl)}`,
    "-c",
    `model_providers.${providerKey}.wire_api=${tomlString(config.native.wireApi)}`,
  ];
  if (config.native.ephemeral) args.push("--ephemeral");
  args.push(prompt);
  return args;
}

export function parseCodexEventLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function nativeEnvironment(config) {
  const names = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "HTTP_PROXY",
    "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "LANG", "LC_ALL",
  ];
  const env = {};
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (config.native.codexHome) env.CODEX_HOME = config.native.codexHome;
  return env;
}

export async function terminateProcessTree(child, {
  platform = process.platform,
  graceMs = 1500,
  execFileImpl = execFile,
} = {}) {
  if (!child?.pid) return;
  if (platform === "win32") {
    try {
      await execFileImpl("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      return;
    }
    return;
  }

  try { child.kill("SIGTERM"); } catch { return; }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (!child.killed) {
    try { child.kill("SIGKILL"); } catch { /* process already exited */ }
  }
}

function errorWithState(message, dispatchStarted, code = "native_execution_failed") {
  const error = new Error(message);
  error.code = code;
  error.dispatchStarted = dispatchStarted;
  return error;
}

export function runCodexTurn({
  config,
  model,
  prompt,
  signal,
  spawnImpl = nodeSpawn,
  terminateImpl = terminateProcessTree,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(errorWithState("request aborted before native dispatch", false, "request_aborted"));
      return;
    }

    const args = buildCodexArgs({ model, prompt, config });
    const child = spawnImpl(config.native.command, args, {
      cwd: config.native.cwd,
      env: nativeEnvironment(config),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let terminalEvent = false;
    let finalText = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lineBuffer = "";
    let timer;

    const dispatchState = { value: "dispatch-attempted" };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
    };
    const settleError = async (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error.dispatchStarted = dispatchState.value !== "pre-dispatch";
      try { await terminateImpl(child, { graceMs: config.limits.terminationGraceMs }); } catch { /* cleanup is best effort */ }
      reject(error);
    };
    const abortHandler = () => {
      void settleError(errorWithState("request aborted during native dispatch", true, "request_aborted"));
    };
    const processEvent = (event) => {
      if (!event) return;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        finalText = event.item.text.trim();
      }
      if (event.type === "turn.failed") {
        void settleError(errorWithState(event.error?.message || "native turn failed", true, "native_turn_failed"));
      }
      if (event.type === "turn.completed") terminalEvent = true;
    };

    const consumeStdout = (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > config.limits.maxOutputBytes) {
        void settleError(errorWithState("native stdout exceeded configured limit", true, "native_output_too_large"));
        return;
      }
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) processEvent(parseCodexEventLine(line));
    };
    const consumeStderr = (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > config.limits.maxOutputBytes) {
        void settleError(errorWithState("native stderr exceeded configured limit", true, "native_output_too_large"));
      }
    };

    signal?.addEventListener("abort", abortHandler, { once: true });
    child.stdout?.on("data", consumeStdout);
    child.stderr?.on("data", consumeStderr);
    child.once("error", (error) => void settleError(errorWithState(error.message, true, "native_process_error")));
    child.once("close", (code, signalName) => {
      if (settled) return;
      cleanup();
      if (terminalEvent && finalText && code === 0 && !signalName) {
        settled = true;
        resolve({ text: finalText, dispatchStarted: true, terminalEvent: true });
        return;
      }
      void settleError(errorWithState(
        terminalEvent ? "native process ended without a valid final response" : "native process ended without turn.completed",
        true,
        terminalEvent ? "native_final_output_missing" : "native_terminal_event_missing",
      ));
    });
    timer = setTimeout(() => {
      void settleError(errorWithState("native execution timed out", true, "native_timeout"));
    }, config.limits.timeoutMs);
  });
}
