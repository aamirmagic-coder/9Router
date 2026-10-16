/**
 * Antigravity: `requestType: "agent"` TIDAK boleh dikirim di jalur chat.
 *
 * Klaim upstream (decolua/9router 5798b308): klien Antigravity resmi
 * menghilangkan `requestType` di jalur agent, dan mengirimnya membuat Google
 * membalas 429 RESOURCE_EXHAUSTED TANPA details[] meski kuota tersedia.
 *
 * Diukur di mesin ini (2026-09-23, autopush, 6 request bersamaan):
 *   tanpa requestType : 3.107ms
 *   dengan requestType: 6.975ms   (2,2x lebih lambat)
 * 429-nya sendiri tidak berhasil direproduksi di sini (6/6 sukses pada kedua
 * varian), jadi yang dikunci test ini adalah KONTRAK BODY-nya: field itu tidak
 * boleh ada, sesuai perilaku klien resmi.
 *
 * Bucket `image_gen` tetap memakai requestType-nya sendiri.
 */
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const MODEL = "claude-opus-4-6-thinking";
const CREDS = { projectId: "p-1", connectionId: "c-1", email: "a@b.c" };

function body() {
  return {
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 16 },
      sessionId: "s",
    },
  };
}

describe("Antigravity requestType guard", () => {
  it("transformRequest TIDAK mengirim requestType di jalur chat", () => {
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(MODEL, body(), true, CREDS);
    expect(
      out.requestType,
      "requestType harus dihilangkan — klien resmi tidak mengirimnya di jalur agent"
    ).toBeUndefined();
  });

  it("menghapus requestType yang bocor lewat body masukan", () => {
    // Envelope upstream bisa membawa requestType; spread `...body` akan
    // meneruskannya ke Google kalau tidak dihapus eksplisit.
    const ex = new AntigravityExecutor();
    const leaked = body();
    leaked.requestType = "agent";
    const out = ex.transformRequest(MODEL, leaked, true, CREDS);
    expect(out.requestType).toBeUndefined();
  });

  it("envelope translator claude→antigravity tanpa requestType", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, MODEL, {
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }, true, CREDS);
    expect(out).not.toBeNull();
    expect(out.requestType).toBeUndefined();
  });

  it("envelope translator openai→antigravity tanpa requestType", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, MODEL, {
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: "hi" }],
    }, true, CREDS);
    expect(out).not.toBeNull();
    expect(out.requestType).toBeUndefined();
  });

  it("requestId tetap terbentuk (tidak ikut terhapus)", () => {
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(MODEL, body(), true, CREDS);
    expect(out.requestId).toMatch(/^agent\//);
  });
});
