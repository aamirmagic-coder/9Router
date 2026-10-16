/**
 * Pivot claude→openai→antigravity harus mempertahankan image.
 *
 * Latar: fork menambahkan DIRECT route `claude:antigravity` (claude-to-antigravity.js)
 * karena pivot lama membuang image di dua tempat:
 *   1. image di dalam tool_result di-stringify jadi teks JSON
 *   2. envelope Claude tidak punya cabang IMAGE
 *
 * Perbaikan yang benar adalah memperbaiki PIVOT-nya, bukan menambah jalur
 * kedua. Test ini memverifikasi pivot sudah benar; setelah lulus, direct route
 * bisa dihapus sehingga hanya ada SATU jalur — sama seperti 9router ori.
 *
 * Test ini memanggil kedua tahap pivot secara eksplisit supaya tidak
 * bergantung pada ada/tidaknya direct route.
 */
import { describe, it, expect } from "vitest";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { OPENAI_BLOCK } from "../../open-sse/translator/schema/index.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MODEL = "claude-opus-4-6-thinking";
const CREDS = { projectId: "proj-1", connectionId: "conn-1", email: "a@b.c" };

/** Semua inlineData di dalam envelope Cloud Code. */
function collectInlineData(envelope) {
  const found = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.inlineData) found.push(n.inlineData);
    Object.values(n).forEach(walk);
  };
  walk(envelope);
  return found;
}

/** Semua functionResponse di dalam envelope. */
function collectFunctionResponses(envelope) {
  const found = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.functionResponse) found.push(n.functionResponse);
    Object.values(n).forEach(walk);
  };
  walk(envelope);
  return found;
}

describe("pivot claude→openai→antigravity mempertahankan image", () => {
  it("image di pesan user sampai sebagai inlineData", () => {
    const claude = {
      model: MODEL, max_tokens: 128,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "lihat ini" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
        ],
      }],
    };
    const openai = claudeToOpenAIRequest(MODEL, claude, true);
    const env = openaiToAntigravityRequest(MODEL, openai, true, CREDS);
    const inline = collectInlineData(env);
    expect(inline.length, "image user hilang di pivot").toBeGreaterThan(0);
    expect(inline[0].data).toBe(PNG_B64);
  });

  it("image di dalam tool_result TIDAK di-stringify jadi teks", () => {
    // Inilah bug yang membuat direct route dibuat. Kalau ini lulus, direct
    // route tidak diperlukan lagi.
    const claude = {
      model: MODEL, max_tokens: 128,
      messages: [
        { role: "user", content: [{ type: "text", text: "baca file" }] },
        {
          role: "assistant",
          content: [{
            type: "tool_use", id: "toolu_1", name: "read",
            input: { path: "gambar.png" },
          }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result", tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "File berhasil dibaca." },
              { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
            ],
          }],
        },
      ],
    };

    const openai = claudeToOpenAIRequest(MODEL, claude, true);
    const toolMsg = openai.messages.find((m) => m.role === "tool");
    expect(toolMsg, "pesan tool tidak terbentuk").toBeTruthy();
    // The OpenAI tool role is text-only, so the upstream translator lifts the
    // image out of tool_result into the user turn that follows, tagged with the
    // call it came from. The text half stays in the tool message.
    expect(toolMsg.content, "teks tool_result hilang").toContain("berhasil dibaca");
    const imageTurn = openai.messages.at(-1);
    expect(imageTurn.role, "image harus di pesan user setelah tool").toBe("user");
    expect(
      imageTurn.content.some((b) => b.type === "image_url" && b.image_url?.url?.includes(PNG_B64)),
      "image tool_result tidak diteruskan sebagai image_url di pesan user"
    ).toBe(true);

    const env = openaiToAntigravityRequest(MODEL, openai, true, CREDS);
    // The image must still reach Gemini as inlineData — that is the fix this
    // test exists to protect. It now arrives via the user turn rather than
    // functionResponse.parts.
    const inlineData = [];
    for (const c of env.request?.contents || []) {
      for (const p of c.parts || []) if (p.inlineData) inlineData.push(p.inlineData.data);
    }
    expect(inlineData, "image tidak sampai ke Gemini sebagai inlineData").toContain(PNG_B64);
    const fr = collectFunctionResponses(env);
    expect(fr.length, "functionResponse tidak terbentuk").toBeGreaterThan(0);
    // Teks tetap ada di result.
    expect(JSON.stringify(fr[0].response)).toContain("berhasil dibaca");
  });

  it("tanpa image tetap string (perilaku lama tidak berubah)", () => {
    const claude = {
      model: MODEL, max_tokens: 128,
      messages: [
        { role: "user", content: [{ type: "text", text: "baca" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "read", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "isi file" }] }],
        },
      ],
    };
    const openai = claudeToOpenAIRequest(MODEL, claude, true);
    const toolMsg = openai.messages.find((m) => m.role === "tool");
    expect(typeof toolMsg.content).toBe("string");
    expect(toolMsg.content).toBe("isi file");
  });
});
