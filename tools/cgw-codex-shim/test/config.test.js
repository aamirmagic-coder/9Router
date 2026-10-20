import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseModelAliases } from "../config.js";

const baseEnv = {
  CGW_SHIM_API_KEY: "test-key",
  CGW_SHIM_MODEL_ALIASES_JSON: JSON.stringify({ "gpt-test": "native-test" }),
  CGW_SHIM_CODEX_BIN: "C:/codex.exe",
  CGW_SHIM_CODEX_BASE_URL: "http://127.0.0.1:20128/v1",
};

test("parses deterministic model aliases", () => {
  assert.deepEqual(parseModelAliases('{"gpt-a":"native-a","gpt-b":"native-b"}'), {
    "gpt-a": "native-a",
    "gpt-b": "native-b",
  });
});

test("rejects malformed or empty model aliases", () => {
  assert.throws(() => parseModelAliases("[]"), /object/);
  assert.throws(() => parseModelAliases('{"":"native"}'), /alias/);
  assert.throws(() => parseModelAliases('{"public":""}'), /native model/);
});

test("loads fail-closed loopback configuration", () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.apiKey, "test-key");
  assert.deepEqual(config.modelAliases, { "gpt-test": "native-test" });
  assert.equal(config.native.baseUrl, "http://127.0.0.1:20128/v1");
  assert.equal(config.native.shell, false);
});

test("rejects non-loopback binds and missing dedicated keys", () => {
  assert.throws(() => loadConfig({ ...baseEnv, CGW_SHIM_HOST: "0.0.0.0" }), /loopback/);
  const { CGW_SHIM_API_KEY: _, ...withoutKey } = baseEnv;
  assert.throws(() => loadConfig(withoutKey), /CGW_SHIM_API_KEY/);
});

test("parses bounded numeric settings", () => {
  const config = loadConfig({
    ...baseEnv,
    CGW_SHIM_MAX_BODY_BYTES: "1024",
    CGW_SHIM_MAX_CONCURRENT: "2",
    CGW_SHIM_MAX_QUEUE: "3",
    CGW_SHIM_TIMEOUT_MS: "5000",
  });
  assert.equal(config.limits.maxBodyBytes, 1024);
  assert.equal(config.limits.maxConcurrent, 2);
  assert.equal(config.limits.maxQueue, 3);
  assert.equal(config.limits.timeoutMs, 5000);
  assert.throws(() => loadConfig({ ...baseEnv, CGW_SHIM_TIMEOUT_MS: "0" }), /TIMEOUT/i);
});
