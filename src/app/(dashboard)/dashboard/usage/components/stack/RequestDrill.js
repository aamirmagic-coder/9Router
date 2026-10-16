"use client";

import { useEffect, useState } from "react";
import { fmtTokenCount, fmtFull, fmtTime, fmtExact, fmtAgo } from "./format";

/**
 * RequestDrill — daftar request di dalam satu baris lapis.
 *
 * Ini ujung dari penelusuran: provider → model → request tunggal. Datanya dari
 * /api/usage/request-details yang memang menerima filter `provider`, `model`,
 * dan `startDate`, jadi penelusuran ini tidak butuh endpoint baru.
 *
 * Payload percakapan sudah diredaksi server (lihat route-nya) — yang tampil di
 * sini hanya metadata: waktu, status, token, biaya, dan latensi. Itu memang
 * yang dibutuhkan untuk menjawab "kenapa request ini gagal".
 */

const PAGE_SIZE = 25;

/**
 * Awal rentang untuk sebuah period — HARUS cocok dengan yang dipakai statistik.
 *
 * `period` diterjemahkan ulang di sini, tidak diimpor, karena `PERIOD_MS` hidup
 * di `@/lib/db/repos/usageRepo.js`: modul server (SQLite) yang tidak bisa
 * diimpor komponen klien. Duplikasi ini disengaja, dan alasannya bukan
 * kenyamanan — kalau pemetaannya menyimpang dari sana, daftar ini menampilkan
 * rentang yang BERBEDA dari total di atasnya, yaitu kelas bug yang sama dengan
 * "angka periode lama di bawah label periode baru" yang dijaga
 * tests/unit/usage-period-switch.test.js.
 *
 * `today` memakai TENGAH MALAM LOKAL, bukan UTC, supaya cocok dengan
 * `startOfDay.setHours(0,0,0,0)` di usageRepo. `all` tanpa batas.
 */
function periodStart(period) {
  const map = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };
  if (period === "today") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return startOfDay.toISOString();
  }
  const ms = map[period];
  if (!ms) return undefined; // "all" (atau period tak dikenal): tanpa batas
  return new Date(Date.now() - ms).toISOString();
}

/**
 * Token dari sebuah baris detail.
 *
 * Bentuk yang tersimpan adalah `{ input_tokens, output_tokens }` — BUKAN
 * `promptTokens`/`completionTokens` seperti yang sempat dibaca berkas ini,
 * sehingga kolom Tokens selalu mencetak "0": angka salah yang tampak seperti
 * jawaban sah, tepat di kolom yang paling dipakai untuk membandingkan request.
 *
 * Idiom `prompt_tokens || input_tokens` disalin dari `RequestDetailsTab.js`
 * (tab Details), yang sudah memakainya — termasuk alasan cadangan cache di
 * bawah. Dua tempat membaca bentuk data yang sama; kalau salah satu berubah,
 * yang lain harus ikut.
 */
function bacaToken(d) {
  const t = d?.tokens || {};
  const prompt = t.prompt_tokens || t.input_tokens || 0;
  // Baris Claude lama menyimpan prompt TANPA cache; baris kanonik menyimpannya
  // sudah termasuk cache. Pakai yang lebih besar supaya baris lama tidak
  // melaporkan input lebih kecil dari kenyataan.
  const cache = t.cached_tokens || t.cache_read_input_tokens || 0;
  const input = prompt < cache ? cache : prompt;
  const output = t.completion_tokens || t.output_tokens || 0;
  return input + output;
}

export default function RequestDrill({ provider, model, period }) {
  // Halaman disimpan bersama SASARANNYA: `{ key, page }`. Saat sasaran berubah,
  // halaman dari sasaran lama otomatis diabaikan — tanpa effect yang harus
  // meresetnya, dan tanpa satu render ekstra yang menampilkan halaman 3 dari
  // daftar yang hanya punya 1 halaman.
  //
  // `period` ikut masuk kunci: rentang yang lebih pendek hampir selalu punya
  // halaman lebih sedikit, dan mempertahankan nomor halaman melintasi
  // pergantian periode akan mendaratkan operator di halaman yang tidak ada.
  const key = `${provider || ""}::${model || ""}::${period || ""}`;
  const [paging, setPaging] = useState({ key, page: 1 });
  const page = paging.key === key ? paging.page : 1;
  const setPage = (updater) =>
    setPaging((prev) => {
      const cur = prev.key === key ? prev.page : 1;
      return { key, page: typeof updater === "function" ? updater(cur) : updater };
    });

  const [state, setState] = useState({ status: "loading", details: [], pagination: null });

  useEffect(() => {
    const ac = new AbortController();
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (provider) params.set("provider", provider);
    if (model) params.set("model", model);
    // Tanpa ini, daftar menampilkan 25 request TERAKHIR apa pun periode yang
    // dipilih — sementara pesan kosongnya menjanjikan "in the selected period",
    // dan baris di atasnya melaporkan jumlah request untuk periode itu.
    // Terukur sebelum perbaikan: period "today" menampilkan request "52d" lalu.
    const start = periodStart(period);
    if (start) params.set("startDate", start);

    fetch(`/api/usage/request-details?${params.toString()}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        setState({
          status: "ready",
          details: data?.details || [],
          pagination: data?.pagination || null,
        });
      })
      .catch((e) => {
        if (e?.name !== "AbortError") {
          setState({ status: "error", details: [], pagination: null });
        }
      });

    return () => ac.abort();
  }, [provider, model, page, period]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-1.5 py-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded-lg bg-border-subtle/60" />
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p className="px-2 py-3 text-xs text-text-muted">
        Could not load requests for this row.
      </p>
    );
  }

  if (state.details.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-text-muted">
        No individual requests recorded for this row in the selected period.
      </p>
    );
  }

  const { pagination } = state;
  const totalPages = pagination?.totalPages || 1;

  return (
    <div className="flex min-w-0 flex-col">
      {/* Daftar request. Tinggi dibatasi supaya membuka satu baris tidak
          mendorong sisa halaman jauh ke bawah. */}
      <div className="max-h-80 min-w-0 overflow-y-auto rounded-lg border border-border-subtle">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">
            Individual requests {provider ? `for ${provider}` : ""} {model ? `on ${model}` : ""}
          </caption>
          <thead className="sticky top-0 z-10 bg-bg-subtle text-[10px] uppercase tracking-wide text-text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">When</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Tokens</th>
              {/* Kolom Cost DIHAPUS, bukan dibiarkan kosong. Baris request
                  TIDAK menyimpan biaya sama sekali: `buildRequestDetail`
                  (open-sse/handlers/chatCore/requestDetail.js) tidak punya
                  field `cost`, dan terukur 0 dari 1.000 baris di database
                  memilikinya. Kolom yang selalu "—" bukan informasi kurang,
                  ia ruang yang menuntut perhatian untuk memberi tahu bahwa
                  tidak ada apa-apa. Latensi menggantikannya: field itu ADA di
                  1.000/1.000 baris, dan "kenapa request ini lambat" adalah
                  pertanyaan yang sama seringnya dengan "kenapa gagal".
                  Biaya per request tetap bisa dibaca di tab Details. */}
              <th scope="col" className="px-3 py-2 text-right font-medium">Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {state.details.map((d, i) => {
              const ok = !d.status || d.status === "success" || d.status === 200;
              const tokens = bacaToken(d);
              const ms = d.latency?.total || 0;
              return (
                <tr
                  key={d.id ?? `${d.timestamp}-${i}`}
                  className="transition-colors hover:bg-bg-hover"
                >
                  <td className="whitespace-nowrap px-3 py-2 text-text-muted">
                    <time
                      dateTime={d.timestamp}
                      title={`${fmtExact(d.timestamp)} — ${fmtAgo(d.timestamp)}`}
                    >
                      {fmtTime(d.timestamp)}
                    </time>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="inline-flex items-center gap-1.5"
                      title={d.errorMessage || d.error || undefined}
                    >
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: ok ? "var(--color-success)" : "var(--color-danger)",
                        }}
                        aria-hidden="true"
                      />
                      <span className={ok ? "text-text-muted" : "text-danger"}>
                        {ok ? "ok" : d.status || "error"}
                      </span>
                    </span>
                  </td>
                  {/* Angka penuh, bukan "1.2K". Aturan halaman ini adalah tidak
                      ada singkatan; drill-down justru tempat operator paling
                      butuh angka persisnya untuk membandingkan dua request.
                      Lebar kolom dijaga `tabular-nums` + `whitespace-nowrap`,
                      jadi angka panjang tidak menggeser tata letak. */}
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-text-muted">
                    {tokens ? fmtTokenCount(tokens) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-muted">
                    {/* Angka penuh seperti kolom Tokens. `fmtCount` menyingkat
                        ("27K"), dan singkatan dilarang di halaman ini — sama
                        persis dengan alasan kolom Tokens tidak memakai
                        `fmtTokens`. Satuan ms ikut ditulis supaya tidak
                        tertukar dengan token. */}
                    {ms ? `${fmtFull(ms)} ms` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <div className="mt-2 flex items-center justify-between text-xs text-text-muted">
          <span className="tabular-nums">
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md px-2 py-1 font-medium transition-colors hover:bg-bg-hover hover:text-text-main disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded-md px-2 py-1 font-medium transition-colors hover:bg-bg-hover hover:text-text-main disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
