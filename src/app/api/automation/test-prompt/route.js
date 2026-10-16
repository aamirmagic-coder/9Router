import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Kirim prompt nyata ke SATU akun, lewat gateway 9Router sendiri.
 *
 * ── Mengapa lewat gateway, bukan langsung ke upstream ───────────────────────
 *
 * Memanggil upstream langsung berarti menyalin header, format body, dan aturan
 * per-provider — persis duplikasi yang membuat enam skrip Python berbeda satu
 * sama lain. Lewat gateway, permintaan melewati jalur yang sama dengan trafik
 * sungguhan, termasuk refresh token, rotasi proxy, dan penerjemahan format.
 * Yang diuji jadi benar-benar "apakah akun ini bisa melayani request", bukan
 * "apakah saya bisa meniru caranya".
 *
 * `x-connection-id` memaksa satu akun tertentu (dipakai jalur image/video;
 * jalur chat baru menerimanya). Tanpa itu, permintaan dilayani akun mana pun
 * yang dipilih rotasi — dan hasilnya menjawab "provider ini punya akun sehat",
 * bukan "akun ini sehat".
 *
 * Akun yang gagal TIDAK menghentikan seluruh provider: handler chat tetap
 * fallback ke akun lain. Karena itu jawaban di sini menyebut akun mana yang
 * benar-benar melayani, dan itulah yang harus dibaca operator.
 */
export const POST = requireGate(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  const { connectionId, prompt, model, maxTokens = 200 } = body || {};
  if (!connectionId) {
    return NextResponse.json({ error: "Pilih akun dulu" }, { status: 400, headers: NO_STORE });
  }

  const conn = (await getProviderConnections({})).find((c) => c.id === connectionId);
  if (!conn) {
    return NextResponse.json({ error: "Akun tidak ditemukan" }, { status: 404, headers: NO_STORE });
  }

  // Kunci gateway. Ada satu di tabel apiKeys; ini kunci lokal milik pemasangan
  // ini sendiri, bukan kredensial pihak ketiga.
  const { getApiKeys } = await import("@/lib/localDb");
  const keys = await getApiKeys().catch(() => []);
  const apiKey = keys?.[0]?.key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Belum ada API key gateway. Buat di halaman Endpoint & Key." },
      { status: 400, headers: NO_STORE },
    );
  }

  const chosenModel = model || conn.defaultModel || conn.freebuffModel || null;
  const payload = {
    messages: [{ role: "user", content: prompt || "Balas dalam satu kalimat singkat: siapa kamu?" }],
    max_tokens: Math.max(16, Number(maxTokens) || 200),
    stream: false,
  };
  if (chosenModel) payload.model = chosenModel;

  const started = Date.now();
  try {
    const res = await fetch(`${new URL(request.url).origin}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // Memaksa akun ini. Kalau ia gagal, gateway tetap fallback ke akun lain
        // dan `servedBy` di bawah akan menunjukkan siapa yang benar-benar jalan.
        "x-connection-id": conn.id,
      },
      body: JSON.stringify(payload),
    });

    const elapsedMs = Date.now() - started;
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Bukan JSON: upstream mengirim sesuatu yang bukan jawaban chat.
    }

    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          status: res.status,
          elapsedMs,
          error: data?.error?.message || data?.error || text.slice(0, 300),
        },
        { headers: NO_STORE },
      );
    }

    const msg = data?.choices?.[0]?.message;
    const reply = msg?.content || msg?.reasoning_content || "";
    return NextResponse.json(
      {
        ok: true,
        status: res.status,
        elapsedMs,
        reply,
        // Model yang benar-benar dipakai upstream, bukan yang diminta.
        servedModel: data?.model || chosenModel || null,
        usage: data?.usage || null,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, elapsedMs: Date.now() - started, error: err.message || "Permintaan gagal" },
      { status: 500, headers: NO_STORE },
    );
  }
});
