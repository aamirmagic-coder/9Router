import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildCodexArgs, parseCodexEventLine, runCodexTurn, terminateProcessTree } from "../codexExec.js";

const config = {
  native: {
    command: "C:/codex.exe",
    sandbox: "read-only",
    modelProvider: "9router",
    baseUrl: "http://127.0.0.1:20128/v1",
    wireApi: "responses",
    ephemeral: true,
  },
  limits: {
    maxOutputBytes: 1024,
    timeoutMs: 1000,
    terminationGraceMs: 10,
  },
};

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1234;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test("builds an argument array without shell interpolation", () => {
  const args = buildCodexArgs({ model: "native-test", prompt: "hello; do not execute", config });
  assert.deepEqual(args.slice(0, 13), [
    "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-m", "native-test",
    "-c", 'model_provider="9router"', "-c", 'model_providers.9router.base_url="http://127.0.0.1:20128/v1"',
    "-c", 'model_providers.9router.wire_api="responses"',
  ]);
  assert.equal(args.at(-2), "--ephemeral");
  assert.equal(args.at(-1), "hello; do not execute");
});

test("parses JSONL Codex events and ignores diagnostics", () => {
  assert.deepEqual(parseCodexEventLine('{"type":"turn.completed"}'), { type: "turn.completed" });
  assert.equal(parseCodexEventLine("not-json"), null);
});

test("requires terminal completion and a final assistant message", async () => {
  const child = fakeChild();
  const resultPromise = runCodexTurn({
    config,
    model: "native-test",
    prompt: "hello",
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"hello back"}}\n'));
        child.stdout.emit("data", Buffer.from('{"type":"turn.completed"}\n'));
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.deepEqual(await resultPromise, { text: "hello back", dispatchStarted: true, terminalEvent: true });
});

test("rejects a process that exits without turn.completed", async () => {
  const child = fakeChild();
  await assert.rejects(() => runCodexTurn({
    config,
    model: "native-test",
    prompt: "hello",
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"hello back"}}\n'));
        child.emit("close", 0, null);
      });
      return child;
    },
    terminateImpl: async () => {},
  }), (error) => error.code === "native_terminal_event_missing" && error.dispatchStarted === true);
});

test("terminates a timed-out native process", async () => {
  const child = fakeChild();
  let terminated = false;
  await assert.rejects(() => runCodexTurn({
    config: { ...config, limits: { ...config.limits, timeoutMs: 5 } },
    model: "native-test",
    prompt: "hello",
    spawnImpl: () => child,
    terminateImpl: async () => { terminated = true; },
  }), (error) => error.code === "native_timeout" && error.dispatchStarted === true);
  assert.equal(terminated, true);
});

test("aborts and terminates a disconnected native process", async () => {
  const child = fakeChild();
  const controller = new AbortController();
  let terminated = false;
  const resultPromise = runCodexTurn({
    config,
    model: "native-test",
    prompt: "hello",
    signal: controller.signal,
    spawnImpl: () => child,
    terminateImpl: async () => { terminated = true; },
  });
  controller.abort();
  await assert.rejects(() => resultPromise, (error) => error.code === "request_aborted" && error.dispatchStarted === true);
  assert.equal(terminated, true);
});

test("uses taskkill to terminate the Windows process tree", async () => {
  const calls = [];
  await terminateProcessTree({ pid: 77 }, {
    platform: "win32",
    execFileImpl: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls[0].slice(0, 2), ["taskkill", ["/PID", "77", "/T", "/F"]]);
});
