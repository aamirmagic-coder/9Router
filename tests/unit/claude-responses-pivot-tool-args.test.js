/**
 * Regresi: pivot claude -> openai-responses -> claude kehilangan argumen tool.
 *
 * Akar masalah (terverifikasi): `stream.js` membuat SATU objek state untuk kedua
 * hop pivot. Hop-1 (`openai-responses.js`) menulis `state.finishReason` saat
 * memproses `response.completed`; penjaga finish di hop-2
 * (`openai-to-claude.js`, commit 53e20b86) berbunyi `!state.finishReason`,
 * sehingga blok finish hop-2 — satu-satunya tempat argumen tool di-flush —
 * di-skip total. Klien menerima `tool_use` dengan `input:{}` tanpa
 * `input_json_delta` sama sekali ("Bash kosong").
 *
 * Urutan event di bawah persis seperti tangkapan langsung api.meta.ai.
 * Tes ini GAGAL pada build 53e20b86 dan LULUS pada b062185b (penjaga per-tool).
 */
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const ARGS = '{"command":"ls -R"}';

const META_EVENTS = [
  { type: "response.created", response: { id: "resp_1", created_at: 1, status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: ARGS },
  { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: ARGS },
  { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: ARGS } },
  { type: "response.completed", response: { id: "resp_1", created_at: 1, status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
];

function runPivot(events) {
  const state = { ...initState(FORMATS.CLAUDE), targetFormat: FORMATS.OPENAI_RESPONSES };
  const emitted = [];
  for (const ev of events) {
    const out = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state);
    for (const item of out || []) if (item != null) emitted.push(item);
  }
  const flushed = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, state);
  for (const item of flushed || []) if (item != null) emitted.push(item);
  return emitted;
}

describe("pivot claude -> openai-responses -> claude (mc/muse-spark)", () => {
  it("mengirim argumen tool lewat input_json_delta, bukan tool_use kosong", () => {
    const emitted = runPivot(META_EVENTS);
    const deltas = emitted.filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta");
    expect(deltas.map((d) => d.delta.partial_json)).toEqual([ARGS]);

    const starts = emitted.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(starts).toHaveLength(1);
    expect(starts[0].content_block.name).toBe("Bash");

    // Terminal harus ada supaya klien menutup pesan dengan benar.
    expect(emitted.some((e) => e.type === "content_block_stop")).toBe(true);
    expect(emitted.some((e) => e.type === "message_delta")).toBe(true);
    expect(emitted.some((e) => e.type === "message_stop")).toBe(true);
  });
});
