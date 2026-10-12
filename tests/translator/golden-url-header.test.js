// P0 GOLDEN: lock buildUrl + buildHeaders cho mọi provider trên code CŨ.
// Sinh snapshot lần đầu (baseline) → sau refactor chạy lại phải khớp y hệt.
// Mock proxyFetch + uuid-heavy executors KHÔNG cần ở đây vì chỉ gọi buildUrl/buildHeaders (pure).
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

// Credentials mẫu cố định (deterministic) — KHÔNG dùng Date.now/random.
const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };
const SPECIAL_CRED = {
  apiKey: "sk-test-APIKEY",
  accessToken: "tok-test-ACCESS",
  providerSpecificData: { accountId: "ACC123", region: "sgp", baseUrl: "https://custom.example.com/v1", orgId: "ORG9" },
};

// Provider cần executor riêng (buildUrl/buildHeaders không nằm ở DefaultExecutor) → bỏ qua ở golden này.
// Chúng được lock riêng ở 11-provider edge tests / unit test chuyên biệt.
const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "ollama-local", "commandcode",
  "xiaomi-tokenplan", "mimo-free",
]);

// Sanitize header: khử token + field thời gian động (kimi X-Msh-Device-Id) để snapshot ổn định.
function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    // KEY-SCOPED normalization for kimi headers whose value is host/install
    // identity, not part of the provider request contract:
    //   X-Msh-Device-Name <- hostname()            (open-sse/config/appConstants.js buildKimiHeaders)
    //   X-Msh-Version     <- package.json version  (getAppPackageVersion)
    // Both are environment-dependent (differ per machine, and X-Msh-Version
    // after every version bump), so recording them in a golden snapshot makes
    // the case pass only on the host/version that captured it.
    if (typeof v === "string" && k === "X-Msh-Device-Name") {
      out[k] = "<HOST>";
      continue;
    }
    if (typeof v === "string" && k === "X-Msh-Version") {
      out[k] = "<APP-VER>";
      continue;
    }
    // MiniMax Code (mcode) mints a fresh X-Mavis-Session-Id per call
    // (open-sse/executors/default.js randomUUID) — per-run identity, not
    // contract. Same rationale as X-Msh-* above (upstream v0.5.99 added the
    // provider; the sanitizer normalization must cover it).
    if (typeof v === "string" && k === "X-Mavis-Session-Id") {
      out[k] = "<MAVIS-SESSION>";
      continue;
    }
    // X-Mavis-Timezone-Offset embeds new Date().getTimezoneOffset()*-60
    // (open-sse/executors/default.js minimaxHeaders) — host-local timezone,
    // not contract. Same rationale as X-Msh-* above: a raw snapshot passes
    // only on the timezone that captured it (broke under TZ=Asia/Shanghai).
    if (typeof v === "string" && k === "X-Mavis-Timezone-Offset") {
      out[k] = "<TZ>";
      continue;
    }
    out[k] = typeof v === "string"
      ? v.replace(/Bearer .+/, "Bearer <TOK>")
          .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
          .replace(/kimi-\d{10,}/g, "kimi-<TS>")
          // X-PLATFORM-VERSION embeds process.version — varies per Node runtime
          // (local v22.22.3 vs CI v22.23.1). Normalize so golden snapshots are
          // environment-independent.
          .replace(/^v\d+\.\d+\.\d+$/, "v<VER>")
      : v;
  }
  return out;
}

const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

describe("GOLDEN buildUrl (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → url (stream + non-stream)`, () => {
      const ex = new DefaultExecutor(pid);
      const cred = PROVIDERS[pid].noAuth ? {} : SPECIAL_CRED;
      const model = "test-model";
      const snap = {
        stream: safe(() => ex.buildUrl(model, true, 0, cred)),
        nonStream: safe(() => ex.buildUrl(model, false, 0, cred)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

describe("GOLDEN buildHeaders (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → headers (apiKey / oauth)`, () => {
      const ex = new DefaultExecutor(pid);
      const snap = {
        apiKey: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true))),
        oauth: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true))),
        nonStream: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false))),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}
