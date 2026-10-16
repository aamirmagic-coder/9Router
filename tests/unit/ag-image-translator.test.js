/**
 * UJI TRANSLATOR — bukan probe jaringan.
 *
 * Keluhan: "versi ORI (9router 0.5.75) berhasil, fork (9router-imagefix)
 * GAGAL saat upload image ke model Antigravity."
 *
 * Fork menambahkan DIRECT route `claude:antigravity` (claude-to-antigravity.js)
 * yang melewati jalur claude→openai→gemini. Direct route itu menulis
 * `inlineData.mimeType` (camelCase), sedangkan sisa codebase membaca
 * `mime_type`. Test ini memeriksa APA YANG SEBENARNYA DIKIRIM ke Google.
 */
import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function claudeBodyWithImage() {
  return {
    model: "claude-opus-4-6-thinking",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Apa isi gambar ini?" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: PNG_B64 },
          },
        ],
      },
    ],
  };
}

const CREDS = { projectId: "proj-1", connectionId: "conn-1", email: "a@b.c" };

/** Kumpulkan semua part inlineData dari envelope Cloud Code. */
function collectInlineData(envelope) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.inlineData) found.push(node.inlineData);
    Object.values(node).forEach(walk);
  };
  walk(envelope);
  return found;
}

describe("translator claude→antigravity dengan image", () => {
  it("GAMBAR SAMPAI ke envelope (tidak di-drop)", () => {
    const out = translateRequest(
      FORMATS.CLAUDE, FORMATS.ANTIGRAVITY,
      "claude-opus-4-6-thinking", claudeBodyWithImage(), true, CREDS
    );
    expect(out, "translateRequest mengembalikan null").not.toBeNull();

    const inline = collectInlineData(out);
    expect(
      inline.length,
      "GAMBAR HILANG — tidak ada inlineData di envelope. Ini regresi: model tidak akan pernah melihat gambarnya."
    ).toBeGreaterThan(0);
  });

  it("nama field mime TUNGGAL (mimeType, konsisten satu codebase)", () => {
    const out = translateRequest(
      FORMATS.CLAUDE, FORMATS.ANTIGRAVITY,
      "claude-opus-4-6-thinking", claudeBodyWithImage(), true, CREDS
    );
    const inline = collectInlineData(out);
    expect(inline.length).toBeGreaterThan(0);

    const first = inline[0];
    // Terukur 2026-09-20: Google menerima mime_type MAUPUN mimeType — keduanya
    // HTTP 200 dan model membaca isi gambar. Jadi yang penting bukan bentuk
    // mana, melainkan HANYA SATU bentuk di seluruh codebase.
    //
    // Dipilih camelCase karena convertOpenAIContentToParts (jalur utama semua
    // provider Gemini) sudah memakainya, dan Antigravity API sendiri camelCase.
    expect(
      Object.keys(first),
      `inlineData memakai field tak terduga: ${JSON.stringify(Object.keys(first))}`
    ).toContain("mimeType");
    expect(first.mimeType).toBe("image/png");
    expect(first.data).toBe(PNG_B64);
    // Tidak boleh ada campuran dua bentuk.
    expect(JSON.stringify(out)).not.toContain("mime_type");
  });

  it("data gambar tidak diubah/dipotong", () => {
    const out = translateRequest(
      FORMATS.CLAUDE, FORMATS.ANTIGRAVITY,
      "claude-opus-4-6-thinking", claudeBodyWithImage(), true, CREDS
    );
    const inline = collectInlineData(out);
    expect(inline[0]?.data?.length).toBe(PNG_B64.length);
  });
});
