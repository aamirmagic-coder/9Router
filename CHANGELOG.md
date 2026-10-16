# Changelog

# v0.5.143 (2026-10-16) — 9router-imagefix

## Fix: CodeBuddy International ditolak HTTP 400 / code 11128

Gejala di klien: `API Error: 400 [400]: {"code":11128,"msg":"request illegal",
"displayMsg":{"en":"Request blocked. Please send it again"},
"displayTips":{"en":"This call failed channel verification, possibly because it
was not sent from an official client."}}`.

Gateway CodeBuddy menjalankan pemeriksaan kanal pada setiap request. Panggilan
yang terlihat bukan dari klien resmi ditolak. Klien resmi (ekstensi VS Code)
mengirim keluarga header identitas; 9router hanya mengirim auth, jadi ditolak.

**Menambahkan X-Conversation-Request-ID saja TIDAK cukup** — header yang benar
benar hilang adalah **X-Conversation-ID**, yang berbeda dari ID turn. Terukur:
setelah tujuh header turn/message/tracing ditambahkan, error tetap sama; baru
setelah `X-Conversation-ID` ditambahkan request diterima.

### Delapan header yang ditambahkan

| Header | Perilaku |
|---|---|
| `X-Conversation-ID` | **STABIL** selama percakapan. Gateway memakainya untuk affinity routing + prefix-cache reuse, jadi tidak boleh berubah per turn/retry |
| `X-Conversation-Request-ID` | Satu per TURN (aggregation key). Tetap saat retry/fallback akun |
| `X-Conversation-Message-ID` | Baru setiap request outbound, termasuk retry |
| `X-Root-Request-ID` | Sama dengan Request-ID |
| `X-Trace-ID` | Passthrough inbound, fallback ke Request-ID |
| `X-B3-TraceId` | 32 hex. Passthrough inbound valid (16/32 hex, bukan all-zero), selain itu acak. Stabil dalam turn |
| `X-B3-SpanId` | 16 hex, baru setiap request outbound |
| `X-B3-Sampled` | Inbound `"0"` dipertahankan, selain itu `"1"` |

### Implementasi

- `open-sse/utils/buddyRequestContext.js` (baru) — `createTurn`, `run`,
  `addHeaders`, `isBuddyProvider`. Konteks disimpan di **AsyncLocalStorage**,
  bukan field executor: request paralel berbagi satu objek executor, jadi state
  instance akan menukar ID antar sesi.
- `open-sse/executors/base.js` — `execute()` jadi wrapper: satu turn per
  pemanggilan untuk provider buddy, lalu lanjut ke `_executeWithIdentity()`.
  Turn bertahan di seluruh retry/fallback.
- `open-sse/executors/default.js` — `addHeaders()` dipanggil paling akhir di
  `buildHeaders`, setelah auth/proxy/registry, sehingga tidak ada yang tertimpa.
- Berlaku untuk `codebuddy-intl` DAN `codebuddy-cn` (WorkBuddy).

Conversation ID: prioritaskan inbound `X-Conversation-ID`, lalu resolver sesi
existing `resolveSessionIdentity()` (client session → hash teks asisten →
workspace → per-connection). Fallback per-connection **bukan** benar-benar
conversation-scoped (dua sesi pada satu akun berbagi ID) — diterima karena
gateway hanya butuh ID stabil, dan `connectionId` tetap akun-scoped sehingga
tidak bocor antar akun.

### Verifikasi

- `tests/unit/buddy-request-context.test.js` — 8/8 lulus: bentuk kedelapan
  header, konversasi stabil vs message/span berubah, passthrough inbound,
  B3 all-zero ditolak, tanpa duplikasi kapitalisasi, 8 turn paralel tidak
  bertukar ID, auth tidak tersentuh.
- Live pada server build sendiri (port uji), HTTP 200 + `finish_reason: stop`:
  `codebuddy-intl/claude-opus-4.7-1m` ("OK"), `codebuddy-intl/kimi-k2.7` ("OK."),
  `codebuddy-cn/glm-5.3` ("OK").
- Dua request berurutan dengan `X-Conversation-ID` yang sama: keduanya 200.
- Tanpa regresi: `ag/claude-sonnet-4-6`, `ag/gemini-3.8-flash-high`,
  `oc/deepseek-v4.1-flash-free`, `mc/muse-spark-1.3-contributor` semua 200.

# v0.5.141 (2026-10-05) — 9router-imagefix

## Model baru: Claude Sonnet 5.5 & Opus 5.5 di Antigravity

Port dari PR upstream #4566 (lmortezal). Antigravity mengekspos tiap family
dalam 4 tier thinking (`base`, `low`, `medium`, `high`):

```
claude-sonnet-5-5  claude-sonnet-5-5-low  claude-sonnet-5-5-medium  claude-sonnet-5-5-high
claude-opus-5-5    claude-opus-5-5-low    claude-opus-5-5-medium    claude-opus-5-5-high
```

Suffix `(level)` pada `upstreamModelId` adalah override thinking 9router —
diselesaikan ke request lalu dilepas lagi sebelum panggilan Google Cloud Code.

### File yang diubah

| File | Isi |
|---|---|
| `open-sse/providers/registry/antigravity.js` | 8 entri model + `upstreamModelId` |
| `open-sse/providers/capabilities.js` | 10 entri (Sonnet 5.5 termasuk `thinkingOffType: between_tools` + `forcedToolChoice: false`) |
| `open-sse/providers/pricing.js` | 10 entri (Sonnet $2/$10, Opus $5/$25) |
| `src/mitm/config.js` | sinonim titik/strip + 8 pola regex, diurutkan SEBELUM fallback 4.6 |
| `src/shared/constants/cliTools.js` | `modelAliases` + `defaultModels` |
| `open-sse/services/usage/google.js` | `importantModels` untuk pelacakan kuota |
| `cli/src/cli/menus/providers.js` | menu CLI interaktif |

Pola regex 5.5 wajib berada di atas `/opus/i` dan `/sonnet|claude/i` — kalau
tidak, permintaan 5.5 akan diam-diam dirutekan ke model 4.6.

### ⚠️ Belum bisa dipakai tanpa langganan Pro berbayar

Model 5.5 **hanya untuk Google AI Pro non-trial**. Pro hasil trial/student/promo
tidak mendapatkannya — ini keputusan Google, bukan batasan kode.

Diverifikasi langsung ke `v1internal:fetchAvailableModels` pada dua akun di mesin
pengembang: keduanya hanya menerima `claude-opus-4-6-thinking` dan
`claude-sonnet-4-6`. Memanggil model 5.5 menghasilkan
`404 Requested entity was not found` — bukan error kode.

Pembanding yang membuktikan akun & koneksi sehat: `ag/claude-sonnet-4-6`
dan `ag/claude-opus-4-6-thinking` menjawab normal (~2 detik). Model lama
`ag/gemini-3.6-flash` juga 404 pada akun yang sama, jadi 404 bukan efek
perubahan ini.

Catatan jangka waktu: Sonnet 4.6 & Opus 4.6 **dihapus 2 Nov 2026** menurut
dokumentasi Google, sehingga 5.5 menjadi satu-satunya jalur Claude di Antigravity
setelah tanggal itu.

### Verifikasi

- `tests/unit/antigravity-claude-5-5.test.js` — 7/7 lulus (registry, upstream id
  + strip thinking, capabilities, pricing, MITM alias/sinonim/pola).
- Suite penuh: 1776 tes, 125 gagal — himpunan nama **identik** sebelum & sesudah
  perubahan (0 regresi).

# v0.5.139 (2026-10-03) — 9router-imagefix

## Fix: argumen tool call muse-spark rusak (JSON dobel)

Gejala di Claude Code: `InputValidationError: Bash was called with input that
could not be parsed as JSON`, dan varian `required parameter 'command' is
missing` ketika payload rusak dibuang menjadi `{}`. Terukur pada sesi nyata:
**451 error**, dan **80,8% tool_use muse-spark tanpa input** (506 dari 626),
sementara model yang sama lewat provider lain 0%.

Akar masalah: beberapa upstream mengirim `finish_reason` di **lebih dari satu**
chunk. Terbukti pada cline-free/muse-spark-1.3-contributor — stream berisi
delta argumen, chunk terminal ber-usage, lalu chunk terminal **kedua** dengan
finish_reason sama.

Blok finish di `openai-to-claude.js` tidak punya penjaga, dan
`state.toolArgBuffers` tidak pernah dibersihkan. Setiap lintasan membaca ulang
buffer dan mengirim `input_json_delta` yang sama lagi, sehingga klien menyusun
`{"pattern":"**/*.cs"}{"pattern":"**/*.cs"}` — JSON tidak valid.

Perbaikan **pertama** memakai `state.finishReason` sebagai penanda sekali-jalan
untuk seluruh blok. Itu menyembuhkan cline-free, tetapi **merusak** provider yang
mengirim argumen pada chunk finish yang lebih akhir: `mc/muse-spark` mengirim
finish_reason pada chunk KOSONG lebih dulu, lalu argumen menyusul di chunk
berikutnya. Penjaga global menutup blok terlalu dini sehingga argumen tidak
pernah terkirim.

Terbukti dengan membandingkan dua build pada request identik:
```
20128 (tanpa penjaga)  -> text stop tool_start ARG stop END   (benar)
21888 (dengan penjaga) -> text stop tool_start                (argumen hilang)
```

Perbaikan final memindahkan penjaga ke tingkat **per-tool**:
`state.emittedToolArgs` mencegah argumen tool yang sama dikirim dua kali, dan
`state.stoppedToolBlocks` memastikan tepat satu `content_block_stop` per blok.
Finish yang berulang tetap memproses tool yang belum mengirim argumen.

Dua pola yang sama-sama nyata di lapangan kini tertangani:
```
A. args SEBELUM finish, finish diulang (cline-free) -> 1 delta, 1 stop
B. args PADA finish kedua (mc)                      -> 1 delta berisi argumen
```

Uji langsung ke provider (server uji 21999):
```
mc/muse-spark-1.3-contributor            3/3 OK   (sebelumnya 3/3 kosong)
mc/muse-spark-1.3-contributor(none)      3/3 OK   (sebelumnya 3/3 kosong)
cl/cline-free/muse-spark-1.3-contributor 3/3 OK
oc/muse-spark-1.3-contributor-free       2/3 OK   (sisa isu terpisah)
```

## Fix: suffix `(none)` pada muse-spark menghasilkan HTTP 400

Memilih `mc/muse-spark-1.3-contributor(none)` ditolak Meta:

    reasoning_effort 'none' is not supported for model 'muse-spark-1.3-contributor'.
    Supported values: [minimal, low, medium, high, xhigh, max]

Capability muse-spark tidak menyetel `thinkingCanDisable`, jadi bernilai `true`
lewat default dan thinkingUnified mengirim `"none"` apa adanya.

Menandai `thinkingCanDisable: false` membuat `none` di-clamp ke `minimal` —
mekanisme yang sudah ada dan dipakai kimi/glm/minimax. Diterapkan di entri model
eksplisit dan pola `*muse*spark*`.

## Catatan pengukuran: level reasoning bukan tuas percepatan

Diuji semua level pada konteks ~31K token lewat 9router. Hasilnya **tidak
stabil** antar putaran — variasi antrean Meta lebih besar daripada pengaruh
level:

| Level | Putaran 1 | Putaran 2 | Putaran 3 |
|---|---|---|---|
| low | 2,81s | 5,22s | 4,98s |
| medium | 4,18s | 4,05s | 6,26s |
| high | 3,18s | 3,58s | 4,08s |
| xhigh | 4,21s | 3,70s | 4,06s |

`(xhigh)` paling konsisten (3,7-4,2 dtk) dan **tidak lebih lambat** dari level
lain, jadi tidak ada alasan turun level demi kecepatan.

Overhead 9router sendiri terukur **0-0,5 dtk** dan **tidak membesar** seiring
konteks — kelambatan yang dirasakan berasal dari hulu Meta, bukan dari routing.

# v0.5.138 (2026-10-03) — 9router-imagefix

## Fix: provider `muse` (Meta Model API) menolak semua permintaan dengan 400

Gejala: `/dashboard/providers/muse` menampilkan `HTTP 400: unknown parameter
'input'` di bawah "Available Models", dan setiap permintaan ke model muse
gagal — termasuk `muse-spark-1.3-contributor`.

Penyebabnya body dan URL tidak sepakat soal format. Semua model `muse`
di-pin ke `targetFormat: "openai-responses"`, tetapi `transport.baseUrl`
menunjuk `/v1/chat/completions`. Guard per-model di `chatCore.js`
menolak transport yang cocok `sourceFormat` ketika model hanya
mendeklarasikan `openai-responses`, sehingga `modelTargetFormat` menang:
body diterjemahkan ke bentuk Responses (`input[]`) lalu dikirim ke URL chat.

Direproduksi langsung ke `api.meta.ai`:

| Uji | Hasil |
|---|---|
| `/v1/responses` + body Responses | 200 |
| `/v1/chat/completions` + body Responses | 400 `unknown parameter 'input'` |
| `/v1/responses` + `max_tokens` | 400 `unknown parameter 'max_tokens'` |
| `/v1/responses` + `reasoning_effort` top-level | 400 |
| `/v1/responses` + `reasoning.effort` | 200 |

Perbaikan menyamakan `muse` dengan `meta-code` yang sudah bekerja:
`baseUrl` -> `/v1/responses`, `format` -> `openai-responses`,
`forceStream: true`, dan `quirks.foldReasoningEffort`.

Terverifikasi lewat server hasil build:
non-stream -> 200 `"ok"`; stream + tools -> 200 dengan `tool_calls` terisi
dan `finish_reason: "tool_calls"`. Jadi muse-spark kini juga bisa dipakai
dari klien coding yang memakai tool calling.

Catatan: `muse-ai` (agen personal, sidecar Python) tidak terpengaruh —
provider itu terpisah dan sudah benar sejak awal.

## Fix: `muse-bridge` mengembalikan HTTP 500 kosong saat soket gateway mati

`curl_cffi` melempar `CurlError` yang **bukan** subclass `OSError`, sehingga
handler `(GatewayError, TimeoutError, OSError)` melewatkannya dan FastAPI
mengembalikan 500 tanpa pesan. Semua I/O jaringan kini dibungkus
`TransportError`; transport mati = reconnect, bukan 500.

# v0.5.132 (2026-10-02) — 9router-imagefix

## Provider baru: `muse-ai` (agen personal muse.ai)

Agen personal muse.ai (feed/goals/ideas) kini bisa dipakai dari 9router.
Berbeda dari provider `muse` yang sudah ada — itu Meta Model API (Muse Spark,
per token); ini agen personalnya.

### Kenapa lewat sidecar Python
Edge muse.ai hanya menerima TLS handshake yang menyerupai browser. Handshake
Noise XX-nya sudah diport ke Node dan **cocok byte-per-byte** dengan referensi,
tapi gateway tetap menutup koneksi ~220 ms setelah handshake. Yang membuat
handshake identik berhasil hanya sidik jari TLS Chrome — dan Node tidak bisa
memberikannya tanpa native addon. Jadi transport-nya ada di `muse-bridge/`
(Python + curl_cffi), yang bicara OpenAI biasa di 127.0.0.1:18611.

### Isi
- `muse-bridge/` — server FastAPI (OpenAI-compatible), klien protokol Noise XX +
  protobuf, README, contoh config. Bind 127.0.0.1 saja.
- `open-sse/providers/registry/muse-ai.js` — provider, id unik (`muse-ai`, bukan
  `muse`) supaya tidak bentrok dengan Meta Model API.
- `open-sse/providers/capabilities.js` — `tools: false` untuk semua alias.
  Agen ini tidak punya function calling; tanpa ini dashboard dan `/v1/models`
  menjanjikan kemampuan yang tidak ada.
- `tests/unit/muse-ai-bridge-live.test.js` — 5 tes registrasi selalu jalan;
  1 tes giliran langsung di balik `MUSE_BRIDGE_LIVE=1`.

### Batasan (jujur)
Chat saja. Tanpa tool calling, tanpa vision, tanpa reasoning terpisah —
jadi **bukan** pengganti model coding; pakai `meta-code` untuk itu.
Angka contextWindow/maxOutput di model list adalah placeholder; muse.ai tidak
mempublikasikan angkanya.

### Catatan keamanan
`_muse-re/` dan `_muse-cli-check/` (berisi cookies sesi muse.ai) ditambahkan ke
`.gitignore`; `muse-bridge/` punya `.gitignore` sendiri untuk `cookies.txt`.

# v0.5.131 (2026-10-02) — 9router-imagefix

## Sync upstream v0.5.95 (a99cf572)

Seluruh fitur dan fix decolua/9router v0.5.95 diadopsi. Kustomisasi fork tetap utuh.

### Features
- **Provider**: Meta Muse (OAuth + katalog model), v1m System One, atria, dahl,
  bai, tokenharbor, opencode-zen, qoder-cn — registry jadi 131 provider.
- **GLM**: login Z.ai OAuth (dual-auth) di GLM Coding.
- **Codex**: GPT-6.1 Sol, varian konteks 1M untuk GPT-6 dan GPT-5.6,
  `gpt-daybreak-blue-latest`, `gpt-reserve`, dan routing slug telanjang
  `gpt-5.x`/`gpt-6.x` ke codex.
- **Claude**: Sonnet 5.5, plus `claude-opus-5.5` di registry Kiro.
- **CLI**: perintah `connect` untuk server 9Router jarak jauh.
- **Provider**: override header kustom per-provider dari registry.
- **Agnes**: seed model 2.5/3.0.
- **Usage**: parameter URL `?provider=` tersinkron dengan filter provider
  (deep link bisa di-bookmark).
- **Dashboard**: badge NEW dihapus, 9Remote ditandai HOT.

### Fixes
- **Claude**: prefill dari format non-`messages[]` dipertahankan; trailing user
  turn dijaga supaya pembersihan tidak menghasilkan assistant prefill; tool
  result akhir satu loop di-cache dengan breakpoint ke-4; Sonnet 5.x memakai
  adaptive thinking tanpa placeholder palsu; blok `container_upload` dijaga.
- **Thinking**: level `xhigh` ditambahkan ke claude-adaptive.
- **Capabilities**: context window nyata GPT-6/GPT-5.4+ dan batas token combo;
  alias vision `deepseek-v4-1-flash`; zed masuk katalog live.
- **Responses**: menunggu usage nyata sebelum `response.completed`, dibatasi
  watchdog 3 detik.
- **Codex**: refresh token tidak lagi dipakai ulang (penyebab logout saat
  auto-ping); hosted web search dipertahankan di GPT-6 Sol/Luna; model hantu
  dibuang.
- **Grok CLI**: mengirim versi 1.0.44 agar proxy berhenti membalas HTTP 426.
- **Proxy**: fallback otomatis ke TLS insecure pada error self-signed;
  `strictProxy` ditahan saat tidak ada proxy yang resolve.
- **Translator**: `errorMessage` dan keyword non-standar dibuang dari schema
  tool Gemini; tool bernama sama di-dedupe untuk model DeepSeek.
- **Codebuddy**: error rate limit 6004 di-parse dan `resetsAtMs` diambil;
  `recurring` diteruskan untuk quota pack codebuddy-intl.
- **CLI Tools**: placeholder `sk_9router` diganti API key dashboard aktif pertama.
- **Dashboard**: provider tersembunyi dikeluarkan dari daftar provider usage.

### Kustomisasi fork yang dipertahankan
- Halaman Usage Tumpukan Berlapis + panel Live + warna provider unik.
- Layer animasi Motion + GSAP + Lenis sebagai primitif lintas halaman.
- Menu `/dashboard/automation` lengkap.
- Provider `freebuff` dan `meta-code` (registry, executor, usage, OAuth).
- Fix image Antigravity: pivot claude→openai→gemini tetap meneruskan inlineData.
- Rotasi host Antigravity, domain breaker, dan pool breaker (strike 429).
- Fix angka Usage beku (i18n runtime) dan `x-connection-id`.
- Batas pesan error 300 karakter, keep-alive dispatcher `proxyFetch`.

# v0.5.130 (2026-09-30) — 9router-imagefix

## Fixes
- **Halaman panjang (mis. Providers) hanya bisa digulir sebagian, tidak sampai
  bawah.** Penyebabnya `content` milik Lenis. `useSmoothScroll` menyerahkan
  `el.firstElementChild` sebagai elemen isi, dan itu hanya benar pada muat
  pertama: `AnimatePresence` menukar anaknya setiap kali pindah halaman,
  sehingga ResizeObserver Lenis menempel pada elemen yang sudah dilepas dari DOM.
  Tidak ada lagi sinyal resize, `resize()` tidak pernah berjalan, dan `limit`
  gulir BEKU pada tinggi halaman sebelumnya — halaman digulir sampai titik itu,
  lalu berhenti (mis. berhenti di "Mistral" padahal daftarnya masih panjang).

  Limit Lenis memang dihitung dari `wrapper.scrollHeight`, tapi tetap butuh
  sinyal resize untuk dihitung ulang. `PageTransition` kini menyediakan
  pembungkus isi yang STABIL (`contentRef`) yang tidak diganti antar-navigasi,
  jadi ResizeObserver terus hidup dan tinggi isi selalu terukur benar.

- **Stagger halaman tanpa batas: kartu di bawah terlihat kosong beberapa detik.**
  Regresi dari 0.5.128. `PageTransition` dijadikan sumber `staggerChildren`, dan
  `staggerChildren` milik Motion memberi tiap anak delay `index × step` TANPA
  batas atas. Halaman Providers merender ratusan kartu, jadi kartu terakhir baru
  muncul setelah beberapa detik — ruangnya ada, isinya belum. Itu ikut membuat
  halaman tampak "tidak sampai bawah".

  Stagger otomatis se-halaman dilepas (`pageVariants`, `CARD_VARIANTS`, dan
  `StaggerInheritContext` dihapus dari `primitives.js`). `STAGGER_CAP` hanya
  benar untuk primitif `Stagger`, yang menghitung delay-nya sendiri dari index
  yang sudah dijepit — dan itu tetap dipakai di halaman Skills. `Card` kembali
  beranimasi sendiri, serentak.

## Verification
- `npm run build` → exit 0, "Compiled successfully".
- `rg` tidak menemukan sisa referensi ke `pageVariants` / `CARD_VARIANTS` /
  `StaggerInheritContext` (tinggal di komentar penjelasan).
- ESLint bersih pada seluruh berkas yang diubah.

# v0.5.129 (2026-09-30) — 9router-imagefix

## Fixes
- **Halaman Usage mati total: `Uncaught ReferenceError: valueFormat is not defined`.**
  Regresi dari 0.5.128. `valueFormat` dan `secondaryFormat` didefinisikan di dalam
  `UsageStack`, tetapi DIPAKAI di `LayerBody` — komponen yang berbeda dan berada
  di lingkup modul, sehingga nama itu tidak ada di sana. Kesalahannya terjadi saat
  render daftar baris, jadi seluruh halaman Usage gagal dibuka.

  Keduanya dipindah ke tingkat modul (`valueFormatFor(mode)` dan
  `formatTokensWithSuffix`) — satu definisi yang dipakai kedua komponen, sesuai
  niat awalnya agar kepala lapis dan tiap baris memakai aturan format yang sama.

  Bug ini lolos dari `next build` karena webpack tidak memeriksa nama bebas
  (dianggap variabel global), dan lolos dari lint karena `eslint-config-next`
  tidak mengaktifkan `no-undef`.

## Chores
- **`no-undef` diaktifkan untuk `src/shared/**` dan `src/app/**/usage/**`.**
  Kedua area terverifikasi 0 pelanggaran, jadi aturannya bisa dipasang tanpa
  membanjiri laporan; `src` secara keseluruhan masih punya pelanggaran lama
  sehingga belum layak global. Diuji dengan berkas probe berisi nama bebas —
  sekarang langsung ditolak.

## Verification
- `npm run build` → exit 0, "Compiled successfully".
- `no-undef` dijalankan pada versi HEAD lama → menunjuk persis `valueFormat`
  (baris 598) dan `secondaryFormat` (baris 601), membuktikan rule menangkap
  kelas bug ini.
- Area terjaga (`src/shared`, usage) → 0 pelanggaran `no-undef`.

# v0.5.128 (2026-09-30) — 9router-imagefix

## Fixes
- **Smooth scroll (Lenis) praktis tidak berfungsi karena `lerp` terbalik.**
  Opsinya disetel `lerp: 0.9`, padahal bawaan Lenis `0.1`. Pada Lenis, `lerp`
  adalah PECAHAN jarak yang ditempuh per frame (`damp(x, y, lerp*60, dt)`), jadi
  0.9 menempuh ~59% sisa jarak tiap frame — sekitar enam kali lebih "lari"
  daripada bawaan. Hasilnya nyaris tak bisa dibedakan dari scroll asli, dan
  itulah sebabnya efek halusnya tidak pernah terasa. Kini `lerp: 0.1`.

- **Token yang sedang beranimasi sempat tercetak berdesimal.** Nilai antara
  dianimasikan sebagai bilangan pecahan, lalu `fmtFull` apa adanya mencetaknya
  sebagai `"1,234.567"`. Ditambahkan `fmtWhole()` — pembulatan khusus angka
  yang sedang berjalan; token tidak pernah tampil setengah.

## Features
- **Stagger se-halaman.** `PageTransition` kini menjadi sumber
  `staggerChildren`, dan `Card` mewarisi variansnya lewat `StaggerInheritContext`
  baru. Sebelumnya tiap kartu menyalakan animasinya sendiri dengan `delay: 0`,
  sehingga seisi halaman muncul serentak sebagai satu kedipan. Sekarang kartu
  menyusul berurutan. Berlaku untuk semua halaman yang memakai `Card` tanpa
  satu pun berkas halaman perlu diubah; di luar `PageTransition` (landing page,
  kartu di dalam modal) `Card` tetap beranimasi sendiri seperti semula.

- **Angka Usage beranimasi mulus saat bertambah.** Komponen `AnimatedNumber`
  baru dipasang di `StackHead` (biaya/token besar, nilai pendamping, jumlah
  request, rincian uncached/cached/output), kepala tiap `Layer`, nilai tiap
  `LayerRow`, dan `LivePanel`. Nilai awal TIDAK pernah 0 — render pertama memakai
  nilai akhir apa adanya, dan animasi hanya berjalan saat nilainya benar-benar
  berubah (aliran SSE yang mengirim angka sama tidak memicu animasi sia-sia).

- **Primitif gerak akhirnya terpakai di halaman utama.** Sebelumnya `Reveal`,
  `Stagger`, `HoverLift`, `Magnetic`, `PageShell`, dan `CountUpOnView` hanya
  didefinisikan dan tidak pernah di-import — kode mati, TIDAK ada halaman yang
  memakainya. Kini:
  - `PageShell` — kepala halaman Translator (dengan `titleClassName`,
    `subtitleClassName`, dan `titleAs` baru agar bisa dipakai sebagai kepala
    seksi tanpa mengubah rupa halaman) dan kepala seksi Combos.
  - `Stagger` + `HoverLift` — daftar Skills.
  - `Reveal` — kartu petunjuk dan kartu GitHub di Skills; kepala seksi MITM di
    CLI Tools (yang kartunya juga memakai `HoverLift`).
  - `HoverLift` — kartu Combo.

  Sebelum ini GSAP hanya menggerakkan garis kemajuan gulir 2px — itu sebabnya
  "GSAP tidak terasa": memang hampir tidak ada yang digerakkannya.

- **`PageShell` menerima `titleAs`.** Tingkat judul bisa diturunkan (h1 → h2)
  supaya primitif yang sama melayani kepala halaman maupun kepala seksi; header
  global sudah menampilkan judul halaman, jadi seksi di dalamnya memakai h2.

## Tests
- `tests/unit/usage-animated-number.test.js` diperluas dengan pengujian
  `fmtWhole`: token selalu bulat, memakai pemisah ribuan yang sama dengan
  `fmtFull`, dan nilai tak sah tidak pernah menjadi `NaN` di layar. 21/21 lulus.

## Verification
- `npm run build` → exit 0, "Compiled successfully".
- Artifact build memuat `lerp:.1`, `data-animated-number`, dan
  `beforeChildren` — perbaikan benar-benar ikut terpaket.
- ESLint bersih pada seluruh berkas yang diubah (dua error di `combos/page.js`
  sudah ada sebelum perubahan ini — dikonfirmasi identik pada versi HEAD).

# v0.5.127 (2026-09-30) — 9router-imagefix

## Fixes
- **`getSettings()` dibaca ~8× per request tanpa cache.** Ditemukan lewat
  knowledge graph codebase (god node #2: fan-in 93, fan-out 2). `settingsRepo`
  adalah satu-satunya repo yang tidak punya cache, padahal `getSettings()`
  dipanggil di jalur panas: satu request dengan N fallback akun membaca baris
  settings `1 + 1 + 2N` kali (`auth.js` membacanya di dalam loop pemilihan akun,
  `chat.js` di `handleChat` + `handleSingleModelChat`). Tiap panggilan =
  `SELECT data FROM settings WHERE id=1` + `JSON.parse` + merge ~80 default.

  Sekarang ada cache TTL 5 dtk untuk baris mentah. `mergeWithDefaults()` tetap
  dijalankan tiap panggilan, jadi hasilnya objek baru — tidak ada objek bersama
  yang bisa dimutasi pemanggil.

- **Kebenaran invalidation, bukan mengandalkan TTL.** `updateSettings()`
  meng-invalidate cache secara sinkron, sehingga setiap tulis lewat API repo
  terlihat pada baca berikutnya (bukan menunggu 5 dtk). `importDb()` — yang
  menulis baris settings dengan SQL langsung — juga meng-invalidate. TTL hanya
  membatasi staleness untuk penulis di luar repo; migrasi legacy berjalan di DB
  segar sebelum server melayani trafik.

- **Backup tetap point-in-time.** `exportSettings()` memakai jalur baca langsung
  (`readRawDirect()`), bukan cache.

## Catatan
- Perbandingan pola: `pricingRepo` (TTL 5 dtk), `requestDetailsRepo` (TTL
  5 dtk), `usageRepo` (connCache 30 dtk) — `settingsRepo` kini mengikuti pola
  yang sama.
- Tes: `tests/unit/settings-cache.test.js` (4 kasus) — memastikan tulis terlihat
  setelah cache terisi, merge default tetap utuh, export point-in-time, dan
  `importDb` meng-invalidate. `unit/db-sqlite-vs-lowdb.test.js`: 22/22 assertion
  lulus. Tiga kegagalan `unit/db-concurrent.test.js` adalah baseline lama
  (terbukti identik saat perubahan ini di-revert), bukan regresi.

# v0.5.126 (2026-09-30) — 9router-imagefix

## Features
- **Animasi di seluruh dashboard: Motion + GSAP + Lenis.** Terpasang lewat
  LAPISAN yang dipakai berulang, bukan animasi per-elemen di 24 halaman.

  Dua alasan bentuknya begitu. Pertama, 24 berkas berarti 24 tempat yang bisa
  salah, masing-masing dengan durasi dan easing sendiri. Kedua — dan yang lebih
  menentukan — halaman Usage punya 600 baris akun, providers dan quota ratusan:
  menjadikan tiap baris komponen beranimasi berarti ratusan langganan yang
  render ulang tiap frame, dan stagger 40ms × 600 baris membuat baris terakhir
  muncul setelah 24 detik. Itu rusak, bukan kaya.

  | Lapisan | Cakupan | Library |
  |---|---|---|
  | Transisi halaman | semua 12 menu, satu tempat di layout | Motion |
  | Stagger sidebar + sorotan bergeser | 15 menu | Motion (`layoutId`) |
  | Smooth scroll container | semua halaman | Lenis |
  | Garis progres gulir | semua halaman | GSAP ScrollTrigger |
  | Animasi masuk kartu | 69 berkas pemakai `Card` | Motion |
  | Primitif siap pakai | `Reveal`, `Stagger`, `HoverLift`, `Magnetic`, `CountUpOnView`, `PageShell` | Motion + GSAP |

- **`STAGGER_CAP = 12`.** Di atas 12 item, sisanya muncul bersamaan. Mata tidak
  lagi bisa membedakan stagger setelah belasan item, dan tanpa batas ini daftar
  panjang akan menunggu puluhan detik.

- **Sorotan menu bergeser, bukan berkedip.** `layoutId` yang sama di dua elemen
  membuat Motion menganimasikannya sebagai SATU latar yang berpindah. Dua latar
  yang saling memudar terlihat sebagai kedipan; satu latar yang bergerak terbaca
  sebagai satu benda yang pindah tempat.

## Catatan
- **Lenis diuji lebih dulu, sesuai kesepakatan.** Enam pemeriksaan lulus:
  `<html>` tetap tidak menggulir, sidebar tidak bergeser (`x:0, y:0`), konten
  tetap bisa digulir (1923px di 627px layar), dan — yang paling penting —
  scroll bersarang aman: panel di console-log menggulir sendiri tanpa
  memindahkan halaman, berkat `prevent` yang mendeteksi elemen ber-`overflow-y`.
  Lenis dipasang di CONTAINER, bukan dokumen: `<html>`/`<body>` tidak pernah
  menggulir di layout ini, jadi Lenis di dokumen tidak akan melakukan apa pun.
- **GSAP dimuat dinamis.** Paketnya 6,4MB; halaman yang tidak memakai hitungan
  panjang tidak perlu memuatnya sama sekali.
- **`Button` tidak disentuh.** Ia sudah punya `active:scale-[0.97]` dari CSS;
  menambahkan Motion di atasnya hanya menambah lapisan DOM tanpa manfaat.
- **`prefers-reduced-motion` dihormati di SETIAP primitif**, bukan di satu
  tempat saja — komponen yang lupa memeriksanya akan tetap memberi gerakan
  kepada operator yang sudah mematikannya.

## Verifikasi
- 12 halaman menu diuji: animasi jalan, garis progres ada di 12/12, nol overflow
  horizontal, nol halaman error. `motion 91` elemen di providers dan `40` di
  quota menunjukkan animasinya tersebar ke isi halaman, bukan hanya pembungkus.
- Suite **2072 tes / 87 gagal — identik baseline, nol regresi**.
- Stagger sidebar terbukti dari frame nol: `0.55,0.23,0.00` → `0.71,0.48,0.13`
  → `0.81,0.67,0.41` — tiap menu mendahului menu berikutnya.

# v0.5.125 (2026-09-30) — 9router-imagefix

## Features
- **Angka bergerak, bukan melompat.** `value-fade` yang lama hanya menganimasikan OPASITAS —
  nilainya tetap berpindah dari 3,69 ke 3,75, dan yang terlihat cuma kedipan. Sekarang nilainya
  benar-benar berjalan, lewat `useAnimatedNumber.js`.

  Easing `easeOutCubic` 420ms: cepat di awal, melambat di akhir. Angka utama, angka pendamping
  (mode Cost + Tokens), dan nilai tiap baris lapis semuanya ikut.

- **Hover chart lebih halus.** Tooltip FlowChart diberi transisi 120ms (Recharts memunculkannya
  seketika, dan pada data yang bergerak itu terasa berkedip), `activeDot` tumbuh bertahap, dan
  garis kursor ikut bertransisi antar-titik.

- **`prefers-reduced-motion` dihormati.** Sebelum ini halaman Usage beranimasi tanpa jalan
  keluar sama sekali — nol aturan di `globals.css` — padahal halaman ini dipakai berjam-jam,
  bukan dilihat sekilas. Yang dimatikan hanya DURASI-nya (0,01ms), bukan perubahannya, sehingga
  tidak ada layout yang bergantung pada selesainya sebuah animasi.

## Fixes
- **Jangan pernah menganimasikan dari 0 pada render pertama.** Kalau nilai awal dihitung dari 0
  lalu berjalan naik, membuka halaman menampilkan `$0.00 → $3,69` — dan selama 420ms pertama
  angkanya BERBOHONG. Halaman ini ada untuk dipercaya. Render pertama memakai nilai akhirnya
  apa adanya; animasi hanya dijalankan saat nilai BERUBAH.

- **Animasi harus lebih pendek dari jarak antar-pembaruan.** SSE memperbarui beberapa kali per
  detik; kalau tiap perubahan dianimasikan lebih lama dari itu, animasinya tidak pernah selesai
  dan angkanya tertinggal dari kenyataan selamanya. Durasi dijaga 420ms dengan easing yang
  cepat di awal, sehingga nilainya sudah ~95% sampai saat pembaruan berikutnya tiba.

- **Nilai yang sama tidak dianimasikan.** SSE mengirim angka yang sama berulang kali; tanpa
  penjagaan ini angkanya berkedip tanpa pernah berubah nilainya.

- **Nilai tak sah tidak merambat.** Sekali `NaN` masuk ke interpolasi, seluruh angka di halaman
  itu `NaN` selamanya. `safeNumber` mengubahnya jadi 0, dan `interpolateList` jatuh ke nilai
  tujuan saat panjang daftar berubah (provider muncul/hilang saat halaman disaring).

## Catatan
- **Headless Edge di mesin ini tidak menganimasikan `transition` CSS** — terbukti di
  `about:blank` tanpa aplikasi: transition menghasilkan 1 nilai dalam 38 frame, sementara
  `@keyframes` menghasilkan 25 nilai unik. Jadi animasi berbasis transition TIDAK BISA diukur di
  lingkungan ini, dan setiap pengukuran yang mengandalkannya (termasuk di sesi ini) tidak sah.
  Hook angka memakai `requestAnimationFrame`, yang terbukti bekerja: 27 frame untuk 420ms,
  nilai antara `0,41 → 0,84 → 1,24 → … → 4,22`, mendarat tepat di target.
- `tests/unit/usage-animated-number.test.js` (17 tes) menguji matematikanya tanpa DOM — repo ini
  tidak punya `jsdom` maupun `@testing-library/react`, dan menambahkan keduanya demi satu hook
  kecil bukan pertukaran yang baik. Yang diuji: easing tidak pernah melewati target (angka uang
  tidak boleh menyentuh $3,80 sebelum mendarat di $3,69), gerak turun benar, penjepitan `t`,
  nilai tak sah, dan penjagaan "tidak berubah → tidak dianimasikan".

# v0.5.124 (2026-09-29) — 9router-imagefix

## Features
- **Halaman Usage: warna identitas per provider.** Sebelumnya SEMUA warna berasal dari satu
  oranye dengan opasitas berbeda: peringkat 0 oranye penuh, 1 oranye 62%, 2 oranye 34%, dan
  **peringkat 3+ semuanya `--color-border` (abu-abu)**. Itu bekerja untuk tiga provider dan
  gagal total untuk empat puluh — di database nyata ada 40+ provider, sehingga hampir semuanya
  berwarna sama dan legenda berisi sederet titik kelabu yang tidak bisa dibedakan.

  Sekarang hue tiap provider dihitung dari hash FNV-1a atas namanya, lalu ditempatkan dengan
  sudut emas (137,508°) sampai jaraknya cukup dari warna yang sudah ditempatkan. Hash saja
  tidak cukup: dengan 40 provider di ruang 360°, peluang tabrakan mendekati pasti. Terukur
  pada 23 provider nyata — jarak minimum **9,95°** terhadap jarak ideal 15,65°, dan warna
  keluar terurut mengelilingi roda warna (20° → 353°). Versi pertama algoritmanya menghasilkan
  dua provider berjarak **0,1°** (praktis identik); tes menangkapnya dan penyebabnya diperbaiki,
  bukan toleransinya dilonggarkan.

  Warna dihitung dari SELURUH provider di stats, bukan yang terlihat setelah disaring —
  kalau tidak, menyaring halaman akan mengubah warna, dan penanda yang berubah saat dipakai
  tidak berguna sebagai penanda.

- **Donut komposisi provider** di dalam blok kepala. SVG murni, bukan pustaka chart: yang
  dibutuhkan hanya satu lingkaran berpotong (~40 baris SVG terhadap ~15KB bundel untuk fitur
  yang tidak dipakai). Delapan teratas digambar, sisanya satu potongan netral berlabel
  "N provider lainnya" yang bisa dibuka; pusat donut menampilkan total atau nilai potongan
  yang sedang disorot; klik potongan menyaring halaman.

- **Kalender aktivitas** — satu kotak per hari, lima tingkat intensitas **relatif terhadap hari
  terberat**, bukan ambang tetap: ambang tetap salah begitu besaran pemakaian berubah (periode
  sepi jadi seluruhnya pucat, periode ramai jadi seluruhnya gelap). Hari tanpa pemakaian dapat
  tingkat tersendiri sehingga tidak pernah terbaca sebagai "aktivitas sedikit".

- **Batang proporsi menampilkan SEMUA provider**, tidak lagi "tiga teratas + N others".
  Dengan 40 provider, versi lama berarti 37 di antaranya tidak punya identitas di kepala
  halaman — padahal justru di situ pertanyaan "ke mana pemakaian pergi" dijawab.

## Fixes
- **55% blok kepala terbuang.** Terukur pada lebar 1152px: angka utama (141px) dan kalimat
  pendamping (158px) hanya memakai ~470px dari 1062px, sisanya kosong di kanan. Disusun
  vertikal (keduanya kini mulai di `x=328`, sebelumnya `x=328` vs `x=489`) dan donut mengisi
  ruang yang tersisa.

- **Kode mati dibuang** dari `StackHead.js`: blok "N others yang bisa dibuka" beserta state
  `restOpen` dan `restMembers` tidak lagi punya dasar setelah proporsi menampilkan semua
  provider.

## Catatan
- **Heatmap hari × jam tidak dibangun**: `/api/usage/chart` sudah menjumlahkan per jam menjadi
  satu angka dan `usageDaily` menyimpan agregat per hari. Membuatnya berarti menambah query
  yang memindai `usageHistory` setiap kali halaman dibuka. Yang tersedia adalah versi per-hari,
  dan itu dinyatakan di layar alih-alih ditebak.
- `DESIGN.md` diperbarui: **"The One Accent Rule" diganti** menjadi empat aturan baru
  (Hashed-Hue, Marker-Not-Text, Stable-Color, dan pemisahan aksen-tindakan vs
  warna-identitas), karena aturan lama melarang persis apa yang sekarang dibutuhkan.
- `tests/unit/usage-provider-color.test.js` (13 tes) memaku tiga sifat yang mudah rusak tanpa
  terlihat: warna harus **stabil** (provider sama → warna sama), **terpisah** (tidak ada
  pasangan nyaris identik), dan **tidak mengocok ulang** warna lain saat provider ditambah.

# v0.5.123 (2026-09-27) — 9router-imagefix

## Features
- **Automation dikunci ke 7 provider + panduan tambah via script.** Katalog
  Kelola akun: antigravity, bai, cline, grok-cli, kilocode (baru),
  tokenharbour, kiro. freebuff keluar dari menu ini (tetap dari Providers).

  Tiap panel punya panduan "Tambah akun baru via script": perintah siap-salin
  dari argparse tiap script + nama file + format baris. Cara kerja: salin
  perintah + file `email:password` → script jalan lokal → akun muncul di sini
  (DB sama). Password tidak pernah menyentuh server.

  Antrean device-flow bulk (grok/kiro/kilocode): minta kode → setujui di
  browser sendiri → otomatis lanjut. Sepenuhnya via web, tanpa password.
  Sekuensial + generasi sesi. Tab Login device difokuskan ke 3 provider itu.

## Tests
- 40/40 automation lolos; lint bersih; build OK.

# v0.5.122 (2026-09-27) — 9router-imagefix

## Features
- **Automation: fitur tiap provider dilengkapi sesuai skripnya.** Kiro masuk
  katalog (kuota/test/prompt/impor/refresh) + impor bulk `email:refreshToken`
  tervalidasi via refresh ke AWS sebelum disimpan. Kuota objek (`quotas{}`
  ala kiro/grok/antigravity) ikut terbaca; grup AG (Gemini vs Claude & GPT,
  termasuk baris mingguan) + total pool Kiro dibawa di hasil pindaian.

  Operasi massal baru: refresh token tanpa login ulang (cline/kiro/grok/ag),
  verifikasi key via inferensi nyata 401/402/429 (b.ai, tokenharbor),
  nonaktifkan (cleanup expired tokenharbor), `ids` opsional di cek
  kuota/tes untuk akun tertentu ("50", "1-10").

  UI ProviderOps per provider: kuota selektif per nomor, hapus 0% per grup AG,
  pool Kiro, bersih per kategori Cline MATI/LIMIT/ERROR/EXPIRED, hapus BLOCKED
  + by-pattern Grok, expiry TokenHarbor (lihat/nonaktifkan/hapus), nonaktif
  per domain + dry-run AG, generator TXT pembuat (client-side).

  Dua yang disengaja TIDAK dibangun: login browser pakai `email:password`
  (mesin credential stuffing + password massal di browser), dan hapus otomatis
  saat pemindaian (setiap hapus pakai pratinjau + konfirmasi).

## Tests
- 16 test baru `tests/unit/automation-provider-ops.test.js` (kuota objek,
  grup AG, hapus per grup, indeks selektif, kategori cline, expiry, nonaktif).
  40/40 automation lolos; lint bersih; build OK.

# v0.5.121 (2026-09-27) — 9router-imagefix

## Features
- **Menu Automation disusun ulang: pilih provider → menu fiturnya.** Mengikuti
  bentuk dashboard-di-atas-menu pada skrip terminal. Enam provider sesuai enam
  skrip, dan fitur yang ditawarkan hanya yang benar-benar dimiliki provider itu:

  | Provider | Sumber | Kuota | Catatan |
  |---|---|---|---|
  | Antigravity | `add-account-ag-9router.py` | ✅ | kuota per grup model + reset time |
  | B.AI | `add-account-bai-9router.py` | — | kuota lewat inferensi (tidak ada endpoint saldo) |
  | Cline | `add-account-cline-oauth-9router.py` | — | token 1 jam, refresh ambang 300 detik |
  | Grok CLI | `add-account-grok-9router.py` | ✅ | billing + deteksi `team_blocked` |
  | TokenHarbor | `add-account-tokenharbor-9router.py` | — | punya masa berlaku akun |
  | Freebuff | `add-freebuff-deviceflow-9router.py` | ✅ | satu akun satu model; login device |

  `quota` tidak ditawarkan untuk provider yang 9Router belum punya handler-nya —
  tombol yang selalu menjawab "belum ada" lebih buruk daripada tidak ada tombol.

- **Generate TXT per provider**, bentuknya mengikuti skrip asalnya karena berkas
  itu harus bisa dibaca kembali oleh skrip itu:
  `antigravity`/`grok-cli` → `email:refreshToken` · `cline` →
  `email:accessToken:refreshToken` · `freebuff` → `email:accessToken` ·
  `bai` → `email:sk-...` · `tokenharbour` → `email:thk_...[:jam]`.

- **Impor kredensial per provider.** Dedup yang benar dan penggabungan data
  (lihat Fixes). Parser menerima `:` `|` `=` `,` dan tab, karena berkas yang
  beredar antar mesin datang dalam beberapa bentuk dan menolak salah satunya
  berarti operator harus mengeditnya dulu.

- **Tes prompt per akun.** Mengirim prompt nyata lewat gateway sendiri dengan
  header `x-connection-id`, sehingga yang diuji benar-benar "apakah akun ini
  bisa melayani request" — melewati jalur yang sama dengan trafik sungguhan,
  termasuk refresh token dan proxy. Balasan ditampilkan utuh (skrip `bai`
  memotongnya di 50 karakter).

## Fixes
- **Password diminta berulang setiap kali halaman dibuka.** `page.js` selalu
  mulai dengan `unlocked = false` dan tidak pernah memeriksa cookie yang sudah
  sah; karena setiap perpindahan tab di dashboard adalah navigasi sungguhan,
  operator diminta mengetik ulang setiap kali kembali. → status gerbang
  DIPERIKSA lewat `GET /api/automation/gate` saat halaman dimuat.

- **Dua bug impor yang tidak ditiru dari skrip sumber:**
  `tokenharbor` membandingkan `row[2]` untuk dedup padahal itu kolom `name`
  (`json.loads("bkd1 #1")` selalu gagal) sehingga setiap impor menambah baris
  baru; dan `cline` menulis seluruh kolom `data` dengan payload baru sehingga
  `lastUsedAt` / `consecutiveUseCount` / `modelLock_*` milik 9Router hilang.
  Di sini dedup memakai nilai kredensial, dan pembaruan memakai
  `updateProviderConnection` yang menggabung.

- **`x-connection-id` diterima di jalur chat.** Header itu sudah dipakai jalur
  image/video tapi belum chat, sehingga tidak ada cara menguji satu akun:
  permintaan selalu dilayani akun mana pun yang dipilih rotasi.

## Removed
- `src/app/api/automation/bulk-import/` dan dua komponen yang jadi kode mati
  (`AccountsSection.js`, `BulkImportSection.js`) — digantikan impor per provider
  yang menulis langsung ke daftar akun provider itu.

# v0.5.120 (2026-09-27) — 9router-imagefix

## Features
- **Menu Automation jadi lengkap: kelola akun, bukan cuma tambah.** Tab "Akun"
  baru menggabungkan bagian List / Test / Cek kuota / Hapus dari keenam skrip
  terminal, dengan pemindaian latar dan kemajuan yang terlihat.

  - **Cek kuota massal** — memanggil `GET /api/usage/{id}` milik 9Router sendiri,
    bukan menyalin logika tiap skrip. Hasilnya lebih baik daripada versi Python:
    `resetAt` ikut terbawa (skrip `ag` membuangnya), dan daftar modelnya lebih
    lengkap.
  - **Test koneksi massal** — memakai `POST /api/providers/{id}/test` yang sudah
    menangani 18 provider termasuk refresh token dan proxy.
  - **Saring & cari** per provider, status, atau teks; pilih banyak akun; hapus.
  - **Pekerjaan latar dengan kemajuan, pembatalan, dan pemulihan.** `id` job
    disimpan di `localStorage`, jadi me-refresh halaman menyambung kembali ke
    pemindaian yang masih berjalan alih-alih kehilangannya.

## Fixes
- **146 dari 156 akun terukur punya `lastError` yang BUKAN masalah akun.**
  Semuanya `400 invalid-argument: [input_too_large] The prompt is too long for
  this model's context window` — masalah panjang prompt, dan akan hilang sendiri
  pada request berikutnya. Menandai akun bermasalah hanya karena `lastError` ada
  isinya akan melaporkan 146 akun sehat sebagai rusak. → klasifikasi berdasarkan
  MAKNA: hanya 401/403 (kredensial mati) dan 402/kuota habis yang bermakna;
  `input_too_large`, 429, dan gangguan jaringan tidak.

- **`testStatus: "unavailable"` menyesatkan kalau ditampilkan apa adanya.**
  Terukur: 146/156 akun `unavailable` padahal semua `isActive`. Nilai itu ditulis
  jalur fallback runtime saat satu request gagal, bersama `modelLock_<model>`;
  setelah cooldown lewat akun itu aktif kembali. → status efektif dihitung dari
  cooldown, mengikuti aturan yang sudah dipakai `ConnectionsCard.js`.

- **Kuota yang tidak terbaca tidak lagi bisa berarti "habis".** Skrip `ag`
  memakai ambang `pct < 1` tanpa mengecualikan sentinel `-1` ("N/A"), dan
  `-1 < 1` bernilai benar — akun yang kuotanya gagal dibaca ikut terhapus.
  → "tidak terbaca" adalah keadaan tersendiri dan tidak pernah memicu
  penghapusan.

- **Memindai dan menghapus adalah dua tindakan terpisah.** Skrip `ag` menghapus
  DI DALAM pemindaian; skrip `bai` memakai `not ok` mentah sehingga akun sehat
  yang sekadar gagal jaringan ikut terhapus; skrip `tokenharbor` menawarkan hapus
  semua akun karena bergantung pada `lastError` yang di-set 9Router. Di sini
  pemindaian hanya MENGISI daftar usulan, dan operator yang menekan tombol hapus
  setelah melihat siapa saja yang masuk.

- **Token tidak pernah dikirim ke browser.** Tab Export tetap punya peringatannya
  sendiri, tapi daftar akun hanya memuat penanda dan awalan 6 karakter. Skrip
  `tokenharbor` mencetak 25 karakter pertama API key ke layar.

## Catatan
- Tiga bug lain di skrip sumber ditemukan dan **tidak** ditiru: `cline`
  meng-overwrite seluruh kolom `data` sehingga menghapus `lastUsedAt` /
  `consecutiveUseCount` / `modelLock_*` milik 9Router; `tokenharbor` membaca
  kolom yang salah saat dedup (`row[2]` adalah `name`, bukan `data`) sehingga
  selalu menyisipkan baris baru; dan export TXT `cline` tidak bisa diimpor balik
  karena formatnya berbeda dari parser impornya.
- `tests/unit/automation-classification.test.js` memaku aturan klasifikasi —
  khususnya bahwa `input_too_large` dan kuota-tak-terbaca tidak pernah masuk
  daftar hapus.

# v0.5.119 (2026-09-27) — 9router-imagefix

## Features
- **Menu Automation** (`/dashboard/automation`) — menambah akun provider dari web,
  menggantikan kebutuhan menjalankan skrip Python dari terminal.

  Tiga bagian: **Tambah via OAuth** (alur device-code dipandu di satu layar:
  pilih provider → kode tampil → salin → setujui di browser → token tersimpan),
  **Bulk import** (tempel JSON atau pilih berkas; akun kembar dilewati; hasil
  per-baris), dan **Export** (JSON yang bisa diimpor ulang, atau TXT tab-separated
  untuk dibaca skrip).

  Sepuluh provider device-code: kiro, grok-cli, kilocode, kimi, codebuddy-cn,
  codebuddy-intl, qoder, meta-code, github, freebuff.

- **Gerbang password.** Halaman ini bisa menambah akun dan mengekspor token
  akses penuh ke semuanya, jadi ia punya lapisan kedua di atas sesi dashboard.
  Password dibandingkan dengan `timingSafeEqual`, cookie-nya HMAC terikat
  `JWT_SECRET` (cookie dari mesin lain tidak berlaku), dan **setiap** route
  automation dibungkus `requireGate` — dijaga di server, bukan disembunyikan di
  tampilan. `AUTOMATION_PASSWORD` di `.env` menang atas nilai bawaan.

  ⚠️ Password bawaan ditulis di `src/lib/automation/gate.js`. Repositori ini
  di-push ke GitHub, jadi siapa pun yang bisa membacanya bisa membukanya.
  Ganti lewat `AUTOMATION_PASSWORD` kalau repo ini pernah publik.

## Fixes
- **`Input` bersama: label tidak terasosiasi dengan kotaknya.** `<label>` tidak
  punya `htmlFor`, sehingga mengklik label tidak memfokus input dan pembaca
  layar tidak menyebut namanya. `id` dan `autoFocus` juga tidak diteruskan ke
  `<input>`. Bug yang sudah ada sebelum pekerjaan ini, di komponen yang dipakai
  seluruh dashboard.
- **`useCopyToClipboard` mengembalikan ID, bukan boolean.** Pemakaian pertama
  saya memeriksanya sebagai boolean, yang menampilkan "Tersalin" sejak render
  pertama — sebelum apa pun pernah disalin.

## Catatan
- `src/lib/automation/deviceFlow.js` menyalin logika bercabang dari
  `api/oauth/[provider]/[action]/route.js`, dan
  `src/lib/automation/providers.js` menyalin daftar provider no-PKCE dari dua
  tempat. Duplikasi disengaja: jalur Automation digerbangi password, jalur OAuth
  tidak. `tests/unit/automation-device-flow.test.js` membandingkan ketiga sumber
  dan gagal kalau menyimpang — tanpa penjaga itu, menambah provider di satu
  tempat dan lupa di tempat lain menghasilkan kegagalan yang baru muncul setelah
  operator susah payah menyetujui di browser.
- Yang **tidak** dibangun: pembuatan akun massal dengan captcha solver.

# v0.5.118 (2026-09-26) — 9router-imagefix

## Features
- **Panel Live di halaman Usage (tab Overview).** Di bawah StackHead kini ada
  bagian Live: request yang sedang berjalan (model, provider/akun, token
  in/out, durasi berjalan) dan request terakhir yang selesai (model, provider,
  token, waktu relatif "5s/3m/2h ago").

  Datanya menumpang SSE `/api/usage/stream` yang sudah ada (event `pending`,
  throttle ±1 dtk dari repo) — tanpa EventSource kedua. Waktu di-tick lokal
  tiap detik dari `startedAt`/`timestamp`; angka token tetap milik server.
  Estimasi input pra-TTFT dari ukuran body (tanda `~`) diganti angka asli
  upstream begitu chunk ber-usage tiba. State `live` dipisah dari `stats`
  periode sehingga panel tetap jalan saat ganti periode.

## Tests
- 2 test live baru di `tests/unit/db-sqlite-vs-lowdb.test.js` (baris live +
  angka asli menang atas estimasi). 2 gagal di `force-stream-config` adalah
  mock `headroom.js` yang basi — identik di checkout bersih, bukan regresi.

# v0.5.117 (2026-09-26) — 9router-imagefix

## Features
- **Halaman Usage ditulis ulang: "Tumpukan Berlapis"** (menggantikan empat kartu
  angka sejajar + chart + tabel).

  Halaman ini sekarang satu tumpukan yang dibaca dari atas ke bawah: satu ringkasan
  tebal, lalu lapis-lapis yang mengembang di tempat — provider → model → akun →
  endpoint → request tunggal. Lapis induk tetap terbaca saat lapis anak terbuka,
  jadi hierarki terlihat utuh dalam satu kolom, bukan sebagai tiga halaman.

  Empat interaktivitas: drill-down, filter & pencarian, chart dengan brush rentang
  waktu + tombol Peak/Reset, dan komposisi antar-dimensi dari `byProvider`/`byModel`.
  Perbandingan periode **tidak** dibangun: API tidak punya periode pembanding, dan
  meminjamkan konteks yang tidak ada sama buruknya dengan menghilangkannya diam-diam.

- **Tiga mode nilai: `Cost` / `Tokens` / `Cost + Tokens`.** Mengganti mode
  memindahkan angka yang jadi kepala dan basis peringkat lapis, bukan sekadar label.

- **Rincian token di kepala: input / cached / output.** `cached` diperlakukan sebagai
  **BAGIAN DARI** `input`, bukan komponen ketiga — sumbernya
  `prompt_tokens_details.cached_tokens` (OpenAI), `cache_read_input_tokens` (Claude,
  di dalam `input_tokens`), `prompt_cache_hit_tokens` (DeepSeek). Karena itu
  `total = input + output` dan batangnya menulis "uncached input" + "cached (N% of
  input)", bukan empat potongan yang bisa dijumlahkan.

## Fixes
- **Angka tidak lagi disingkat.** `fmtCost` berhenti membulatkan ke `$7.1K`, token
  pakai `toLocaleString("en-US")` (`16,042,831,295`, bukan `16.0B`). Satu-satunya
  singkatan yang tersisa adalah gutter sumbu-Y selebar 52px di chart.
- **Angka periode lama di bawah label periode baru** (kelas bug yang sama dengan
  0.5.109). Diukur: klik "All" → pada +300ms layar menampilkan `$0.95 / 739 requests`
  berlabel `all time`, padahal sebenarnya `$7.1K / 58.107`. → `statsPeriod` disimpan
  bersama `stats`, dan render hanya menerima stats saat keduanya cocok; selain itu
  kerangka. Bukan angka periode lain, bukan pula `0` yang berpura-pura jadi jawaban.
- **Tombol "Retry" tidak mengulang apa pun** — memanggil `router.refresh()` pada
  client component, yang memuat ulang pohon server alih-alih effect data.
- **Drill-down mengabaikan periode.** Ia menerima prop `period` tapi tidak pernah
  memakainya, sehingga selalu menampilkan 25 request terakhir sepanjang waktu: di
  bawah judul "today" muncul request berumur "52d". → `periodStart()` memetakan
  period ke `startDate`, dengan pemetaan yang **harus sama** dengan `PERIOD_MS` di
  `usageRepo.js` (`today` = tengah malam **lokal**, bukan UTC).
- **Kolom Tokens di drill-down selalu `0`.** Komponen membaca `d.promptTokens`,
  sementara baris tersimpan memakai `d.tokens.input_tokens` (507 baris) maupun
  `prompt_tokens` (493 baris) — dua-duanya kini ditangani, termasuk cadangan cache
  untuk baris Claude lama yang menyimpan input TANPA cache.
- **Kolom Cost di drill-down selalu `—`, dan memang tidak akan pernah terisi.**
  `buildRequestDetail` tidak punya field `cost`; terukur **0 dari 1.000** baris
  memilikinya. Kolomnya dihapus, diganti **Latency** (`latency.total` ada di
  1.000/1.000 baris). Kolom yang selalu kosong bukan informasi kurang — ia ruang
  yang menuntut perhatian untuk memberi tahu bahwa tidak ada apa-apa.
- **Tab "Logs" tidak terjangkau.** `page.js` merender `RequestLogger` untuk
  `?tab=logs`, tapi kontrol tab hanya menawarkan Overview dan Details — jadi
  tampilan itu hanya bisa dicapai dengan mengetik URL, dan saat aktif **tidak ada
  tombol yang tersorot**. Opsinya ditambahkan.
- **Empat kelas CSS dipakai tanpa token, sehingga menghasilkan nol CSS di Tailwind
  v4:** `text-text-primary` (30×), `bg-bg-hover` (7×), `bg-bg-subtle` (6×) membuat
  panel kehilangan latar dan teks kehilangan warna; `text-error`/`bg-error`/
  `border-error` membuat banner gagal impor/ekspor tampil sebagai teks biasa.
  → ditambahkan tokennya (`--color-error`, `--color-primary-strong`, `--text-subtle`),
  bukan mengganti puluhan pemakaian kelas.
- **Kontras AA.** Putih di atas `#E56A4A` hanya 3,23:1 → tombol mode aktif memakai
  `--color-primary-strong` (`#a64027`, 6,21:1). `--color-text-subtle` dan
  `--color-text-muted` versi terang juga gagal AA (2,44:1 dan 4,38:1 di `#F7F3EE`) —
  nilainya ternyata **tertukar** antar tema, bukan salah; kini `#5F6673` / `#8B93A1`.
- **Lapis "Accounts" menampilkan model, bukan akun** — labelnya `rawModel`, sama
  dengan lapis Models, jadi terbaca sebagai daftar model kedua.
- **Indentasi & garis lipatan tidak pernah dirender** (`depth={0}` untuk keempat
  lapis) padahal keduanya adalah tanda tangan halaman.
- **Rincian token hanya ada di `title`** — tak terjangkau keyboard, tak pernah muncul
  di sentuh → `tabIndex={0}` + `aria-describedby` + `span.sr-only`.
- **Cache-Control halaman dashboard.** Tanpa arahan eksplisit, Next memperlakukan
  halaman ini sebagai statis: `/dashboard/usage` terukur mengirim
  `s-maxage=31536000` (1 tahun) dengan `x-nextjs-cache: HIT`, sehingga HTML basi terus
  disajikan dan browser memuat bundle lama meski versi baru sudah terpasang.
  → `no-store` pada dokumen HTML; chunk ber-hash di bawah `/_next/static` tetap boleh
  di-cache selamanya karena namanya berubah saat isinya berubah.
- **a11y.** Ikon hias kini `aria-hidden="true"` (sebelumnya tombol Export terbaca
  "download Export"), `SegmentedControl` punya `aria-pressed` (sebelumnya keadaan
  terpilih hanya tersampaikan lewat warna). Terukur: 41 ikon di halaman Usage,
  0 tanpa `aria-hidden`.

## Removed
- **1.812 baris kode mati**, 7 berkas: `shared/components/UsageStats.js` (572),
  `usage/components/ProviderTopology.js` (487), `UsageTable.js` (255),
  `ProviderLimits/ProviderLimitCard.js` (186), `UsageChart.js` (141),
  `ProviderLimits/QuotaProgressBar.js` (132), `OverviewCards.js` (39) — plus
  dependensi `@xyflow/react`, entri `optimizePackageImports`-nya, dan ~85 baris CSS
  topologi (`@keyframes topology-*`, `.topology-router-*`, `.react-flow-controls-custom`).

  **Jebakan yang hampir menjatuhkan ini:** `src/shared/components/index.js` mengekspor
  `export { default as UsageStats } from "./UsageStats"`, dan webpack me-resolve baris
  itu **meski tidak ada yang mengimpornya** — tree-shaking tidak menyelamatkannya.
  Menghapus berkasnya tanpa menghapus baris barrel = `next build --webpack` gagal total.
- `tests/unit/usage-html-cache-probe.test.js` — nol `expect()`, path absolut yang
  di-hardcode, dan mencari pola chunk milik komponen yang sudah tiada. Digantikan
  `scripts/check-usage-html-cache.mjs`, yang harus dijalankan dan hasilnya dibaca.

## Tests
- `tests/unit/usage-period-switch.test.js` **diretARGET ulang** dari `UsageStats.js`
  (kode mati) ke `stack/index.js` (kode hidup), plus satu tes penjaga bahwa `page.js`
  memang merender `./components/stack`. Penjaga regresi yang mengawal kode mati lebih
  buruk daripada tidak ada penjaga — ia memberi rasa aman yang salah.

# v0.5.116 (2026-09-26) — 9router-imagefix

## Fixes
- **Freebuff: protokol sesi & chat disamakan dengan binary CLI resmi v0.0.199.**

  Perbandingan dengan binary resmi (`freebuff.exe`, sumber kebenaran sebenarnya —
  paket npm-nya hanya launcher) menemukan delapan perbedaan. Semua nilai diambil
  dari binary, bukan tebakan.

  | # | Sebelum | Sekarang | Kenapa |
  |---|---|---|---|
  | 1 | POST `/freebuff/session` | `/freebuff/session/admission` | rute klaim yang benar-benar dipakai CLI; 404/405 ditandai `session_admission_unsupported` |
  | 2 | hanya `x-freebuff-model` | + `x-freebuff-wallet-spend-limit: "0"`, `x-freebuff-first-tab-discount: "0"`, `x-fb-timezone` | header yang CLI pasang di setiap panggilan sesi |
  | 3 | `Authorization` saja | + `x-codebuff-api-key` | dual-auth di `/agent-runs` |
  | 4 | — | `x-freebuff-acting-user-id` | identitas akun di chat; dari kredensial, fallback `GET /api/v1/me` (di-cache) |
  | 5 | `allow_fallbacks: false` | `allow_fallbacks: true` + `data_collection: "deny"` (+ `only: ["anthropic"]` untuk Fable) | nilainya dihitung per model di binary, bukan konstanta |
  | 6 | — | `llm_step_number: "1"` | metadata langkah agen |
  | 7 | Fable = `base2-free-fable` | sama, tapi id model `claude-fable-5.1` | agent resmi menjalankan id ber-".1" |
  | 8 | root agent salah | fallback `base2-free`, Fable `base2-free-fable` | `base3-free` tidak pernah ada di binary |

  ⚠️ Akun uji sedang `banned` — perubahan ini terverifikasi lewat binary + unit
  test (202/202), belum end-to-end ke upstream.

# v0.5.115 (2026-09-25) — 9router-imagefix

## Features
- **Provider `meta-code` (alias `mc`) — langganan Muse Code dipakai langsung di 9Router.**

  Sebelumnya langganan Muse Code hanya bisa dipakai lewat CLI `muse` (dokumentasi Meta:
  *"This credential is for use with Muse Code only"*). Provider ini mereproduksi alur
  login CLI-nya, jadi kredensial langganan bisa dipakai lewat 9Router seperti provider lain.

  Alur autentikasi (device-code OAuth, sama seperti `muse login`):

  ```
  1. POST https://auth.meta.com/oidc/device/authorization/   → device_code + user_code
  2. POST https://auth.meta.com/oidc/device/token/           → access_token "dca:…"
  3. POST https://api.meta.ai/muse-code/key   (Bearer dca:)  → { api_key: "LLM|…",
                                                                 is_subs_active,
                                                                 subs_tier_name,
                                                                 subs_usage: { window, weekly } }
  ```

  Yang di-mint di langkah 3 itulah key yang **ditagih pada tarif langganan**, bukan
  pay-as-you-go. Mint bersifat idempoten — memanggil ulang mengembalikan key yang sama,
  jadi re-mint otomatis pada 401/403 aman.

  Isi:
  - `open-sse/providers/registry/meta-code.js` — entry registry (5 model `muse-spark-*`,
    transport `openai-responses` ke `api.meta.ai/v1/responses`).
  - `open-sse/services/metaCode.js` — helper mint + parser `subs_usage` (dipakai bersama
    oleh OAuth postExchange, token refresh, dan usage — DRY).
  - `open-sse/services/usage/meta-code.js` — handler kuota 5-jam + mingguan, cache 60 detik.
  - `src/lib/oauth/providers/meta-code.js` — device flow + mint.
  - `open-sse/services/tokenRefresh/providers.js` — `refreshMetaCodeToken` (re-mint).
  - `open-sse/providers/shared.js` — `META_CODE_OAUTH_CLIENT` (client id publik CLI muse,
    bisa di-override via `META_CODE_OAUTH_CLIENT_ID`).

  Dua quirk transport yang wajib, keduanya diverifikasi live:
  - **`forceStream: true`** — translator Responses selalu mengirim `stream:true`; klien
    JSON dirutekan lewat jalur SSE→JSON.
  - **`quirks.foldReasoningEffort: true`** — Meta menolak `reasoning_effort` gaya Chat di
    level atas dengan **HTTP 400** (*"unknown parameter `reasoning_effort`"*); harus
    dipindah ke `reasoning.effort`. Quirk baru ini ditambahkan di
    `open-sse/executors/default.js`.

  Kuota hanya tersedia untuk koneksi OAuth: endpoint mint menolak API key biasa dengan 401,
  jadi `features.usage` tanpa `usageApikey`.

  Kredit: alur ini pertama kali di-reverse-engineer oleh `yandy-r/9router`
  (`docs/plans/yan-6-meta-code/plan.md`). Di-port ke fork ini dengan penyesuaian:
  quirk `foldReasoningEffort` ditulis sendiri (tidak ada di sumber aslinya), client id
  dipindah ke `shared.js` mengikuti pola `GOOGLE_OAUTH_CLIENT`, dan `refreshToken`
  ditambahkan ke ctx usage handler.

  Test: `tests/unit/meta-code-provider.test.js` — 19 pemeriksaan.

# v0.5.114 (2026-09-25) — 9router-imagefix

## Fixes
- **"Hide to Tray" mematikan gateway — CLI bunuh diri sebelum tray lahir.**

  Gejala: memilih "Hide to Tray (Background)" membuat server mati total.
  Harus dijalankan ulang manual.

  Akarnya **balapan di event loop**, bukan logika spawn yang salah:

  ```js
  isShuttingDown = true;
  cleanup();                       // ← SIGKILL server
  await killProcessOnPort(port);   // ← melepas kontrol ke event loop
                                   //    event "close" menyala DI SINI
  spawn(... "--tray" ...);         // ← TIDAK PERNAH TERCAPAI
  ```

  `cleanup()` mengirim SIGKILL, lalu `await` berikutnya melepas kontrol ke
  event loop. Tepat di situ event `close` server menyala — dan handler-nya
  melihat `isShuttingDown === true` lalu memanggil `process.exit()`.
  CLI mati sebelum baris `spawn` dijalankan: **server sudah dibunuh, tray
  tidak pernah lahir.** Tidak ada yang menyalakannya kembali.

  Terbukti dengan simulasi urutan kejadian (bukan pembacaan kode):
  ```
  1. isShuttingDown = true
  2. cleanup() → SIGKILL
  3. await → event 'close' menyala
     handler: process.exit() → CLI MATI
  4. spawn tray → TIDAK PERNAH TERCAPAI
  ```

  Perbaikan: flag `isHandingOff` yang **terpisah** dari `isShuttingDown`.
  Ia diset SEBELUM `cleanup()`, dan kedua handler (`error` & `close`)
  memeriksanya lebih dulu lalu `return` tanpa keluar. Pada jalur serah terima
  kita memang ingin mematikan server — tapi CLI harus tetap hidup untuk
  men-spawn tray.

  Diverifikasi ulang dengan simulasi yang sama: `isHandingOff` →
  handler `return` → spawn tray **tercapai** → gateway pulih.

- **Verifikasi tray + jalur pemulihan.** Sebelumnya CLI menganggap tray
  berhasil begitu `spawn()` dipanggil. Sekarang ia menunggu server benar-benar
  hidup (`waitServerReady`, 25 detik). Kalau tray gagal — PowerShell
  NotifyIcon tidak tersedia, crash saat start, port belum bebas — server
  dinyalakan ulang di proses ini, pengguna diberi tahu, dan menu ditampilkan
  lagi alih-alih keluar diam-diam.

  Perilaku normalize: jalur "Exit" sengaja TIDAK memakai `isHandingOff` —
  di sana kita memang ingin CLI keluar dan server mati.

  Test: `tests/unit/cli-hide-to-tray-guard.test.js` (6 test).

# v0.5.113 (2026-09-25) — 9router-imagefix

## Fixes
- **Menu CLI: opsi "Exit" tidak berfungsi — ini regresi dari perbaikan 0.5.104.**

  Gejalanya: memilih "Exit" di menu "Choose Interface" tidak melakukan apa pun.
  Menu muncul lagi, server tetap hidup.

  Sebabnya indeks menu dibaca dengan konstanta offset hardcoded:

  ```js
  const offset = latestVersion ? 1 : 0;
  if (selected === offset)     return "web";
  if (selected === offset + 1) return "terminal";
  if (selected === offset + 2) return "hide";
  return "back";   // ← "Exit" (indeks 3/4) jatuh ke sini
  ```

  Menu punya 4 item tanpa update dan 5 dengan update, tapi **tidak ada satu pun
  cabang yang menangani indeks "Exit"**. Nilai balik terakhir `"back"` dulu
  memang menangkapnya — sampai 0.5.104 mengubahnya menjadi `"back"` demi
  memperbaiki bug ESC. Perbaikan itu benar untuk ESC, tapi diam-diam mematikan
  opsi "Exit" karena keduanya berbagi jalur yang sama.

  Perbaikan: setiap item menu membawa `action`-nya sendiri, dan aksi dibaca
  dari array item — bukan dari nomor yang dihitung manual. Bug kelas ini tidak
  bisa terulang lagi: menambah atau mengurutkan ulang item tidak perlu
  memperbarui dua tempat sekaligus.

  Logika pemetaan dipindah ke `cli/src/cli/utils/interfaceMenu.js` (fungsi murni)
  supaya bisa diuji tanpa menjalankan CLI — `cli.js` mengeksekusi dirinya di
  module scope (`startServer`, bahkan `process.exit`), jadi tidak bisa
  di-`require` dari test.

  Perilaku yang sengaja dipertahankan: ESC dan stdin bukan-TTY tetap
  menghasilkan `"back"` dan **tidak** mematikan server.

- **Test `cli-menu-kill-guard` yang lama berhenti mencocokkan teks.** Ia mencari
  pola `return "..."` di sumber `cli.js` untuk memastikan tidak ada nilai balik
  `"exit"`. Setelah logika pindah ke modul terpisah, pola itu tidak ada lagi di
  sana. Dua test yang bergantung pada bentuk kode diganti dengan pengujian
  perilaku terhadap `interfaceMenu.js`.

  Pelajaran: pencocokan teks membuat bug "Exit tidak berfungsi" lolos selama
  dua rilis — test memverifikasi *bentuk* kode, bukan *perilaku*-nya. Yang baru
  mengeksekusi fungsi sungguhan dan memeriksa nilai baliknya.

  Test: `tests/unit/cli-menu-exit-guard.test.js` (10 test). Diverifikasi
  menangkap bug: logika lama mengembalikan `back` untuk indeks Exit, logika
  baru mengembalikan `exit`.

# v0.5.112 (2026-09-24) — 9router-imagefix

## Fixes
- **Dashboard: angka Usage "beku" saat period diganti — akar masalahnya di
  i18n runtime, bukan di komponen Usage.** Gejalanya: pilih 7D/30D/60D/All,
  angka kartu Overview tidak berubah sama sekali.

  Diagnosis awal saya salah tiga kali berturut-turut (menyalahkan cache
  browser, cache HTML, lalu merge state). Yang membongkarnya adalah inspeksi
  **React fiber** di browser sungguhan: state React sudah BENAR
  (`period: "7d"`, `totalRequests: 10075`) sementara DOM tetap menampilkan
  `944` — jadi ada pihak lain yang menimpa DOM setelah React menulis.

  Penyebabnya `processTextNode()` di `src/i18n/runtime.js`:
  ```js
  if (!node._originalText) node._originalText = node.nodeValue;  // sekali, permanen
  const translated = translate(node._originalText);
  if (translated !== node.nodeValue) node.nodeValue = translated; // timpa!
  ```
  React memakai **ulang** text node saat re-render (hanya `nodeValue` yang
  berubah). Karena observer `characterData` (ditambahkan 0.5.111, adopsi
  upstream `910db749`) memanggil `processTextNode` pada SETIAP penulisan,
  setiap nilai baru hasil render React langsung ditimpa balik ke
  `_originalText` — nilai dari render pertama.

  Terbukti dengan uji langsung: menulis `"99999"` ke text node angka
  dikembalikan ke `"947"` dalam 3 detik; properti `_originalText: "947"`
  adalah jejaknya.

  Perbaikan: `_originalText` diperbarui saat React menulis ulang node, dan
  node yang **tidak punya terjemahan** tidak disentuh sama sekali — angka
  murni milik React. Terjemahan yang pernah kita tulis tetap bisa dipulihkan
  saat locale kembali ke `en`.

  Terukur sebelum/sesudah pada browser sungguhan (klik Today → 7D → 30D → All):
  | | Today | 7D | 30D | All |
  |---|---|---|---|---|
  | sebelum | 962 | 962 | 962 | 962 |
  | sesudah | 963 | 10.094 | 33.288 | 54.749 |

- **Usage: `.catch()` ganda membuat penanganan AbortError jadi kode mati.**
  `fetch(...).catch(() => {}).catch((e) => {...})` — catch pertama menelan
  semua error, sehingga catch kedua tidak pernah dijalankan. Digabung jadi
  satu; error non-Abort kini dicatat ke console.

## Catatan diagnostik (agar tidak terulang)
- `AbortController` ADA di dalam bundle TIDAK membuktikan fix terkirim —
  React/Next memakainya di banyak tempat. Verifikasi harus membaca kode di
  sekitar `fetch` yang dituju.
- Header `no-store` hanya berlaku untuk request SESUDAH perubahan; HTML lama
  yang sudah ter-cache tetap menyajikan nama chunk lama.
- `/api/usage/stats`, `/api/usage/chart`, dan `/api/usage/stream` adalah TIGA
  jalur data terpisah. Semuanya harus diperiksa, bukan hanya `stats`.

# v0.5.98 (2026-09-20) — 9router-imagefix

## Fixes
- **Antigravity: 503 kapasitas tidak lagi mengunci akun.** `503
  MODEL_CAPACITY_EXHAUSTED` ("No capacity available for model X on the server")
  adalah kondisi **HOST**, bukan kesalahan akun — akunnya sehat, Google hanya
  tidak punya ruang untuk model itu di host tersebut saat ini.

  Mengunci akun karenanya merugikan. Diukur 2026-09-20 pada pool ini:
  `gemini-3.8-flash` hanya **2/8 sukses di daily** sementara **kedua sandbox
  8/8**. Dengan perilaku lama, enam dari delapan akun ditandai tidak tersedia
  karena kondisi yang tidak mereka sebabkan.

  Sekarang: 503 kapasitas → **tidak mengunci**, serahkan ke rotasi host
  (503 sudah ada di `ANTIGRAVITY_TRANSIENT_STATUSES`), lalu fallback berganti
  akun dengan anggaran lock akun tetap utuh.

- **Default host diubah ke `all-hosts` (daily dulu, sandbox cadangan).**
  Versi 0.5.97 memakai `daily-only` sebagai default dengan alasan mengikuti
  9Router upstream dan CLIProxyAPI. Pengukuran hari ini menunjukkan itu keliru
  untuk pool ini: tanpa cadangan, `gemini-3.8-flash` gagal 6/8.

  `daily` tetap **selalu pertama** — sandbox hanya dicoba setelah daily
  menolak, bukan sebagai host utama. `daily-only` tetap tersedia di dropdown
  bagi yang lebih memilih menghindari sandbox sepenuhnya.

## Notes
- Rotasi host kini benar-benar maju. Bug `indexOf` di 0.5.97 sudah diperbaiki;
  verifikasi: daily → autopush → staging → null (sebelumnya selalu kembali ke
  daily).
- Dropdown host tetap berlaku tanpa restart.

## Tests
- 90/90 lintas 8 suite Antigravity. Test rotasi host menguji **kedua mode**
  eksplisit; test default mengunci urutan daily-first.
- Lint bersih, build terverifikasi (`Semua host (default)`,
  `no capacity on this host`, `isCapacity503` ada di bundle).

# v0.5.97 (2026-09-20) — 9router-imagefix

## Features
- **Antigravity: pilihan host lewat dashboard, default `Daily only`.** Sebelumnya
  host list di-hardcode ke tiga host (daily + 2 sandbox). Sekarang ada dropdown
  di **Providers → Antigravity → Host Antigravity**, tersimpan di settings, dan
  berlaku pada request berikutnya **tanpa restart**.

  Defaultnya **`Daily only`** — mengikuti perilaku 9Router upstream DAN
  CLIProxyAPI, yang keduanya memakai `daily` saja dan mengandalkan rotasi AKUN
  saat gagal, bukan rotasi host. Itu pilihan yang lebih aman karena host sandbox
  memberlakukan gerbang tambahan: request dengan project yang tidak dikenali
  ditolak `403 SUBSCRIPTION_REQUIRED (#3501)`, sementara `daily` menerimanya.

  Tiga pilihan:

  | mode | host |
  |---|---|
  | `Daily only` (default) | daily |
  | `Daily + Autopush` | daily, autopush-sandbox |
  | `Semua host` | daily, autopush-sandbox, staging-sandbox |

  Preset sandbox tetap disediakan karena kapasitas Google bergeser — pada
  2026-09-13 `daily` hanya 5% sukses untuk claude-opus sementara sandbox 100%.
  Kalau itu terjadi lagi, cukup ganti dropdown alih-alih menunggu rilis baru.

## Fixes
- **`getHostForEntitlementRetry` selalu salah jatuh ke host pertama.** Fungsi
  memakai `urls.indexOf(currentUrl)`, padahal `currentUrl` yang dikirim executor
  adalah URL PENUH (`host + /v1internal:streamGenerateContent?alt=sse`), jadi
  `indexOf` selalu `-1` dan fungsi mengembalikan `urls[0]`. Terlihat di log
  produksi sebagai `retrying on daily-cloudcode-pa.googleapis.com` berulang,
  bukan host berikutnya. Kini mencocokkan **origin**.

- **Test yang menutupi bug itu diperbaiki.** Versi lama memanggil fungsi dengan
  URL base (bukan URL penuh), jadi test lolos meski produksi rusak. Test baru
  membangun URL lewat `buildUrl()` persis seperti executor melakukannya.

## Notes
- `open-sse/` tetap standalone: executor tidak membaca settings sendiri, app yang
  mendorong mode host lewat `setAntigravityHostMode()`.
- `transport.baseUrls` di registry tetap memuat ketiga host sebagai daftar
  lengkap yang tersedia; executor yang menentukan mana yang dipakai.

## Tests
- 89/89 lintas 8 suite Antigravity. Test rotasi host kini menguji **kedua mode**
  secara eksplisit (default daily = tidak ada rotasi; mode sandbox = rotasi jalan).
- Lint bersih untuk file baru; 4 error lint di `page.js` sudah ada sebelumnya
  (diverifikasi dengan `git stash`).
- Build terverifikasi: `daily-only`, `antigravityHostMode`, `AntigravityHostCard`,
  dan `getActiveAntigravityHosts` semuanya ada di bundle.

# v0.5.96 (2026-09-20) — 9router-imagefix

## Fixes
- **Antigravity: 403 entitlement tidak lagi membakar 13-15 detik per akun, dan
  rotasi kini ke HOST bukan ke akun.** Log produksi menunjukkan tiap akun
  memakan 13-15 detik: refresh token (~1 detik, sia-sia — token-nya valid) lalu
  request ulang ke HOST YANG SAMA dan 403 lagi (~13 detik). Enam puluh akun ×
  ~30 detik = setengah jam untuk penolakan yang identik.

  Dua perbaikan:
  1. **Refresh token dilewati untuk 403 entitlement.** Google menjawab
     `403 SUBSCRIPTION_REQUIRED` (#3501) dengan token yang sah — me-refresh-nya
     tidak bisa mengubah hasil, hanya menambah latensi sebelum retry yang
     pasti sama. Body dideteksi dari `clone()` sehingga `parseUpstreamError()`
     di bawahnya tetap bisa membacanya.
  2. **Retry ke host berikutnya dengan AKUN YANG SAMA.** 403 entitlement
     adalah gerbang tingkat-HOST (sandbox menolak project yang tidak dikenali,
     sementara `daily` menerima request yang sama), bukan kesalahan akun.
     Menggilir 60 akun di host yang sama hanya mengulang penolakan identik;
     satu percobaan ke host berikutnya jauh lebih murah dan bisa berhasil.
     `403` tetap TIDAK memicu rotasi di loop internal executor, supaya
     perilaku 403 auth biasa (token mati) tidak berubah.

## Yang DIUJI dan GUGUR untuk 403 ini (jangan diulang)

Sebelas hipotesis diuji langsung ke Google, semuanya gagal mereproduksi 403:

- kuota habis — median `3p-weekly` **96% tersedia**, hanya 1 dari 61 akun di 0%
- 6 akun yang 429 di log — semuanya OK saat diuji ulang
- payload 0KB–188KB, tool 0–122, deskripsi tool 200B/800B
- burst 12 request berturut-turut, token baru di-refresh
- ketiga host untuk akun yang gagal
- **multi-turn tool call** (0/1/3/10/30 turn dengan functionCall+functionResponse),
  `toolConfig` VALIDATED/AUTO/omitted, thoughtSignature ada/tidak

Yang TETAP terkonfirmasi: gate kepemilikan project di host sandbox
(project asing → 403 dalam ~2,9 detik). Tapi 403 produksi memakan 13-15 detik,
jadi ia bukan gate cepat itu — penyebab pastinya **belum teridentifikasi**.
Perbaikan di rilis ini mengurangi kerusakan, bukan menyembuhkan.

## Tests
- 10 test di `unit/antigravity-project-isolation.test.js` (4 baru untuk rotasi host).
- 86/86 lintas 8 suite Antigravity, lint bersih, build terverifikasi.

# v0.5.95 (2026-09-20) — 9router-imagefix

## Fixes
- **Antigravity: 403 SUBSCRIPTION_REQUIRED (#3501) — akar masalah ditemukan
  dan diperbaiki.** Akun sehat di-lock 120s lalu seluruh pool di-walk satu per
  satu, semuanya gagal dengan "You do not have a valid license of this product".

  Penyebabnya: Google **menggerbangi host sandbox pada kepemilikan project**.
  Request yang membawa project bukan milik akun tersebut ditolak 403 #3501.
  Diukur langsung (2026-09-20):

  | host | project milik akun | project asing |
  |---|---|---|
  | `daily` | 200 | 200 |
  | `autopush` sandbox | 200 | **403 #3501** |
  | `staging` sandbox | 200 | **403 #3501** |

  Project asing itu berasal dari dua bug:
  1. `AntigravityExecutor` adalah singleton dan menyimpan project pertama yang
     dilihat ke `this.projectId`, lalu memakainya untuk **semua akun berikutnya**.
  2. `generateProjectId()` **mengarang** project acak (`bright-wave-ngqrb`) saat
     kredensial tidak punya project. Project karangan tidak sah untuk akun mana
     pun — diukur: project acak dan string kosong sama-sama 403 di sandbox.

  Karena `daily` dicoba lebih dulu dan berotasi saat kapasitas habis, project
  asing baru muncul setelah rotasi ke sandbox — itulah sebabnya gejalanya
  tampak seperti masalah host atau akun.

  Perbaikan: project kini di-resolve per-request dari kredensial akun yang
  sedang dilayani; project karangan dihapus dari ketiga jalur (executor + dua
  wrapper translator); `chat.js` mengulang resolve sekali lalu menolak dispatch
  dengan pesan jelas bila tetap gagal, alih-alih mengirim request tanpa
  identitas yang pasti ditolak.

- **Antigravity: 403 entitlement tidak lagi mematikan akun sehat.** Sebelumnya
  403 lisensi cocok dengan pola `/PERMISSION_DENIED/i` sehingga dihitung sebagai
  "akun mati" dan dialirkan ke domain breaker — berpotensi mem-bulk-disable
  seluruh domain (61 akun). Pola entitlement kini diperiksa lebih dulu dan
  mengembalikan `false`. Tiga pola terlalu luas juga dihapus: `/Bad Request/i`,
  `/401/i` (cocok dengan angka apa pun di body), dan `/unauthorized/i`
  dipersempit ke `/unauthorized_client/i`.

- **`verifyAccountsAlive` tidak lagi menilai kegagalan refresh sebagai kematian.**
  `refreshGoogleToken` mengembalikan `{error}` alih-alih melempar, sehingga
  `!refreshed?.accessToken` bernilai true untuk SETIAP kegagalan — termasuk error
  jaringan sesaat — dan akun sehat ditulis `isActive:false`. Klasifikasi kini tiga
  arah: terbukti hidup / terbukti mati / tidak dihakimi.

- **Ambang domain breaker memakai ukuran domain, bukan sisa aktif.** Dengan 59
  dari 61 sudah nonaktif, `total=2 < 3` memberi threshold=1 sehingga satu 403
  memicu sweep. Kini memakai ukuran domain + minimum absolut akun mati.

# v0.5.94 (2026-09-19) — 9router-imagefix

## Fixes
- **Antigravity: 60 akun sehat ikut dimatikan oleh domain breaker.** Breaker
  memutuskan siapa yang mati dari RASIO (≥30% akun satu domain gagal → seluruh
  domain di-bulk-disable), bukan dari verifikasi. Satu penjual mengirim DUA
  batch di domain yang sama: 60 akun yang sudah dihapus Google, dan 60 akun baru
  yang berfungsi. Batch mati melewati ambang 30%, lalu breaker menyapu
  keduanya — pool menyusut jadi 1 akun aktif dari 136.

  Rasio kini hanya jadi PEMICU ("domain ini layak diperiksa"). Yang menentukan
  siapa mati adalah Google, lewat `verifyAccountsAlive()` yang menukar refresh
  token tiap kandidat (probe termurah — tidak memakai kuota inference). Akun
  yang tidak bisa dihubungi (timeout, network error, 5xx) TIDAK dihakimi dan
  tetap aktif; kalau verifikasi sendiri gagal, tidak ada yang ditulis.

  Terverifikasi pada pool nyata: 63 kandidat diperiksa → 60 hidup (diaktifkan,
  pool 1 → 61 aktif), 3 mati dibiarkan nonaktif.

# v0.5.93 (2026-09-18) — 9router-imagefix

Re-publish dari v0.5.92 dengan isi identik: publish 0.5.92 sempat ditolak npm
dengan E409 ("Cannot publish over previously staged version"), jadi versi
dinaikkan ke 0.5.93 dan di-publish ulang. Keduanya ada di registry dengan
konten yang sama — **pakai 0.5.93** (`latest`).

## Fixes
- **Antigravity: 429 quota reset dibuang, akun mati diprobe ulang terus.** Google
  mengirim waktu reset presisi di body 429 — tiga cara sekaligus:

  ```json
  "message": "Individual quota reached. ... Resets in 149h50m20s.",
  "details": [
    { "@type": ".../google.rpc.ErrorInfo", "reason": "QUOTA_EXHAUSTED",
      "metadata": { "model": "gemini-3-flash-agent",
                    "quotaResetDelay": "149h50m20.179078308s",
                    "quotaResetTimeStamp": "2026-08-08T17:54:07Z" } },
    { "@type": ".../google.rpc.RetryInfo", "retryDelay": "539420.179078308s" }
  ]
  ```

  Kuota kembali **6,2 hari** lagi dan Google memberitahukannya tiga kali, tapi
  ketiganya dibuang sebelum sampai ke logika cooldown:

  1. `open-sse/utils/error.js` hanya mengambil `json.error.message` — `details`
     dibuang total.
  2. `open-sse/executors/antigravity.js` **tidak punya `parseError`**, jadi
     `resetsAtMs` tidak pernah terisi. Executor yang punya (`codex`,
     `gemini-cli`, `grok-cli`, `zed`, `commandcode`, `freebuff`) bekerja benar.
  3. Akibatnya cooldown jatuh ke backoff generik 2s → 30s, dan akun yang
     kuotanya kembali 6 hari lagi diprobe ulang tiap beberapa detik.

  Terukur di satu instalasi (PR #3012): **233 429 Antigravity dalam 22 jam
  @ ~16,4s = ~70 menit wall-clock mati**, semuanya probe ke akun yang sudah
  memberi tahu kapan mereka akan kembali.

  Perbaikan: helper baru `open-sse/utils/googleQuota.js` yang mem-parse keempat
  bentuk sinyal (timestamp ISO, Go duration, protobuf Duration, dan fallback
  dari teks pesan), `AntigravityExecutor.parseError()` yang memakainya, plus
  `parseUpstreamError()` kini meneruskan `resetsAtMs` bahkan tanpa override
  executor — supaya tidak ada provider yang diam-diam kehilangan sinyal ini.

- **Antigravity: kuota dihitung per-POOL, bukan per-model.** Semua model
  `gemini-*` berbagi satu pool, semua `claude-*`/`gpt-*` berbagi pool lain.
  Akun free-tier hanya melaporkan `gemini_weekly` dan `claude_gpt_weekly` —
  **tidak ada entri per-model sama sekali** — sehingga lookup
  `quotas[model]` yang persis selalu meleset dan pool yang habis terlihat
  "tidak diketahui". Perbaikan: `resolveQuotaForModel()` mencocokkan exact →
  bucket keluarga → nama bucket (`3p` untuk Claude/GPT), dan mengembalikan
  `undefined` (bukan menebak) bila tidak ada yang cocok.

- **`MAX_RATE_LIMIT_COOLDOWN_MS` dipotong dari 7 hari (dari 30 menit).**
  Reset kuota weekly free-tier memang berhari-hari; memotongnya ke 30 menit
  membuat akun mati diprobe tiap setengah jam sepanjang minggu. `lastError`
  yang tersimpan juga dinaikkan dari 100 → 300 karakter karena 100 memotong
  JSON Google di tengah dan dashboard kehilangan info pool mana yang habis.

## Yang TIDAK diadopsi
- **PR #3986** (`omit requestType:"agent"`) — klaimnya diuji ulang dengan beban
  ~25K token + 13 tool, 5× bergantian: DENGAN 3,0s (0/5 gagal) vs TANPA 2,2s
  (0/5 gagal). Selisih 6,6s vs 2,4s di percobaan pertama ternyata hanya warm-up
  koneksi. **Tidak tereproduksi** — tidak diterapkan.

## Tests
- `unit/antigravity-quota-pool.test.js` (5) + `unit/antigravity-quota-reset.test.js` (6).
- 31/31 lintas 5 suite Antigravity. 0 kegagalan terkait Antigravity di suite penuh.

# v0.5.91 (2026-09-18) — 9router-imagefix

## Fixes
- **OpenCode Free: gate keempat — tool quartet. `403 FreeTierError` masih
  berulang meski UA, session, dan streaming sudah benar.** Upstream
  mem-fingerprint klien agentik resmi lewat **empat tool pencarian berkas**.
  Request yang membawa 0–3 dari nama itu ditolak, bahkan ketika tiga gate
  lainnya sudah lolos. Bisection langsung ke
  `opencode.ai/zen/v1/chat/completions` (UA + session kanonik konstan):

  | permintaan | hasil |
  |---|---|
  | tanpa tools | 403 |
  | `tools: []` | 403 |
  | 3 dari 4 (`bash,glob,grep`) | 403 |
  | 10 nama palsu | 403 |
  | `{bash,glob,grep,read}` | **200** |
  | quartet + 5 nama palsu | **200** |
  | quartet + `edit,write,webfetch` | **200** |

  Perbaikan: `ensureFingerprintTools()` menyisipkan deklarasi yang belum ada
  sebagai no-op tool (model boleh mengabaikannya). Tool milik pemanggil
  dipertahankan apa adanya — hanya nama yang belum ada yang ditambahkan.
  Berlaku di kedua jalur: bentuk bersarang `function` untuk
  `/chat/completions`, dan bentuk datar untuk `/responses`.

  Ini kasus paling umum: klien chat biasa tidak mengirim tools sama sekali,
  jadi **setiap** request semacam itu 403 sebelum perbaikan ini.

## Verification (live, 2026-09-18)
```
tanpa tools klien   -> 200  tools=[bash,glob,grep,read]
mimo-v2.5-free      -> 200  tools=[bash,glob,grep,read]
ling-3.0-flash-fin  -> 200  tools=[bash,glob,grep,read]
+ 2 tool klien      -> 200  tools=[my_tool,bash,glob,grep,read]
```
Tool milik pemanggil tidak tertimpa (uji memastikan deskripsi asli bertahan).

## Tests
- 17/17 `executor-const-guard` (3 test gate baru), 29/29 lintas 3 suite
  OpenCode. 0 kegagalan terkait OpenCode di seluruh suite.

## Catatan
Dua PR upstream ditinjau sebagai rujukan: #4128 (UA + session) dan #4132
(quartet + streaming). #4132 **tidak dapat diterapkan apa adanya** — ia
mengimpor `clampResponsesCallId`, `coerceResponsesArguments`, dan
`coerceResponsesOutput` dari `translator/formats/responsesApi.js`, tetapi
ketiga helper itu tidak ada di repo dan PR tersebut tidak menambahkannya.
Hanya gate quartet yang diadopsi di sini, karena itulah satu-satunya bagian
yang terbukti berpengaruh lewat pengujian langsung.

# v0.5.90 (2026-09-17) — 9router-imagefix

## Fixes
- **OpenCode Free: setiap request dijawab `403 FreeTierError`.** Upstream menolak
  dengan `{"type":"FreeTierError","message":"OpenCode's free tier can only be
  used from within OpenCode"}` karena fingerprint yang dikirim bukan milik klien
  OpenCode. Tiga bug bertumpuk:

  1. **Session ID tidak kanonik (penyebab utama).** `resolveOpencodeSession()`
     memanggil `resolveSessionId({ …, generate: generateSessionId })`, tetapi
     `resolveSessionIdentity()` di `sessionManager.js` TIDAK punya parameter
     `generate` — opsi itu diabaikan diam-diam dan jatuh ke `deriveSessionId()`
     yang mengembalikan `randomUUID() + Date.now()`. Nilai mentah itu dikirim
     sebagai `x-opencode-session`, padahal upstream memvalidasi BENTUKnya:
     `ses_` + 12 hex + 14 Base62 (30 char), bukan sekadar keberadaan header.

     ```
     dikirim   : 28db8664-ce59-4301-bc4d-81d16eff87121789652009205  (49 char)
     dibutuhkan: ses_ + 12 hex + 14 Base62                          (30 char)
     ```

  2. **User-Agent tanpa versi.** `OPENCODE_UA` bernilai `"opencode"`; upstream
     mensyaratkan build `>= 1.17.0`. Diganti ke fingerprint resmi
     `opencode/1.18.31 ai-sdk/provider-utils/4.0.46 runtime/bun/1.3.14`, dan UA
     dari klien hanya diteruskan bila versinya valid.

  3. **`xhigh` di-clamp turun ke `high`.** `normalizeOpenAILevel()` di
     `thinkingUnified.js` menyatukan `max`/`ultra`/`xhigh` dalam satu cabang dan
     mengembalikan `high`. Karena `xhigh` ADA di `supportedLevels` Muse Spark,
     level tertinggi hilang dan request "max" berakhir di `high`.

  Perbaikan: generator ID kanonik (mengikuti implementasi referensi Go),
  `translateSessionId()` deterministik agar percakapan multi-turn tetap dalam
  satu sesi, UA berversi + validasi, dan cabang clamp `xhigh` diperbaiki.

- **OpenCode Free: request non-streaming dijawab `403 FreeTierError`.** Free tier
  hanya menerima **streaming**. Diuji langsung ke endpoint mentah memakai header
  kanonik (bukan lewat executor), hasilnya konsisten di semua model free:

  | permintaan | hasil |
  |---|---|
  | `stream:true` + `Accept: text/event-stream` | 200 |
  | `stream:false` + `Accept: */*` | 403 |
  | `stream:false` + `Accept: text/event-stream` | 403 |
  | tanpa `stream` di body | 403 |

  Perbaikan: executor selalu mengirim `stream:true`, dan registry diberi
  `forceStream: true` supaya `chatCore` melayani klien yang meminta JSON lewat
  `handleForcedSSEToJson` (upstream tetap SSE, klien tetap menerima JSON).

- **OpenCode: `muse-spark-1.3` tidak pernah ter-routing ke `/responses`.**
  `RESPONSES_MODELS` adalah `Set` berisi id persis, sehingga varian baru
  (`muse-spark-1.3`, `muse-spark-1.3-contributor-free`) jatuh ke
  `/chat/completions` dan ditolak. Kini pencocokan berbasis keluarga
  (`RESPONSES_MODEL_FAMILIES`) sehingga varian berikutnya ikut benar tanpa
  mengubah executor, dan `muse-spark-1.3-contributor-free` didaftarkan di
  registry.

- **OpenCode Responses: kontinuitas & level thinking tidak dinormalisasi.**
  Item `type:"reasoning"` dari turn sebelumnya dan `encrypted_content` /
  `reasoning_encrypted_content` kini dibuang; `muse-spark-1.3` dipaksa
  `tool_choice:"auto"`; cap output dipetakan ke `max_output_tokens`.

## Verification (live, 2026-09-17)
Set minimal header yang menentukan diisolasi satu per satu terhadap
`opencode.ai` — hanya **UA berversi + session ID kanonik** yang esensial;
`x-opencode-client`, `x-opencode-project`, dan `x-api-key` tidak berpengaruh:

```
                        SEBELUM   SESUDAH
big-pickle (chat)       403   →   200  {"object":"chat.completion.chunk", …}
mimo-v2.5-free (chat)   403   →   200
ling-3.0-flash-fin-free 403   →   200
nemotron-3-ultra-free   403   →   200
muse-spark-1.3 (resp)   403   →   200  reasoning.effort:"xhigh"
```
Alur end-to-end lewat executor (bukan header buatan tangan) juga 7/7 `200`:
tanpa header klien, UA `curl/8.0`, UA `opencode` tanpa versi, session non-kanonik,
`x-opencode-project: global`, seluruh header asing sekaligus, dan model
non-Responses.
Skema klien pihak ketiga yang sebelumnya gagal (UA `curl/8.0`, session asing,
`x-opencode-project: global`, atau seluruh header asing sekaligus) kini
semuanya `200`.

## Tests
- 87/87 lulus pada `opencode-muse-spark-thinking`, `executor-const-guard`,
  `opencode-go-models`, `thinking-unified`, `thinking-effort-openai-max-clamp`.
- 0 kegagalan terkait OpenCode di seluruh suite; 11 test yang tadinya gagal di
  baseline ikut lolos.

# v0.5.89 (2026-09-13) — 9router-imagefix

## Fixes
- **Freebuff: executor tidak terdaftar — chat selalu ditolak.** Saat provider
  Freebuff diadopsi, `open-sse/executors/freebuff.js` ikut dicopy tetapi TIDAK
  pernah diimpor/didaftarkan di `open-sse/executors/index.js`. Akibatnya
  `getExecutor("freebuff")` mengembalikan `DefaultExecutor` yang tidak tahu
  apa-apa soal protokol Freebuff, dan setiap chat dijawab
  `400 "No runId found in request body"`.

  Freebuff punya TIGA gate server-side yang wajib dilewati:
  1. **Sesi** — `POST /api/v1/freebuff/session` + header `x-freebuff-model`
  2. **Agent run** — `POST /api/v1/agent-runs {action:"START", agentId}` →
     `runId` asli. `run_id` BUKAN uuid bebas; backend me-resolve-nya ke
     agent-run store dan menolak id tak dikenal dengan `400 "runId Not Found"`.
  3. **System marker** — gate `free_mode_cli_required`: pesan system PERTAMA
     wajib dibuka salah satu pembuka kanonik
     (`"You are Buffy, the strategic coding assistant."`) — uji prefix
     byte-exact di posisi 0.

  Ditambah gate `foreign_toolset`: request bertools wajib menyertakan tool
  `end_turn`, atau router menjawab `404 "No endpoints found"`.

  Perbaikan: daftarkan `FreebuffExecutor` untuk provider `freebuff` + alias `fb`.

## Verification (live, 2026-09-13)
Login device-flow berhasil (`toa7@gsuii.com`, tier `limited`, country `ID`),
lalu 3 gate dilewati berurutan:
```
1. sesi   : active  tier=limited  country=ID  instanceId=cda2449c-...
2. runId  : 2b02c9ed-e64d-4a63-98d6-720b390719c1
3. chat   : [200] 2.7s -> 'OK'
```
`--quota` (GET, tidak membakar kuota): 25 Freebucks, reset 2026-09-14 07:00.

## Tests
- 67/67 test Freebuff lulus (`freebuff-provider`, `freebuff-usage`,
  `freebuff-model-assignment`).

# v0.5.88 (2026-09-13) — 9router-imagefix

## Fixes
- **Antigravity: rotation across capacity pools per host.** Google runs a
  SEPARATE capacity pool per Cloud Code host. When `daily` exhausts capacity
  for a model it answers `503 {"error":{"message":"No capacity available for
  model claude-opus-4-6-thinking on the server."}}` while the sandbox hosts are
  still full. Measured live 2026-09-13 across 40 accounts on
  `claude-opus-4-6-thinking`:

  | host | success |
  |---|---|
  | `daily-cloudcode-pa.googleapis.com` | 5% |
  | `autopush-cloudcode-pa.sandbox.googleapis.com` | 100% |
  | `staging-cloudcode-pa.sandbox.googleapis.com` | 100% |

  `AntigravityExecutor.shouldRetry` now rotates to the next host on transient
  statuses (500/502/503/504) in addition to the pre-existing 429 rule, and
  `transport.baseUrls` lists `daily` first (used while healthy) followed by the
  two sandbox pools as capacity fallbacks. Verified end-to-end through the real
  executor: `daily` (forced 503) → `autopush-sandbox` → HTTP 200.

  This makes Claude Opus 4.6 Thinking usable again across large account pools:
  before, only 1 of 61 accounts could reach it (5/50 in a 50-account probe);
  after, 50/50 succeed (45 of them via host rotation).

- **Antigravity: no same-host retries for capacity errors.** `500`/`503`
  retry `attempts` dropped from 3 to 0. A host that ran out of capacity does
  not recover within seconds, so retrying it only burned the 2s+4s+8s backoff
  before rotating anyway — now the executor moves straight to the next host.
  `429` was already `attempts: 0` (fail fast so chatCore rotates accounts).

## Tests
- New `tests/unit/antigravity-capacity-rotation.test.js` — drives the REAL
  executor with a mocked `proxyAwareFetch` (no network): asserts host rotation
  on 503, no rotation on permanent errors (400/401/403), and a hard stop at the
  last host.
- `tests/unit/antigravity-retry-hook.test.js` — covers the new host list and
  the rotation rules.
- `tests/unit/executor-const-guard.test.js`, `tests/unit/gemini-36-integration.test.js`
  — updated to the new host list / retry values.
- `tests/unit/antigravity-usage-headers.test.js` — reads the user agent from
  `ANTIGRAVITY_IDE_USER_AGENT` instead of a hardcoded version, so version bumps
  no longer break it.
- `tests/__baseline__/verify-no-regression.mjs` — resolves repo-relative test
  paths on Windows (the old `/app/` split only worked in the Docker CI layout).

# v0.5.87 (2026-09-13) — 9router-imagefix

## Features
- **Freebuff**: new provider — free, ad-supported coding agent by Codebuff
  (`freebuff.com`). Fingerprint device-flow login, 7 models (GLM 5.3 Flash,
  DeepSeek V4.1 Flash, GPT-5.6 Luna, MiMo 2.5, Solar Pro 4, Muse Spark 1.2,
  Claude Fable 5 limited). Freebucks session pricing is server-authoritative —
  the daily pool is read via `GET /api/v1/freebuff/session` (never POST, which
  would claim a session and burn quota). 403 `country_blocked` is surfaced as a
  region message rather than a re-login hint.
- **Freebuff**: strict model assignment — one account binds ONE model per
  session (a different model returns `409 model_locked`). The per-provider
  `strictModelAssignment` toggle restricts account selection to accounts whose
  `freebuffModel` matches the requested model; unassigned accounts are
  excluded while the toggle is on.
- **Freebuff**: pool-fitness registry — an executor that learns a proxy pool's
  egress is unfit for a provider/model marks it here, and the pool picker skips
  that pool for the scope until the cooldown expires. Advisory and fail-open.
- **Cline**: 6 free-tier models (billed $0, quota separate from ClinePass) —
  Muse Spark 1.3, DeepSeek V4 Flash, GLM 5.3 Flash, Solar Pro 4, LongCat 2.0,
  Laguna S 2.1. The `cline-free/*` aliases require Cline product headers or
  upstream 403s with "only available via Cline product surfaces".
- **Cline**: API-key authentication alongside OAuth (dual auth). API keys ride
  plain `Bearer sk_*`; OAuth access tokens carry the WorkOS `workos:` prefix —
  a single merged token cannot express both.

## Fixes
- **Auth**: Freebucks exhaustion is a hard stop until the daily Pacific reset
  (up to ~24h) — the account is skipped for the day instead of being re-poked
  every 30 min. Guarded at 26h so a bad server value cannot lock forever.
- **Executor**: `preserveHookAuth` descriptor flag — a header hook may own the
  `Authorization` value instead of the merged token (required by Cline's
  dual-auth shape).
- **Executor**: gateway envelopes wrapping an OpenAI Chat Completions body in a
  `data` field (Cline: `{data, success}`) are unwrapped after logging and before
  usage extraction, so choices/usage resolve downstream instead of surfacing as
  "no completion choices". Generic guard, no provider hardcode.
- **Chat**: carry the executor's own status (429/409 quota gates) when it throws
  one, so combo/account fallback triggers instead of a generic 502.
- **Models**: capabilities for Upstage Solar Pro and LongCat (200K context /
  32K output), placed before the o-series catch-alls since "solar-pro4"
  contains "o4".
- **Usage**: Freebucks daily pool is folded under each priced model row, with
  the server's announced `priceChanges` schedule applied so promos expire and
  revert on the server's timeline with no client release.

## Notes
- Harvest helper: `add-account-freebuff-9router.py` (device-flow add, quota
  check, model assignment, diagnostics).
- Freebuff binds one account to one model — use a separate account per model,
  or wait for the session to expire.

---

# v0.5.79 (2026-09-10) — 9router-imagefix

## Fixes
- **Cerebras**: automatically strip unsupported `store` parameter — prevents `400 wrong_api_format: store: property 'store' is unsupported` when clients like OMP / OpenAI SDKs pass `store: false` or `store: true`.

# v0.5.78 (2026-09-10) — 9router-imagefix

## Fixes
- **ProxyFetch**: remove Google Cloud Code APIs (`cloudcode-pa.googleapis.com` / `daily-cloudcode-pa.googleapis.com`) from manual socket MITM bypass — route directly through undici keep-alive dispatcher pool to eliminate `ETIMEDOUT 172.217.114.4:443` connect timeouts and 90s connection lag.
- **ProxyFetch**: add 8s fail-fast socket connection timeout for any remaining manual bypass hosts to prevent hanging requests.

# v0.5.77 (2026-09-10) — 9router-imagefix

## Features
- **Usage**: add Export & Import backup buttons to Usage & Analytics dashboard —
  easily download full usage history, daily aggregates, and lifetime counters to JSON,
  or import and merge backup files across different machines for seamless token tracking continuity.

# v0.5.76 (2026-09-10) — 9router-imagefix

## Features
- **Usage**: real-time dynamic sync for all periods (Today, 24h, 7D, 30D, 60D, All) —
  stream endpoint now accepts the active period and pushes full real-time updates
  (requests, tokens, cost, tables) as new requests complete, eliminating manual page refresh.

# v0.5.75 (2026-09-10) — 9router-imagefix

## Fixes
- **Antigravity**: auto-detect permanent 401 auth failures and trigger domain breaker immediately —
  treat HTTP 401 on Google Cloud Code endpoint as permanent failure, return invalid_grant
  on token refresh failure, and bulk-disable dead GSuite domains immediately.

# v0.5.74 (2026-09-08) — 9router-imagefix

## Features
- **Usage**: add "All" (All-Time) period option to dashboard and API — view total
  tokens, requests, costs, and timeline chart without the 60-day limitation.

# v0.5.71 (2026-08-31) — 9router-imagefix

## Features
- **Antigravity**: dynamic domain circuit breaker — bulk-disable ANY GSuite
  domain that returns permanent 400/401/403 (invalid_grant / PERMISSION_DENIED
  / deleted by admin) after 2 failures. Handles gmilil.my.id today and any
  future random domain (e.g. gmosel.com) without a hard-coded list.
  Whitelists gmail.com/googlemail.com. Skips a dead domain in < 50 ms
  instead of trying every account one-by-one (was 60-80s for 40 accounts).

# v0.5.70 (2026-08-30) — 9router-imagefix

## Fixes
- **Cerebras**: strip `reasoning_content` from assistant message history —
  Cerebras rejects `messages.N.assistant.reasoning_content` with `400 wrong_api_format`
  during multi-turn conversations in Claude Code and OpenCode.

# v0.5.69 (2026-08-30) — 9router-imagefix

## Fixes
- **Cerebras**: clamp `reasoning_effort` to `none|low|medium|high` — upstream
  rejects `xhigh|max|minimal|ultra` with `400 wrong_api_format`. New levels
  are clamped to `high` and the picker no longer offers unsupported values
  (`thinkingLevels.js` + `thinkingUnified.js`)

# v0.5.59 (2026-08-29)

## Features
- **Search**: new web search providers — Antigravity (Google Search grounding
  on the existing OAuth account pool, citations keyed and merged by URL) and
  Xquik (X search with `x-api-key` auth, cursor pagination, credit-based
  usage), both on `POST /v1/search`. Based on #3437 by @Nautilaceae
- **Search**: ollama-search and zai-search borrow a chat provider's API key
  instead of requiring their own connection, driven by a new
  `credentialFallback` registry field. zai-search later folded into the `glm`
  provider itself so the web search page shows the shared connection
- **Models**: daily background sync of model capabilities from models.dev —
  modalities keyed by model id (majority of sources must declare one),
  context/output limits keyed by provider + model, strictly additive and
  sitting below the hand-written tables. ETag + mtime cache, 60s startup
  delay, `MODEL_CATALOG_SYNC=off` to disable
- **Models**: add GLM-5.3-Flash (1M context, natively multimodal), DeepSeek
  V4 Vision, Grok 4.5/4.6 (500k context); correct glm-4.6v/4.5v video input
  and output limits, backfill glm-4.6v on glm-cn
- **Usage**: show the Zed plan quota on the dashboard — plan, edit
  predictions, hosted model requests and billing-cycle reset; unlimited rows
  render as "N used · Unlimited"
- **Usage**: track GPT-5.3-Codex-Spark quota windows (spark_session /
  spark_weekly) from the Codex usage response (#3431)
- **Antigravity**: quota-aware routing — on 409/429 fetch live quota for the
  exact per-model resetAt and skip only the exhausted account/model pair;
  report the earliest reset when every account is blocked (#3561)
- **Antigravity**: map image `size` to the aspect-ratio model suffix (-WxH);
  add the Gemini 3.7 Flash tiers to MITM defaultModels so they show up in
  the dashboard model-mapping table
- **Dashboard**: bulk import Grok CLI accounts from JSON — paste an array or
  drag-drop multiple .json files, all OAuth connections created in a single
  call, mirroring the codex flow
- **CLI tools**: endpoint presets shared across every tool card through one
  live-resyncing store, instead of per-card localStorage copies that never
  saw each other's saved endpoints
- **Token Saver**: configurable compression timeout (`headroomTimeoutMs`) —
  the fixed 3000 ms made busy machines time out and send inconsistently
  compressed bodies, hurting prompt caching
- **i18n**: pt-BR expanded to 1132 terms

## Fixes
- **Claude Code**: add Claude Fable 5.1 and advertise Claude Code 2.1.258 in
  both the request header and billing identity; use its permanent adaptive-thinking
  mode with `output_config.effort`
- **Stream**: record usage when a client closes on the terminal event — the
  Responses API has no [DONE] sentinel, so codex closed the socket on
  `response.completed` and cancelled the reader before flush() ran its usage
  side effects; the tail now lives in a once-guarded finalizeStream(). Also
  stop logging a disconnect for every completed Responses call
- **Stream**: parse the trailing NDJSON line an Ollama stream leaves behind
  without a closing newline — the final chunk carrying `done_reason` and the
  token counts was dropped
- **Session**: read the Claude Code session id from the
  `x-claude-code-session-id` header — `metadata.user_id` is dropped by
  Responses translation, splitting one conversation across several
  `prompt_cache_key` values and missing the upstream prefix cache
- **Usage**: preserve nested `cached_tokens` — the top-level-only read
  persisted `cached_tokens: 0` for every Responses-format provider (codex,
  grok-cli, …), billing cache hits at the full input rate
- **Usage**: GLM quotas accept CREDIT_LIMIT plans and multi-interval windows
  (5h session / 7d weekly) instead of overwriting a single "session" key
- **Models**: the catalog sync no longer erases its own output — deltas were
  measured against the previous run's writes (the second run cut `providers`
  from 20 entries to 5); one vote per provider in the modality tally, ETag
  restored from file on startup, and the worker thread dropped after the
  bundler rewrote its path into a module-not-found error
- **Executor**: CommandCode returns errors as a `type:"error"` event inside
  an HTTP 200 NDJSON stream — peek the first events before committing, abort
  and return a real 4xx/5xx so combo/account fallback triggers instead of
  streaming the error text as content
- **Search**: scope failure locks on the credential-fallback path — a failing
  search locked `modelLock___all` and took the shared glm key offline for
  chat as well; locks are now attributed to the connection's owner and
  scoped to `websearch:<provider>`
- **Providers**: connection tests get a 15s AbortSignal timeout instead of
  hanging and exhausting the browser socket pool; guard undefined provider
  names on the providers page
- **Antigravity**: sanitize competing-client branding via a config-driven
  rule table (Zed's Claude-agent prompt, opencode → antigravity) — upstream
  answers 429 Quota Exhausted. Applied in the executor so the shared
  openai-to-gemini translator leaves gemini/vertex/zed untouched
- **MiniMax**: preserve images on the sourceFormat-matched OpenAI transport
  — MiniMax-M3 resolved a Claude-shaped body posted to the OpenAI endpoint,
  silently dropping `image_url` blocks (#3418)
- **Claude**: decloak tool names in same-format streaming passthrough —
  OAuth-cloaked names (CLAUDE_TOOL_SUFFIX) leaked to the client and every
  tool call was rejected as unknown
- **Tools**: default a missing `tools[].type` to "custom" on Claude-format
  requests — strict Anthropic-compatible gateways (MiniMax) reject the
  request with 400 otherwise
- **Translator**: zai thinkingFormat sends the top-level `reasoning_effort`
  object GLM-5.2+ requires — every GLM-5.x request ran at the model default
  (max); gated on GLM-5.2+ since older GLM does not read it (#2721)
- **RTK**: system prompt injection matches each target wire format
  (Chat/Responses/Claude/Gemini/Kiro) and is exact-idempotent across retries,
  so distinct prompts sharing a long prefix are no longer collapsed (#3202).
  Also set the diagnostic before the silent null return on Responses
  translation failure so the panel is no longer blank
- **OpenCode**: route muse-spark through /zen/v1/responses (it 500s on
  chat/completions), normalizing the Chat fields the Responses API rejects
  and clamping max/ultra effort to xhigh
- **CLI**: install better-sqlite3 without build tools on Node 22+ (N-API
  13.0.3 ships per-platform prebuilds, `--ignore-scripts` skips the implicit
  node-gyp build); Node < 22 stays on 12.6.2, working installs untouched
- **CLI tools**: send the API key Codex actually reads —
  `[model_providers.9router.http_headers]` instead of auth.json (which left
  every request 401 and clobbered an existing ChatGPT login); subagent model
  moved to `agents.default_subagent_model`
- **OAuth**: refresh Cline tokens with the extension JSON contract
- **Dashboard**: clamp the API key mask length — keys shorter than 8 chars
  threw RangeError and crashed the media-provider detail page
- **UI**: wait for the Material Symbols font itself before revealing icons —
  `document.fonts.ready` resolved before the 4MB woff2 even started loading,
  leaving icons blank until a second load

# v0.5.55 (2026-08-14)

## Features
- **Auth**: native SAML 2.0 SSO alongside OIDC — AuthnRequest generation, ACS
  assertion handling, SP metadata export, admin config test, replay-protected
  via a `saml_state` cookie matched against `InResponseTo`
- **Providers**: add Alibaba Token Plan (`token-plan.ap-southeast-1`) — the
  fourth Alibaba key type, Singapore-only and OpenAI-compatible transport only
- **Providers**: add `glm-5.3` to GLM Coding and GLM (China)
- **Providers**: Kimchi accepts API keys as well as OAuth (dual auth), with a
  working Test Connection for both modes
- **Antigravity**: add Gemini 3.7 Flash and its tiered high/medium/low variants
  (also in the Gemini registry) with pricing and quota tracking
- **TTS**: add Fish Audio — model id travels in an HTTP `model` header, voice
  is a `reference_id` (preset or cloned voice model)
- **OpenCode-Go**: route by request format via declared transports instead of
  forcing every client into `/messages` — Codex/OpenAI clients no longer pay a
  lossy Responses→OpenAI→Claude double translation. Per-model `supportedFormats`
  guard; the bespoke executor is gone (its shared `_lastModel` cache could cross
  auth headers between concurrent requests)
- **Usage**: dedup + cache Claude quota calls (120s TTL keyed by access token,
  in-flight promise dedup, last-good read on soft failure) to stop multiple
  tabs tripping 429; manual refresh (↻) sends `force=1` to bypass the cache

## Fixes
- **Docker**: ship `sql.js` in the image so the pure-JS DB fallback can start —
  file tracing carried the package's JS without `dist/sql-wasm.wasm`, so a
  container with no native driver aborted with ENOENT and never got a database
  (#3248)
- **Usage**: read Gemini `usageMetadata` out of the antigravity `{ response }`
  envelope — every non-streaming antigravity request logged `IN 0 | OUT 0`
  (#3260)
- **Claude**: re-anchor passthrough cache breakpoints — the client's own
  `cache_control` markers point at pre-normalization offsets, so the tail was
  re-cached every request. Last system block and last tool pinned at 1h TTL,
  last assistant turn at 5m, mid-conversation system messages folded into the
  neighbouring user turn instead of hoisted into `body.system`
- **Combos**: detect images from Hermes and attachment payloads (`images[]`,
  `experimental_attachments`, message-level `image_url`/`audio_url`, inline
  `data:` URIs) so the Vision Adapter auto-switch fires for Hermes/Ollama/
  Vercel AI SDK shapes
- **Kiro**: intercept chat via `x-amz-target` — Kiro IDE 1.0.228+ moved
  `GenerateAssistantResponse` to `POST /` + header, bypassing MITM. Also emit
  the now-mandatory initial-response frame and map the `auto` model slot
- **Kiro**: report real output tokens and stop discarding usable turns
- **Qoder**: detect billing blocks at stream start and return a synthetic 403
  so combo/account fallback triggers instead of leaking the error into chat
- **Antigravity**: strip competitive system prompts (Zed IDE's Claude-agent
  prompt) that Antigravity flags with a 429 Quota Exhausted
- **OpenCode**: send the official client fingerprint on free-tier requests so
  the Console stops classifying traffic as unidentified and rate-limiting it;
  session id resolves conversation-stable to preserve prompt caching
- **Responses**: don't close the message on an empty `tool_calls` array — some
  providers attach one to every chunk, and the truthy check ended the message
  on the first content token (#3234)
- **Translator**: preserve `prompt_cache_key` when converting chat to responses
- **Models**: expose snake_case token limits on `/v1/models`
- **Combos**: strip `stream_options` from the Fusion panel fan-out to avoid a
  DeepSeek 400 (#3024); raise the dashboard model-test probe budget to 1024 and
  soft-pass reasoning-only responses (#3010)
- **Headroom**: the toggle reflects the `headroomEnabled` setting even when the
  proxy is down — it previously showed OFF while the engine kept calling
  `/v1/compress`; proxy status stays visible via the status chip
- **Hermes**: add the `api_key` parameter to the model block in YAML config
- **Providers**: add llm7 to provider test support

## Docs
- **i18n**: add Spanish, French, and Brazilian Portuguese README translations

## Security
- **Real IP**: `x-9r-real-ip` and the Host fallback were trusted from
  client-controlled headers whenever `custom-server.js` was not in the request
  path (`npm run start`, `start:bun`), letting a remote caller pose as local to
  skip API key auth and reach `LOCAL_ONLY_PATHS` (`/api/mcp/*`,
  `/api/tunnel/enable`, `/api/auth/reset-password`). The server now stamps a
  per-process `x-9r-peer-token` on every request it sanitizes and only trusts
  `x-9r-real-ip` behind it — falling back to Host in development and failing
  closed in production (GHSA-pjm4-8fpg-f9p6). Also fixes IPv6 loopback
  detection (`::1`, `::ffff:127.0.0.1`) and routes `npm run start` /
  `start:bun` through `custom-server.js`
- **Search**: `resolveBaseUrl()` rejects client-supplied non-public baseUrls
  (SSRF guard on `/v1/search`)
- **Login**: fresh-install remote login with the default password returns 403
  without issuing a JWT
- **Usage**: `/api/usage/request-details` redacts request/response payloads

# v0.5.50 (2026-08-05)

## Features
- **Providers**: add TokenRouter (300+ models via OpenAI-compatible gateway) with
  exact per-model pricing for 110 models and `reasoning_effort` thinking config
- **Providers**: add Self-hosted STT / TTS / Embedding — point 9Router at your own
  OpenAI-compatible speech and embedding servers (whisper.cpp, faster-whisper,
  Kokoro-FastAPI, llama-server, vLLM, Infinity). Unlike the named cloud providers
  these read `baseUrl` per connection, so one provider can front several machines
- **Combos**: default-enable vision/audio capacity adapter (auto-routes to a
  vision/audio-capable model when the target lacks that capability, falling back
  to `oc/mimo-v2.5-free`), wired into chat handler routing
- **Endpoint**: auto-provision a "Default Key" for first-time users so `/v1`
  works without a manual dashboard step
- **Codex**: support GPT-5.6 Max/Ultra reasoning-level overrides (cx/ routes only)
- **Qoder**: support PAT (Personal Access Token) connections end-to-end, alongside
  OAuth device flow
- **CLI tools**: add OpenDesign (manalkaff/opendesign) support
- **Headroom**: report effective payload savings (tool schema/history bytes broken
  out, byte-savings % reflects actual outbound reduction)
- **Ollama**: Cloud quota tracker (session + weekly) + proactive background OAuth
  token refresh scheduler for all providers

## Fixes
- **Providers**: remove Qwen (OAuth flow stopped working reliably)
- **Passthrough**: detect codex-tui/Codex Desktop as native Codex client — they
  were falling through to the translator and losing fields like `reasoning.summary`
- **OAuth**: scope antigravity header fixes to loadCodeAssist/onboardUser only
- **OAuth**: keep `open` external in the build so xAI/Grok token refresh works on
  Windows
- **OAuth**: declare missing `searchParams` in register-session handler (was a
  500 instead of JSON on error)
- **DB**: `ENABLE_REQUEST_LOGS` env var now overrides the UI setting correctly;
  observability defaults to off (opt-in)
- **Translator**: preserve Codex Responses Lite tool use across chat-native
  OpenAI-compatible providers
- **Translator**: don't drop image-only user messages in `prepareClaudeRequest`
- **Translator**: drop JSON Schema keywords Gemini rejects (`uniqueItems`,
  `contains`, `multipleOf`, `unevaluatedProperties`, `unevaluatedItems`,
  `contentSchema`)
- **Claude**: remove global header cache that leaked one client's identity
  headers onto another client/account sharing the server; gate `anthropic-beta`
  by model instead
- **Antigravity**: drop retired Gemini 3.0 quota tiers, show Gemini 3.6 Flash
  usage bars
- **Cloudflare AI**: declare API key authentication (dashboard showed "No
  connections" despite an active key)
- **GitHub Copilot**: hold monthly-exhausted accounts until UTC month reset
  instead of only cooling down 120s
- **CodeBuddy**: dodge Tencent CN content filter, add usage tracking, normalize
  codebuddy-intl messages
- **Usage**: stop losing cached prompt tokens in the forced-SSE→JSON path
- **Grok CLI**: display the public subscription tier from the OAuth token claim
- **Providers**: count apikey connections for Ollama free-tier card; free-tier/
  apikey providers without `authModes` now default to apikey (were treated
  oauth-only)
- **Build**: include static/public assets in standalone output (login page hung
  on 404s when run via PM2)
- **Server**: support IntelliJ IDEA OpenAI-compatible clients over HTTP (h2c
  upgrade handling)
- **Auth**: redirect already-logged-in sessions away from `/login`
- **CLI tools**: enable Apply button for dynamic OpenAI/Anthropic-compatible
  provider connections
- **CLI**: include complete API artifacts in the CLI package
- **TTS**: a bare self-hosted model name is the MODEL, not the voice — `kokoro`
  was parsed as a voice against a default model, 404ing or synthesising with the
  wrong one
- **Embeddings**: self-hosted embeddings no longer fall back to `api.openai.com`
  when a connection has no `baseUrl` — that silently sent the input text and API
  key to OpenAI under a provider named "Self-hosted"
- **Embeddings**: an adapter that rejects a misconfigured connection now returns
  400 with the reason instead of escaping the handler uncaught
- **Embeddings**: bound the upstream fetch with `FETCH_CONNECT_TIMEOUT_MS` — an
  endpoint that drops packets never returns headers, so the request previously
  hung indefinitely

## Docs
- **i18n**: fix port typo, add RTK Token Saver feature descriptions

# v0.5.45 (2026-07-30)

## Features
- **TTS**: add Xiaomi MiMo text-to-speech (preset voices 冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean, style control, language hint dropdown with Auto-detect, i18n for Style label/placeholder)
- **Providers**: add Poolside (OpenAI-compatible)
- **Providers**: add api-airforce, baidu, bazaarlink, bluesminds, kilo-gateway, llm7, morph, sambanova, tencent
- **OAuth**: zed / trae / windsurf providers + harden callback proxies
- **CLI tools**: set Claude Code max context tokens
- **Qoder**: PAT auth + refresh model list
- **Gemini**: Gemini 3.6 Flash tier routing + Gemini 3.5 Flash Lite
- **Claude**: bump default Opus to `claude-opus-5`
- **Kiro**: add Claude Opus 5 models
- **Usage**: Kimi and DeepSeek usage handlers
- **Usage**: SuperGrok weekly pool via gRPC-web

## Fixes
- **Refresh**: rotate `refresh_token` between retry attempts
- **Kiro**: canonicalize tool history and route API keys correctly
- **Kiro**: normalize dashboard thinking intensity models
- **Cursor**: stop leaking agent tool errors as text
- **Gemini**: fill empty tool schemas after `$ref` strip
- **Antigravity**: strip `stream_options` from non-stream requests
- **Jina-reader**: recover after transient errors, use JSON POST API
- **Usage**: record exact embedding tokens
- **Tunnel**: preserve successor cloudflared PID
- **Console-log**: initialize capture at server boot + prevent SSE proxy buffering
- **Dashboard**: count dual-auth, free-tier OAuth and API-key connections correctly
- **Dashboard**: flex quota rows, thin global scrollbars, no hidden-row overflow

## Docs
- **i18n**: expand pt-BR translation to 986 terms
- README: Indonesian translation

# v0.5.40 (2026-07-20)

## Features
- **i18n**: add Khmer (km) translations
- **CLI tools**: configure Grok Build subagent models
- **Kimi**: merge OAuth into dual-auth provider, add K3 / K2.7 models
- **Dashboard**: ProviderTopology flow animation

## Fixes
- **DB**: resolve better-sqlite3 parameter binding crash
- **Translator**: pass `service_tier` through OpenAI → Responses conversion
- **Kiro**: map GPT-5.6 reasoning effort fields
- **Kiro**: validate terminal streams before emitting output
- **Kiro**: map GPT reasoning effort fields
- **Codex**: current `client_version` + refresh-aware model sync
- **Alicode-intl**: split into Coding Plan + Model Studio providers
- **Cursor**: HTTP/2 AgentService support + version bump 3.12.17
- **Dashboard**: cut duplicate API/icon spam, lazy-load provider assets

# v0.5.35 (2026-07-16)

## Features
- **xAI**: Grok Imagine video generation (`/v1/videos`) + CLI
- **CLI tools**: Grok Build setup — choose separate main/general-purpose/explore/plan models and preserve each model's context window
- **GitHub Copilot**: route Claude models through Copilot's native `/v1/messages`
- **Kiro**: add GPT-5.6 model family (#2596)
- **RTK**: `X-9Router-Token-Saver` header to bypass token savers per request
- **Providers**: quota visibility settings
- **Translator**: drop temperature for all Claude models
- **i18n**: Thai (th) + Persian (fa) translations / README

## Fixes
- **Providers**: bulk-add API keys no longer overwrite existing keys (gap-fill `Key N`)
- **Anthropic**: lowercase `anthropic-version` header to prevent duplication on `/v1/messages`
- **Alicode-intl**: use DashScope compatible-mode endpoint so standard keys work
- **Grok CLI**: align Grok Build with current subscription protocol (#2590)
- **Grok CLI**: surface `expiresAt` so proactive token refresh fires (#2546)
- **Kiro**: improve direct session cache reuse
- **Models**: populate capabilities for live-catalog LLM models
- **Models**: list compatible provider models in `/v1/models`
- **Thinking**: send explicit `thinking:{type:adaptive}` alongside `output_config.effort`
- **Translator**: strip `client_metadata` when converting openai-responses → openai

## Improvements
- **Perf**: skip inactive background services on startup

## Docs
- README: Persian YouTube tutorial

# v0.5.30 (2026-07-10)

## Features
- **Perplexity**: add Agent API provider (#2492)
- **Grok CLI**: add Grok CLI / Grok Build provider with OAuth device-code flow (#2502)
- **Featherless**: add OpenAI-compatible provider presets
- **SearXNG**: configure endpoint via SEARXNG_URL env (#2499)
- **Providers**: add max thinking level for gpt-5.6-sol (#2500)
- **Headroom**: add extras detection and install UI (#2403)
- **Headroom**: activate/uninstall extras + fix interpreter detection
- **PXPipe**: PXPIPE token saver — multimodal prompt compression (#2465)
- **Proxy-Pools**: auto-rotate strategy for no-auth providers (#2409)

## Fixes
- **Cloudflare-AI**: support accountId in bulk key import (#2449)
- **DB**: backup on schema change, MCP child cleanup, codex models, usage providers OOM
- **Codex**: avoid bare-email OAuth dedup (#2477)
- **CLI**: allow staged app bundle builds (#2479)
- **Headroom**: compress Kiro conversation state (#2488)
- **Gemini-CLI**: raise output floor for thinking and add validated toolConfig (#2486)
- **GitHub**: label Copilot profiles by account identity (#2498)
- **OpenAI-to-Claude**: unwrap bare {function:{…}} tools without parent type (#2473)
- **Translator**: clamp thinking effort max->xhigh for OpenAI format (#2466)
- **RTK/find**: detect and group Windows backslash-style find output (#2448)
- **Codex**: handle fast tier and capacity SSE (#2452)
- **Volcengine-ark**: clamp Kimi max_tokens to 32768 endpoint cap
- **Antigravity**: align provider fingerprint with IDE Desktop 2.1.1 (#2389)
- **Pricing**: update Claude/Codex model rates and add new models

## Improvements
- **i18n(zh-CN)**: complete Chinese translations for all UI strings (#2436)
- **API**: caching for tunnel and version status endpoints
- **Perf**: faster dev startup and lighter bundle

# v0.5.20 (2026-07-07)

## Features
- **Thinking**: per-model thinking level picker on provider page — appends `(level)` suffix to copied model names for forced reasoning effort across all formats (openai, claude, gemini, deepseek, kimi, qwen, zai, minimax, hunyuan, step)
- **RTK**: add JS-native git-log filter (#2423)
- **Caveman**: add targeted upstream-aligned style rules (#2424)
- **i18n**: add Farsi (fa) language support (#2385)

## Fixes
- **Thinking**: strip `(level)` suffix from upstream `body.model` so providers no longer reject requests
- **Translator**: preserve developer instructions in openai-responses conversion (#2434)
- **count_tokens**: count structured Anthropic blocks (#2419)
- **Volcengine-ark**: clamp GLM-5 max_tokens to model output ceiling (#2428)
- **Kimi**: normalize reasoning_effort to backend enum (#2427)
- **Claude**: reconcile max_tokens vs thinking budget and lift per-model ceiling (#2381)
- **Kiro**: deliver system prompt natively, add Opus 4.5/4.7/4.8, tolerate dash version ids (#2366)
- **Headroom**: proxy dashboard through app (#2372)
- **MITM**: recover from stale lock file on server start

# v0.5.18 (2026-07-03)

## Features
- **Usage**: track cached tokens + correct input/output/cache cost (#2209) — hodtien
- **Codex**: show reset credit expiry details (#2290) — Rafli Ahmad Zulfikar
- **NVIDIA**: add new models and capabilities — decolua
- **ClinePass**: add provider support — sternelee

## Fixes
- **Usage**: dedupe streaming request-details log entries — Qin Li
- **Claude**: drop foreign thinking signatures in passthrough — decolua
- Prevent non-SSE stream pipe crash and cross-IdP account overwrites (#2244) — KunN-21
- **Kiro**: route IdC auth to regional CodeWhisperer surface (#2297) — Volodymyr Saakian
- **Kiro**: add Claude Sonnet 5 model support (#2264) — Edison42
- **Xiaomi-tokenplan**: region selector, key validation, multi-connection (#2251) — MiQieR
- **Translator**: strict Anthropic content block compliance (#2225) — Sahrul Ramadhan Hardiansyah
- **Kimchi**: strip reasoning_content echo to bound multi-turn input tokens — KunN-21
- **Kimchi**: bump User-Agent to kimchi/0.1.40 (#2256) — Ansh7473
- **Codebuddy-cn**: strip empty tool_calls arrays to preserve reasoning — zmf
- **Antigravity**: preserve Claude tool delta index (#2223) — Sutarto Jordan Chrisfivo
- **MITM**: generate root CA on server startup (#2228) — Sutarto Jordan Chrisfivo

# v0.5.15 (2026-06-29)

## Features
- Add Kimchi OAuth provider — Nant361
- Refine Qwen vision/video + thinking model patterns — decolua
- Opt-in Codex auto-ping quota keep-alive — Emirhan

## Fixes
- **Responses**: handle response.done terminal events (#2142) — rifuki
- **Headroom**: skip unsafe responses tool history (#2132) — Sutarto Jordan Chrisfivo
- **Translator**: map mid-conversation system message to user (claude→openai) — decolua
- **Gemini**: normalize contents to prevent 400 invalid_argument (#2192) — warelik
- **Gemini**: backfill thoughtSignature + suppress stream done sentinel — WARELIK
- **Alicode**: preserve cache_control for DashScope providers (#2069) — Rex
- **Antigravity**: strip deprecated/readOnly/writeOnly from tool schemas — iletai, Yudhistira-Official
- **CodeBuddy CN**: show bonus packs as one-time, not monthly-replenishing — whale9820
- **Kiro**: strip leaked <thinking> tags from content stream (#2158) — hamsa0x7
- **Tray**: make Windows context menu DPI-aware — Emirhan
- **Kilocode**: expose full gateway catalog in combo model picker — jellylarper
- **OpenCode**: fix Go GLM — decolua

# v0.5.12 (2026-06-26)

## Features
- Add token-saver dashboard page — decolua
- Add bulk delete for provider connections — teddytkz
- Resolve GitHub Copilot model catalog from upstream — caiqinzhou
- Add Venice AI provider — Brokenc0de
- Add Kiro external_idp import for Microsoft SSO (CLIProxyAPI) — Stevanus Pangau
- Overhaul Blackbox provider catalog + WebUI test support — suryacagur

## Fixes
- Provider thinking compatibility (DeepSeek/Gemini) — Mink Nguyen
- Stop double-counting streaming usage at source — decolua
- Usage logging dedupe to reduce stats churn — Mink Nguyen
- Prevent non-JSON SSE lines / duplicate [DONE] from breaking clients (PR #2046) — qianze
- Resolve Gemini TTS models from catalog — nguyenha935
- Support Kiro IDC (organization) token import — quanturbo
- Preserve forced streaming for JSON clients (#2031) — Joseph Yaksich
- Preserve Responses text format (Codex) — tenglong
- Support Gemini native TTS generateContent endpoint — nguyenha935
- Add missing zh-CN endpoint key label (i18n) — weimaozhen
- CodeBuddy: only send reasoning params when client requests reasoning (#2071) — Rex
- CodeBuddy CN: show one-shot bonus packs as expiring, not monthly-replenishing
- Show custom provider models in combo picker — Sapto
- Docker: add docker-compose.yml with headroom enabled by default — nitsuahlabs
- Clarify token diagnostics vs provider billing (headroom, #1998) — Sutarto Jordan Chrisfivo
- Translate openai-responses input through OpenAI for compression (#1998) — Ankit
- Kiro: report 1M context window for claude-opus-4.8 — EdisonPVE
- Avoid stale redirects after auth changes (#2100) — Emirhan
- Mark Claude Opus 4.7 (dashed id) as 1M context — Brokenc0de
- Preserve reasoning effort through Codex translations — ntdung6868
- Token-saver: full width card layout — decolua
- Antigravity: retry transient upstream failures — Sutarto Jordan Chrisfivo
- Param-support: handle strip rules without match/drop (#1960) — Joseph Yaksich
- Translator: resolve custom provider prefix in debug endpoint (#1083) — hamsa0x7

# v0.5.8 (2026-06-21)

## Features
- **Antigravity**: native image generation support (image models tagged kind:image, hiển thị trong media-providers UI)
- **CodeBuddy CN**: API key auth + credit quota tracker
- **CodeBuddy CN**: short model prefix alias "cbcn"

## Fixes
- **MiniMax-M3**: enable vision capability
- **Headroom**: support Docker sidecar proxy
- **Antigravity**: image executor fixes
- **mimo-free**: Chrome User-Agent rotation to bypass anti-abuse gate
- **cloudflare-ai**: flatten content-part arrays to string to avoid oneOf 400 (#1926)
- **Translator**: normalize tools to Anthropic-native shape for non-Anthropic providers
- **CLI**: handle Next.js 16 nested standalone output path (#1940)
- **Codex**: preserve custom tools during request normalization
- **next.config**: add new route for responses endpoint to API

# v0.5.6 (2026-06-20)

## Features
- **Ponytail**: minimalist code generation feature
- **Headroom**: proxy lifecycle management + dashboard UI (one-click start/stop, install detection, status probing, token saver, claude↔openai shape conversion)
- **CodeBuddy CN**: new OAuth provider (copilot.tencent.com) — 15-model catalog, /v2 inference, forced streaming, OpenAI-style reasoning
- **OpenCode-Go**: align models with official endpoints; route Qwen 3.7 MiniMax via /v1/messages, GLM/Kimi/DeepSeek/MiMo via /chat/completions

## Fixes
- **Anthropic-compatible validation**: use POST /v1/messages (GET /models not spec, false "invalid" for valid keys)
- **CLI tools**: tolerate JSONC configs in all 8 settings routes (opencode, openclaw, kilo, droid, cowork, copilot, claude, cline)
- **Gemini/Antigravity**: preserve 'pattern' in tool schema translation (glob/grep)
- **Combo/Fusion**: flatten Anthropic-style tool messages in panel calls (prevent 503)
- **Models**: store provider custom models by provider scope
- **Perplexity**: use /v1/models endpoint for key validation

# v0.5.4 (2026-06-18)

## Fixes
- **Kiro**: honor thinking effort budgets
- **AG/Kiro/Xiaomi**: provider fixes
- **Combo/Fusion**: flatten tool history in panel calls to prevent 503
- **LLM selector**: show custom vision models in selector and model list
- **Image**: prevent compatible nodes from shadowing provider aliases

# v0.5.2 (2026-06-17)

## Features
- **Combo Fusion strategy** — fans the prompt out to all member models in parallel, then a configurable judge model synthesizes one final answer (quorum-grace, anonymized sources, graceful degradation)
- **Per-combo strategy selector** — pick `fallback` / `round-robin` / `fusion` / `capacity` per combo (replaces the old round-robin toggle), with a judge picker for fusion
- **Capacity auto-switch** — reorders models per request so images/PDFs route to capable models first
- **Kiro headless API-key auth** (`ksk_`) + direct `claude↔kiro` route that avoids the lossy OpenAI two-hop pivot
- **Claude auto-ping** — warms the 5h quota window right after reset so a fresh window starts immediately (per-connection toggle)

## Fixes
- **Claude 429**: stop hammering the OAuth usage endpoint — cache resetAt, throttle quota refresh to 3 min, cool down after a 429 (chat unaffected)
- **Usage logs always empty**: missing `await` on `getAdapter()` in `getRecentLogs` made `/api/usage/logs` & `/api/usage/request-logs` return nothing
- **Executors**: strip params unsupported by the provider/model (drops deprecated `temperature` for claude-opus-4 → Anthropic 400)
- **Translator**: derive deterministic tool_call ids for gemini/antigravity → OpenAI so function call/response pair correctly (fixes tool-pairing 400s)
- **Antigravity**: strip `optional` from tool schemas before sending to Gemini
- **Claude-to-OpenAI**: handle OpenAI-format responses in the non-streaming path (e.g. xiaomi-tokenplan)
- **Usage views**: show edited connection names consistently across Providers & Quota Tracker
- **Security**: hardened reverse-proxy local-access trust
- **Security**: SSRF hardening on web fetch

## Internal
- Large **open-sse / translator refactor** (~40 commits): unified provider/model registry (LiteLLM-style `models[]` + `kind` field, 100 co-located registry files), single-sourced media/OAuth/refresh/token URLs, registry-based dispatch for usage & token-refresh, DRY translator concerns (buildUsage, encodeDataUri, finishReasonMap, chunkBuilder, reasoningDelta…), ESM-safe registry init, large-file splits, dead-code removal, and golden/no-regression test gates

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL
