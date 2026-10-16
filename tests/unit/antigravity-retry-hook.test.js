// Guards D3: antigravity 429/503 retry merged into base via computeRetryDelay hook.
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { setAntigravityHostMode } from "../../open-sse/providers/shared.js";

const MAX = 10000;
function res(status, headers = {}, body = null) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => (body == null ? "" : JSON.stringify(body)) }),
  };
}

describe("antigravity computeRetryDelay hook (D3)", () => {
  const ag = new AntigravityExecutor();

  it("uses Retry-After header (seconds → ms) when within cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "5" }), 1)).toBe(5000);
  });

  it("vetoes (false) when Retry-After exceeds cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "60" }), 1)).toBe(false);
  });

  it("parses retry time from error body when no header", async () => {
    const r = res(429, {}, { error: { message: "quota will reset after 3s" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(3000);
  });

  it("429 tanpa info retry → veto, bukan backoff buta", async () => {
    // Perilaku LAMA: 429 tanpa info → backoff eksponensial 2s/4s.
    // Itu diubah 2026-09-20 karena biayanya terukur: dengan attempts:2 di tiga
    // host, payload besar (image + 123 tool, ~7s per percobaan) menghabiskan
    // 48-64 detik sebelum menyerah, naik dari ~12 detik.
    //
    // 429 kini di-retry in-place HANYA bila upstream menyebut kapan pulih
    // (Retry-After / RetryInfo.retryDelay / quotaResetDelay).
    expect(await ag.computeRetryDelay(res(429), 1)).toBe(false);
    expect(await ag.computeRetryDelay(res(429), 3)).toBe(false);
  });

  it("membaca pesan burst asli 'Resets in 0s.' (regresi 2026-09-20)", async () => {
    // Bentuk PERSIS dari upstream. Pola lama `/reset after/` tidak cocok dengan
    // "Resets in", sehingga 429 burst diperlakukan sebagai backoff 2s padahal
    // upstream bilang reset dalam 0 detik. Terukur: quotaResetDelay 162ms.
    const r = res(429, {}, {
      error: { message: "You have exhausted your capacity on this model. Resets in 0s." },
    });
    // 0s → tidak ada durasi positif → null → jatuh ke backoff (bukan salah baca).
    expect(await ag.parseRetryFromErrorMessage("Resets in 0s.")).toBeNull();
  });

  it("membaca 'Resets in <d>s' dan bentuk jam/menit", () => {
    expect(ag.parseRetryFromErrorMessage("Resets in 5s.")).toBe(5000);
    expect(ag.parseRetryFromErrorMessage("Resets in 1m30s.")).toBe(90000);
    expect(ag.parseRetryFromErrorMessage("Resets in 2h5m10s")).toBe(2 * 3600 * 1000 + 5 * 60 * 1000 + 10 * 1000);
    // Bentuk lama harus tetap jalan.
    expect(ag.parseRetryFromErrorMessage("quota will reset after 3s")).toBe(3000);
    // Detik pecahan (RetryInfo.retryDelay) tidak boleh bikin NaN.
    expect(ag.parseRetryFromErrorMessage("Resets in 0.162322081s.")).toBeCloseTo(162.3, 0);
  });

  it("503 without retry info → transient backoff", async () => {
    expect(await ag.computeRetryDelay(res(503), 1)).toBe(2000);
  });

  it("retries Antigravity agent terminated body even when status is not 429", async () => {
    const r = res(500, {}, { error: { message: "Agent execution terminated due to error" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(2000);
  });

  it("retries high traffic body", async () => {
    const r = res(500, {}, { error: { message: "Our servers are experiencing high traffic" } });
    expect(await ag.computeRetryDelay(r, 2)).toBe(4000);
  });

  it("does not retry non-transient 400 errors", async () => {
    const r = res(400, {}, { error: { message: "Invalid request" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(false);
  });

  it("deduplicates sanitized tool names", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [
          { name: "read/file", parameters: { type: "object", properties: {} } },
          { name: "read file", parameters: { type: "object", properties: {} } },
          { name: "read/file", parameters: { type: "object", properties: {} } },
        ] }],
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.request.tools[0].functionDeclarations.map(fn => fn.name)).toEqual(["read_file"]);
  });

  it("registry uses the daily IDE cloudcode host and user agent", () => {
    // Host resmi IDE harus tetap PERTAMA (dipakai selama pool-nya sehat).
    // Fork menambah 2 host sandbox untuk rotasi kapasitas; upstream hanya 1.
    expect(antigravity.transport.baseUrls[0]).toBe("https://daily-cloudcode-pa.googleapis.com");
    expect(antigravity.transport.baseUrls.length).toBeGreaterThanOrEqual(1);
    expect(antigravity.transport.headers["User-Agent"]).toBe("antigravity/ide/2.22.0 darwin/arm64");
  });

  it("registry lists the sandbox capacity pools as fallback hosts", () => {
    // Google menjalankan pool kapasitas TERPISAH per host. Saat `daily`
    // kehabisan kapasitas untuk sebuah model (503 "No capacity available"),
    // host sandbox masih penuh — terukur live 2026-09-13: daily 5% sukses,
    // kedua sandbox 100% sukses pada 40 akun.
    expect(antigravity.transport.baseUrls).toEqual([
      "https://daily-cloudcode-pa.googleapis.com",
      "https://autopush-cloudcode-pa.sandbox.googleapis.com",
      "https://staging-cloudcode-pa.sandbox.googleapis.com",
    ]);
  });

  it("mode daily-only eksplisit: TIDAK ada rotasi host (1 host, tidak ada tujuan)", () => {
    // Default sekarang daily-only = 1 host, jadi tidak ada tujuan rotasi.
    // Ini disengaja: 9Router upstream dan CLIProxyAPI sama-sama memakai daily
    // saja dan mengandalkan rotasi AKUN. Host sandbox punya gerbang tambahan
    // (403 #3501 untuk project yang tidak dikenali).
    setAntigravityHostMode("daily-only");
    const exec = new AntigravityExecutor();
    expect(exec.getBaseUrls().length).toBe(1);

    for (const status of [429, 500, 502, 503, 504]) {
      expect(exec.shouldRetry(status, 0)).toBe(false);
    }
    // Error permanen tetap tidak memutar host.
    for (const status of [400, 401, 403, 404]) {
      expect(exec.shouldRetry(status, 0)).toBe(false);
    }
  });

  it("mode sandbox: rotates host on capacity-exhaustion statuses but not on permanent errors", () => {
    setAntigravityHostMode("all-hosts");
    try {
      const exec = new AntigravityExecutor();
      const last = exec.getFallbackCount() - 1;

      // Status transien -> maju ke host berikutnya.
      for (const status of [500, 502, 503, 504]) {
        expect(exec.shouldRetry(status, 0)).toBe(true);
      }
      // 429 tetap berperilaku seperti sebelumnya.
      expect(exec.shouldRetry(429, 0)).toBe(true);

      // Di host terakhir tidak ada tujuan rotasi lagi.
      for (const status of [429, 500, 502, 503, 504]) {
        expect(exec.shouldRetry(status, last)).toBe(false);
      }

      // Error permanen tidak boleh memutar host — biar chatCore yang ganti akun.
      for (const status of [400, 401, 403, 404]) {
        expect(exec.shouldRetry(status, 0)).toBe(false);
      }
    } finally {
      setAntigravityHostMode("all-hosts");
    }
  });

  it("registry tidak me-retry host yang kapasitasnya mati (500/503)", () => {
    // attempts: 0 -> langsung lompat ke host berikutnya, tanpa backoff
    // 2s+4s+8s di host yang toh tidak akan sembuh dalam hitungan detik.
    expect(antigravity.transport.retry["500"].attempts).toBe(0);
    expect(antigravity.transport.retry["503"].attempts).toBe(0);
  });

  it("registry me-retry 429 in-place karena limitnya pulih dalam milidetik", () => {
    // 429 burst Cloud Code: "quotaResetDelay": "162.322081ms" — terukur
    // 2026-09-20 pada burst 12x. Membuang request ke akun lain (yang juga
    // sedang burst) jauh lebih mahal daripada menunggu 162ms.
    expect(antigravity.transport.retry["429"].attempts).toBeGreaterThan(0);
  });

  it("membaca RetryInfo.retryDelay & quotaResetDelay dari error.details[]", () => {
    // Bentuk PERSIS dari upstream — pesan manusianya "Resets in 0s." yang
    // membulatkan 162ms menjadi nol detik, jadi angka aslinya wajib dibaca
    // dari field terstruktur.
    const real = {
      error: {
        code: 429,
        message: "You have exhausted your capacity on this model. Resets in 0s.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            metadata: { quotaResetDelay: "162.322081ms" } },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "0.162322081s" },
        ],
      },
    };
    expect(ag.parseRetryFromDetails(real)).toBe(163); // ceil dari 162.32
    // retryDelay menang (dicek lebih dulu) — 0.162322081s → 163ms
    expect(ag.parseRetryFromDetails({ error: { details: [
      { metadata: { quotaResetDelay: "5s" } },
      { retryDelay: "0.25s" },
    ] } })).toBe(250);
    // Tidak ada details → null (jatuh ke jalur lain).
    expect(ag.parseRetryFromDetails({ error: { message: "x" } })).toBeNull();
    expect(ag.parseRetryFromDetails(null)).toBeNull();
  });

  it("429 dengan resetAt panjang tetap di-veto (biar chatCore rotasi akun)", async () => {
    // Kuota mingguan habis → jangan retry in-place berulang kali.
    const r = res(429, {}, { error: { message: "You have exhausted your capacity. Resets in 149h50m20s." } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(false);
  });

  it("429 TANPA info delay → veto (jangan retry in-place)", async () => {
    // Regresi 2026-09-20: attempts:2 + 429 generik tanpa details[] membuat
    // 9 percobaan lintas 3 host = 48-64 detik pada payload besar (image +
    // 123 tool, ~7s per percobaan), naik dari ~12 detik.
    //
    // Prinsip: retry in-place HANYA bila upstream menyebut kapan harus retry.
    const generic = res(429, {}, {
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(await ag.computeRetryDelay(generic, 1)).toBe(false);
    expect(await ag.computeRetryDelay(generic, 2)).toBe(false);

    // 429 tanpa body sama sekali juga veto.
    expect(await ag.computeRetryDelay(res(429), 1)).toBe(false);
  });

  it("429 DENGAN RetryInfo tetap di-retry (bukan veto)", async () => {
    // Kebalikannya harus tetap jalan: burst 429 yang menyebut kapan pulih.
    const burst = res(429, {}, {
      error: {
        code: 429,
        message: "You have exhausted your capacity on this model. Resets in 0s.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.162322081s" },
        ],
      },
    });
    expect(await ag.computeRetryDelay(burst, 1)).toBe(163);  });

  it("buildHeaders matches official IDE stream headers", () => {
    ag._lastSessionId = "sess-123";
    const h = ag.buildHeaders({ accessToken: "tok" }, true);
    expect(h["User-Agent"]).toBe("antigravity/ide/2.22.0 darwin/arm64");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h).not.toHaveProperty("X-Machine-Session-Id");
    expect(h).not.toHaveProperty("x-request-source");
    expect(h).not.toHaveProperty("Accept");
  });

  it("transforms chat requests with official IDE requestId shape and 64000 token cap", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ text: "hello" }] },
        ],
        generationConfig: { maxOutputTokens: 90000 },
        sessionId: "-3750763034362895579",
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d{13}\/[0-9a-f-]{36}\/\d+$/);
    expect(out.request.generationConfig.maxOutputTokens).toBe(64000);
  });
});
