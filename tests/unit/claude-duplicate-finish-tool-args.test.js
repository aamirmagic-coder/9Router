/**
 * Bug: `openai-to-claude` memproses blok finish lebih dari sekali.
 *
 * Beberapa upstream (terbukti: cline-free/muse-spark-1.3-contributor) mengirim
 * DUA chunk Chat Completion yang sama-sama membawa `finish_reason`. Blok finish
 * di translator tidak punya penjaga sekali-jalan, jadi untuk setiap chunk:
 *   - `state.toolArgBuffers` dibaca ulang (isinya tidak pernah dibersihkan)
 *   - `input_json_delta` dikirim ULANG dengan argumen yang sama
 *   - `content_block_stop` dikirim ULANG
 *
 * Klien lalu menyusun `{"pattern":"**\/*.cs"}{"pattern":"**\/*.cs"}` — JSON tak
 * valid → `InputValidationError: ... could not be parsed as JSON`.
 *
 * Terlihat di sesi nyata: 451 error "required parameter `command` is missing"
 * pada muse-spark (input jadi {} karena konsumen membuang JSON rusak).
 */
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const ARGS = '{"pattern":"**/*.cs"}';

function chunkWithFinish(id, name) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "muse-spark-1.3-contributor",
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] },
      finish_reason: "tool_calls",
    }],
  };
}

function argsOnly() {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "muse-spark-1.3-contributor",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ARGS } }] }, finish_reason: null }],
  };
}

// Stream nyata membuka blok tool lebih dulu (id + nama), baru mengirim argumen.
function toolStart(id, name) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "muse-spark-1.3-contributor",
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] },
      finish_reason: null,
    }],
  };
}

function feed(chunks, label) {
  const state = initState(FORMATS.CLAUDE);
  const out = [];
  for (const c of chunks) {
    const res = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, c, state);
    for (const r of res || []) out.push(r);
  }
  const deltas = out.filter((o) => o?.delta?.type === "input_json_delta");
  const stops = out.filter((o) => o?.type === "content_block_stop");
  const joined = deltas.map((d) => d.delta.partial_json).join("");
  console.log(`\n### ${label}`);
  console.log(`    input_json_delta : ${deltas.length} -> ${JSON.stringify(joined)}`);
  console.log(`    content_block_stop: ${stops.length}`);
  return { out, deltas, stops, joined };
}

describe("finish_reason ganda tidak boleh menggandakan argumen tool", () => {
  it("satu finish_reason: argumen utuh sekali, satu stop", () => {
    const { deltas, stops, joined } = feed(
      [toolStart("call_1", "Glob"), argsOnly(), chunkWithFinish("call_1", "Glob")],
      "normal (1 finish)",
    );
    expect(deltas.length).toBe(1);
    expect(stops.length).toBe(1);
    expect(() => JSON.parse(joined)).not.toThrow();
    expect(JSON.parse(joined)).toEqual({ pattern: "**/*.cs" });
  });

  // Bentuk upstream sebenarnya: argumen datang SEBELUM chunk finish pertama
  // (delta -> finish+usage). Yang salah adalah chunk finish KEDUA.
  it("dua finish_reason: tetap satu delta dan satu stop", () => {
    const { deltas, stops, joined } = feed(
      [
        toolStart("call_1", "Glob"),
        argsOnly(),
        chunkWithFinish("call_1", "Glob"),
        // chunk terminal kedua dengan finish_reason yang sama — inilah pemicunya
        chunkWithFinish("call_1", "Glob"),
      ],
      "finish ganda (kasus cline-free)",
    );
    expect(deltas.length).toBe(1);
    expect(stops.length).toBe(1);
    expect(() => JSON.parse(joined)).not.toThrow();
    expect(JSON.parse(joined)).toEqual({ pattern: "**/*.cs" });
  });

  it("tiga finish_reason: tetap satu delta dan satu stop", () => {
    const { deltas, stops, joined } = feed(
      [
        toolStart("call_1", "Glob"),
        argsOnly(),
        chunkWithFinish("call_1", "Glob"),
        chunkWithFinish("call_1", "Glob"),
        chunkWithFinish("call_1", "Glob"),
      ],
      "finish tiga kali",
    );
    expect(deltas.length).toBe(1);
    expect(stops.length).toBe(1);
    expect(() => JSON.parse(joined)).not.toThrow();
    expect(JSON.parse(joined)).toEqual({ pattern: "**/*.cs" });
  });
});
