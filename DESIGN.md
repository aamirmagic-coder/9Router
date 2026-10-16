---
name: 9Router Dashboard — Usage Stack
description: Sistem visual dashboard lokal 9Router; halaman Usage sebagai satu tumpukan berlapis yang membaca dari atas ke bawah.
colors:
  primary: "#E56A4A"
  primary-strong: "#a64027"
  bg: "#FDFAF6"
  bg-subtle: "#F7F3EE"
  surface: "#ffffff"
  surface-2: "#f4f4f5"
  surface-3: "#e7e7e9"
  border: "#e5e7eb"
  border-subtle: "#f1f1f3"
  text-main: "#0a0a0a"
  text-muted: "#5F6673"
  text-subtle: "#5F6673"
  danger: "#cf222e"
  success: "#10B981"
  warning: "#F59E0B"
  info: "#3B82F6"
typography:
  value-primary:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif"
    fontSize: "2.75rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.03em"
    fontFeature: "tabular-nums"
  value-secondary:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: "tabular-nums"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1.4
  micro:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.025em"
  icon:
    fontFamily: "Material Symbols Outlined, sans-serif"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "normal"
    fontFeature: "liga"
    fontVariation: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24"
rounded:
  micro: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  brand: "10px"
  brand-lg: "14px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
components:
  layer-header:
    backgroundColor: "{colors.bg-subtle}"
    textColor: "{colors.text-main}"
    rounded: "{rounded.brand}"
    padding: "10px 12px"
    typography: "{typography.title}"
  layer-header-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-main}"
    rounded: "{rounded.brand}"
    padding: "10px 12px"
  layer-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-main}"
    rounded: "{rounded.lg}"
    padding: "8px"
  layer-row-selected:
    backgroundColor: "{colors.bg-subtle}"
    textColor: "{colors.text-main}"
    rounded: "{rounded.lg}"
    padding: "8px"
  value-mode-active:
    backgroundColor: "{colors.primary-strong}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "4px 10px"
    typography: "{typography.label}"
  value-mode-idle:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
    typography: "{typography.label}"
  search-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-main}"
    rounded: "{rounded.lg}"
    padding: "6px 32px 6px 32px"
    size: "100%"
    typography: "{typography.body}"
  filter-chip:
    backgroundColor: "{colors.bg-subtle}"
    textColor: "{colors.primary}"
    rounded: "{rounded.lg}"
    padding: "6px 10px"
    typography: "{typography.label}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-main}"
    rounded: "{rounded.brand-lg}"
    padding: "24px"
  drill-action:
    backgroundColor: "{colors.bg-subtle}"
    textColor: "{colors.text-subtle}"
    rounded: "{rounded.md}"
    size: "27px"
---

# Design System: 9Router Dashboard — Usage Stack

Sistem ini tidak lahir dari workshop visual; ia diambil dari kode yang sudah berjalan
(`src/app/globals.css` dan `src/app/(dashboard)/dashboard/usage/**`) dan dari bahasa
yang sudah dipakai kode itu untuk membenarkan keputusannya. Setiap nilai di bawah
punya satu tempat asal di repositori ini. Kalau sebuah aturan tidak bisa ditunjukkan
baris kodenya, ia tidak ditulis di sini.

## Overview

**Creative North Star: "Tumpukan Berlapis" — helai kertas yang dibuka di tempat.**

Halaman Usage adalah satu tumpukan yang dibaca dari atas ke bawah: satu ringkasan tebal,
lalu lapis-lapis yang mengembang di tempat saat ditanya lebih dalam — provider → model →
akun → endpoint. Yang ditolak adalah susunan dashboard standar: empat kartu angka
sejajar, satu chart, satu tabel, di mana setiap bagian mengulang "ini ringkasannya"
tanpa pernah menjawab "lalu kenapa". Lapis membuka isinya sementara lapis induknya tetap
terbaca, jadi hierarki provider → model → request terlihat utuh dalam satu kolom, bukan
sebagai tiga halaman terpisah (`stack/Layer.js`).

Density-nya tinggi tapi tenang. Halaman ini dibuka berulang sambil operator bekerja dan
dibiarkan terbuka selama request mengalir, jadi permukaannya harus tahan terhadap
perubahan data: angka punya kolom lebar tetap dan rata kanan, `tabular-nums` di semua
tempat, dan nilai baru masuk dengan fade yang tidak menggeser apa pun. Pemisahnya bukan
kartu, melainkan garis lipatan tipis di kepala tiap laps yang ikut menjorok bersama
indentasi — panjang garis itu sendiri yang menyatakan kedalaman.

Yang menghubungkan seluruh sistem ini adalah satu disiplin yang bukan estetika:
**lebih baik tidak menampilkan apa pun daripada menampilkan angka yang menebak.**
Kerangka berdenyut lebih dipilih daripada angka periode lain di bawah label baru;
"no recorded cost" lebih dipilih daripada batang kosong yang terbaca sebagai "tidak ada
aktivitas"; kalimat "No period-over-period comparison" ditulis di kepala halaman alih-alih
menghilangkan panah naik/turun secara diam-diam.

**Key Characteristics:**
- Satu aksen oranye (`#E56A4A`) yang dipakai untuk menandai, bukan menghias; latar tombol
  aktif memakai varian lebih gelap `#a64027` supaya teks putih lolos AA.
- Tiga cara membaca nilai (`Cost`, `Tokens`, `Cost + Tokens`), satu basis peringkat per mode.
- Angka biaya dan token selalu penuh (`toLocaleString`), tidak pernah "7.1K" / "16.0B".
- Pemisah lapis adalah garis lipatan, bukan kartu atau bayangan.
- Dua keluarga huruf saja: Inter untuk teks, Material Symbols Outlined untuk ikon.
- Gerak: mengembang 240ms, nilai baru 180ms, garis tren 400ms. Tidak ada entrance animation
  yang menyembunyikan konten.
- Indentasi 14px per lapis, padding isi lapis 42px di kiri.

## Colors

Paletnya satu aksen oranye hangat di atas basis netral hangat; tidak ada warna kedua
yang bersaing. Status memakai empat warna semantik, dan semuanya muncul hanya sebagai
penanda kecil (titik 6px, garis, atau latar 8% alfa).

### Primary
- **Brand Coral** (`--color-primary` = `#E56A4A` = `brand-500`): aksen tunggal. Dipakai untuk
  segmen batang proporsi, garis tren, isian garis proporsi baris, chevron aktif, ikon status
  hidup, dan teks aksi. Skala penuh `brand-50`–`brand-900` terdefinisi di `:root`.
- **Brand Coral Deep** (`--color-primary-strong` = `#a64027` = `brand-700`): **hanya** sebagai
  latar dengan teks putih. Teks putih di atas `brand-500` hanya 3,23:1 dan gagal WCAG AA untuk
  teks 12px; `#a64027` mencapai 6,21:1 dan tetap keluarga warna yang sama. Dipakai langsung
  (`text-white` di atas `bg-primary-strong`), tanpa menggeser `--color-primary` supaya aksen
  brand di seluruh aplikasi tidak ikut berubah.

### Neutral
- **Warm Paper** (`--color-bg` = `#FDFAF6`): latar halaman, terang. Gelap: `#1a1a1a`.
- **Warm Alt** (`--color-bg-subtle` → alias `--color-bg-alt` = `#F7F3EE`): latar kepala lapis
  saat terbuka, latar mode switch, latar `thead` tabel drill. Gelap: `#1F1F1E`.
- **Sheet** (`--color-surface` = `#ffffff` / `#262626`): permukaan kartu dan input.
- **Hover Fill** (`--color-bg-hover` → alias `--color-surface-2` = `#f4f4f5` / `#303030`):
  satu-satunya latar hover di halaman ini. Dipakai di kepala lapis, baris lapis, tombol ikon,
  baris tabel, dan tombol sekunder.
- **Sunken** (`--color-surface-3` = `#e7e7e9` / `#3a3a3a`): terdefinisi, hanya sebagai latar uji
  kontras; tidak dipakai langsung oleh tumpukan.
- **Hairline** (`--color-border` = `#e5e7eb` / `#333333`): garis luar kontrol, segmen "output"
  pada strip komposisi token, batang aliran saat idle.
- **Hairline Subtle** (`--color-border-subtle` = `#f1f1f3` / `#2a2a2a`): **garis lipatan** antar
  lapis, dasar garis proporsi baris, track strip komposisi, border kartu.
- **Ink** (`--color-text-main` = `#0a0a0a` / `#ededed`): teks utama, label, angka.
- **Ink Muted** (`--color-text-muted` = `#5F6673` / `#9ca3af`): teks pendukung, meta lapis,
  sublabel, label sumbu.
- **Ink Subtle** (`--color-text-subtle` = `#5F6673` / `#8b93a1`): teks tersier dan angka
  pendamping di kolom kanan. Nilainya **diukur, bukan dikira-kira**: harus lulus AA (4,5:1)
  terhadap tiga latar terang yang benar-benar dipakai halaman ini — `#FDFAF6` (5,6:1),
  `#F7F3EE` (5,2:1), dan `#E7E7E9` (4,7:1). Nilai sebelumnya `#9CA3AF` hanya 2,44:1 dan gagal
  di ketiganya. Di tema gelap nilainya memang sudah benar, hanya tertukar dengan tema terang.

### Status
- **Danger** (`#cf222e` / `#ef4444`): provider yang baru gagal, status request error, batang
  proporsi baris yang error.
- **Success** (`#10B981` / `#22c55e`): titik status baris `active`, status request "ok".
- **Warning** (`#F59E0B` / `#fbbf24`) dan **Info** (`#3B82F6` / `#60a5fa`): terdefinisi di
  sistem, tidak dipakai oleh tumpukan Usage.

### Provider Identity Colors
Halaman Usage punya **dua sistem warna yang hidup berdampingan**, dan keduanya tidak boleh
tertukar:

1. **Aksen tunggal** (`--color-primary` oranye) untuk *tindakan dan keadaan*: tombol mode
   aktif, fokus, aliran hidup, status "ok". Satu hue, tidak pernah dipakai untuk menandai
   identitas.
2. **Warna identitas provider** untuk *kategori*: setiap provider mendapat hue sendiri,
   dihitung dari namanya (`stack/providerColor.js`), dipakai sebagai penanda grafis —
   titik, segmen batang, potongan donut, kotak kalender.

Sebelumnya hanya ada sistem pertama, dan pembeda antar-provider berpindah lewat **opasitas
dari satu hue**: peringkat 0 oranye penuh, 1 oranye 62%, 2 oranye 34%, dan **peringkat 3+
semuanya `--color-border` (abu-abu)**. Itu bekerja untuk tiga provider dan gagal total untuk
empat puluh: di database nyata ada 40+ provider, sehingga hampir semuanya berwarna sama dan
legenda berisi sederet titik kelabu yang tidak bisa dibedakan.

**The Hashed-Hue Rule.** Hue provider berasal dari hash FNV-1a atas namanya, lalu ditempatkan
dengan sudut emas (137,508°) sampai jaraknya dari warna yang sudah ditempatkan cukup jauh.
Hash saja tidak cukup — dengan 40 provider di ruang 360°, peluang tabrakan mendekati pasti
(paradoks ulang tahun ≈89%). Terukur pada 23 provider nyata: jarak minimum **9,95°** terhadap
jarak ideal 15,65°; dan versi pertama yang hanya memakai hash menghasilkan dua provider
berjarak **0,1°** — praktis identik, lebih buruk daripada tidak ada warna sama sekali karena
tampak seperti ada hubungan yang sebenarnya tidak ada.

**The Marker-Not-Text Rule.** Warna provider HANYA untuk penanda grafis; teks tetap
`--color-text-main`. Dua puluh warna yang semuanya harus lulus kontras teks 4,5:1 di dua tema
sekaligus hanya bisa dicapai dengan membuat semuanya gelap dan kusam — yang justru menghapus
gunanya membedakan warna. Sebagai penanda grafis, ambangnya 3:1 dan itu terpenuhi.

**The Stable-Color Rule.** Warna dihitung dari SELURUH provider yang ada di stats, bukan dari
yang terlihat setelah disaring. Kalau warnanya dihitung dari yang tampil, menyaring halaman
akan mengubah warna provider — dan penanda yang berubah saat dipakai tidak berguna sebagai
penanda. Konsekuensi yang diterima: menambah provider dapat menggeser warna satu-dua tetangga
terdekatnya, tapi tidak pernah mengocok seluruh papan.

**The Darkened-Fill Rule.** Oranye boleh jadi **latar** dengan teks putih hanya lewat
`--color-primary-strong` (`#a64027`). Oranye sebagai **teks** memakai `--color-primary` dan
hanya boleh duduk di atas latar netral, bukan di atas tint oranye. Warna provider mengikuti
aturan yang sama: sebagai latar chip dipakai dengan alfa 0,14, tidak pernah pekat.

## Typography

**Display Font:** Inter (dengan `-apple-system`, `BlinkMacSystemFont`, `SF Pro Text`,
`SF Pro Display`, `system-ui`, `sans-serif`)
**Body Font:** sama — Inter, satu keluarga untuk seluruh **teks** antarmuka
**Icon Font:** Material Symbols Outlined (`material-symbols/outlined.css`, dengan `sans-serif`
sebagai cadangan)
**Label/Mono Font:** `ui-monospace` hanya di dalam blok markdown changelog; tabel Usage tidak
memakai mono. Tidak ada keluarga ketiga.

**Character:** Dua keluarga, dan tidak lebih: Inter untuk seluruh teks, Material Symbols
Outlined untuk seluruh ikon. Bobot teks 400–600, satu sumbu ikon (`FILL 0`/`wght 400`), dan
satu sifat teknis yang mengikat: `tabular-nums` di setiap angka. Angka di halaman ini berubah
saat dibaca, dan angka yang mengubah lebarnya akan menggeser seluruh baris — karena itu tiap
nilai numerik dibungkus `tabular-nums`, sering ditambah `fontVariantNumeric` inline, dan
diberi kolom lebar tetap (`min-w-[4.5rem]`) yang rata kanan.

### Hierarchy
- **Value Primary** (600, `2.75rem`, line-height 1, tracking `-0.03em`, `tabular-nums`):
  satu nilai utama di kepala tumpukan. Naik ke `3.25rem` di ≥640px. Pasangan angka penuh —
  biaya (`$7,123.45`) atau token (`16,042,831,295`) — sesuai mode.
- **Value Secondary** (600, `1.75rem`, line-height 1, tracking `-0.02em`, `tabular-nums`):
  nilai kedua, **hanya** di mode `Cost + Tokens`, di sebelah nilai utama. Naik ke `2rem` di ≥640px.
- **Title** (600, `0.875rem`, tracking `-0.01em`): judul lapis ("Providers", "Models"), judul
  seksi (`Flow`), judul kartu.
- **Body** (400, `0.875rem`): teks penjelas, kalimat pendamping angka utama, label baris lapis,
  nilai baris lapis, sel tabel drill.
- **Label** (500, `0.75rem`): tombol mode nilai, baris kendali di kepala, teks input pencarian,
  chip saringan, paginasi, meta lapis, angka pendamping.
- **Caption** (400, `0.6875rem` = 11px): legenda komposisi token, label aliran, catatan
  "No period-over-period comparison", label sumbu chart.
- **Micro** (500, `0.625rem` = 10px, uppercase, tracking `0.025em`): hanya kepala tabel drill
  (`When`, `Status`, `Tokens`, `Latency`) dan label aksis kecil seperti `Live flow`.
- **Icon** (400, `14px`–`28px` menurut konteks, line-height 1, fitur `liga`): seluruh ikon
  Material Symbols Outlined; lihat bagian di bawah.

### Icon Font
Ikon di halaman ini bukan gambar dan bukan glyph Unicode: setiap ikon adalah **ligature** dari
web font `Material Symbols Outlined`, dimuat sekali di `src/app/layout.js` lewat
`import "material-symbols/outlined.css"`. Yang dirender adalah teks biasa yang dibentuk font:
`font-size: 24px`, `line-height: 1`, `font-feature-settings: 'liga'`, dan satu sumbu variabel
(`font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24`; varian `.fill-1`
menyalakan `FILL 1`).

- **Ukuran datang dari kelas, bukan dari font.** Halaman Usage memakai `text-[14px]` (ikon di
  samping label), `text-[15px]`–`text-[16px]` (ikon di dalam tombol), `text-[18px]` (chevron
  lapis), `text-[24px]` (spinner), dan `text-[28px]` (kartu gagal). `24px` adalah default paket,
  bukan aturan halaman ini.
- **Opasitas digerbangi kesiapan font.** `.material-symbols-outlined { opacity: 0 }` di
  `globals.css`, dan `.fonts-loaded .material-symbols-outlined { opacity: 1 }` menyalakannya
  dengan `transition: opacity .12s ease-out`. Kelas `fonts-loaded` dipasang inline di `<head>`
  setelah `document.fonts.load('24px "Material Symbols Outlined"')` selesai, dengan batas waktu
  3 detik supaya kegagalan memuat font tidak menyembunyikan ikon selamanya. Tanpa gerbang ini,
  nama ligature (`chevron_right`, `receipt_long`) tampil sebagai kata biasa selama font masih
  diunduh.
- **Aksesibilitas adalah bagian dari token, bukan tambahan.** Ikon duduk di dalam
  `aria-hidden="true"` karena ia tidak pernah membawa makna sendiri — teks di sebelahnya yang
  membawa. Ikon yang berdiri sebagai **satu-satunya isi** tombol kehilangan makna itu, jadi
  tombolnya wajib punya `aria-label` (`Show N requests for X`, `Remove provider filter`,
  `Clear search`, `Dismiss`).

### Named Rules
**The Tabular-Nums Rule.** Setiap angka yang bisa berubah saat halaman dilihat wajib
`tabular-nums` **dan** berada di kolom berlebar tetap yang rata kanan. Lebar angka boleh
berubah; posisi kolomnya tidak boleh. Ini satu paket: `tabular-nums` tanpa kolom tetap tetap
menggeser baris saat digitnya bertambah.

**The No-Kicker Rule.** Tidak ada label hias di atas judul yang hanya mengulang judul. Label
kecil yang ada (`Live flow`, `Usage · today`) menempel pada kontrol atau data yang ia
terangkan dan menyebut sesuatu yang tidak disebut di tempat lain — ia label aksis, bukan
eyebrow.

**The Ligature-Gate Rule.** Ikon adalah teks sampai fontnya tiba, jadi ia disembunyikan
(`opacity: 0`) sampai kelas `.fonts-loaded` dipasang, bukan ditampilkan sebagai kata mentah
lalu berubah bentuk. Gerbang ini wajib dan punya batas waktu: kalau font gagal diunduh,
`fonts-loaded` tetap dipasang setelah 3 detik sehingga ikon tidak pernah hilang permanen.

## Layout

Tata letaknya satu kolom yang mengalir ke bawah, tanpa grid multi-kolom:

- Kontainer halaman: `flex min-w-0 flex-col gap-6 px-1 sm:px-0`. `min-w-0` di setiap tingkat
  adalah syarat, bukan hiasan — tanpa itu anak yang panjang memaksa induk melebar dan memicu
  scroll horizontal di mobile.
- Tumpukan: `flex min-w-0 flex-col gap-6`; daftar lapis: `flex min-w-0 flex-col gap-1`
  (lapis-lapis berdempetan sebagai satu tumpukan, bukan kartu terpisah).
- **Indentasi menyatakan kedalaman.** Lapis ke-`n` diberi `marginLeft: n × 14px`; isi lapis
  diberi `padding-left: 42px` dan `padding-right: 4px`. Provider di tepi kiri, endpoint paling
  menjorok. Sebelumnya nilai ini selalu 0, sehingga hierarki yang disebut kontrak sebagai
  tanda tangan halaman tidak pernah terlihat — empat lapis tampak setara padahal tidak.
- Garis lipatan: `border-top` dengan `--color-border-subtle` di kepala tiap lapis kecuali
  yang pertama, ikut menjorok (`ml-3`) bersama lapisnya.
- Panel lapis dianimasikan lewat `grid-template-rows: 1fr → 0fr`, sehingga tidak perlu
  mengukur tinggi isi di JS dan isinya tetap di DOM saat tertutup (penting untuk pencarian
  lintas-lapis).
- Batas baris per lapis: **8 baris** saat normal, **40** saat pencarian aktif. Sisanya dibuka
  dengan tombol `Show N more` yang menyebut jumlah yang disembunyikan.
- Chart: tinggi tetap **200px**, margin `{top:4,right:4,bottom:0,left:-12}`, lebar gutter
  sumbu-Y **52px**.
- Daftar request (drill): `max-h-80` dengan `overflow-y-auto`, `thead` sticky.

### Named Rules
**The Fixed-Column Rule.** Angka utama setiap baris dan kepala lapis berada di kolom
`min-w-[4.5rem]` rata kanan. Nilai pendamping selalu diletakkan **di sebelah kirinya**,
sehingga angka yang jadi dasar peringkat tidak pernah berpindah tempat saat mode berganti.

**The Readable-Before-Collapsed Rule.** Saat pencarian aktif, lapis yang punya hasil dipaksa
terbuka. Menyembunyikan hasil cocok di balik baris tertutup adalah hal terburuk yang bisa
dilakukan saat operator sedang mencari.

## Elevation & Depth

Sistem ini memakai bayangan **ambient**, bukan struktural: tumpukan tidak dibangun dari
kartu bertingkat, melainkan dari satu permukaan datar yang dipisah garis lipatan. Bayangan
hanya muncul di dua tempat — kartu permukaan dan tooltip chart.

### Shadow Vocabulary
- **Soft** (`--shadow-soft`: `0 1px 2px 0 rgba(0,0,0,0.04)` terang / `0 1px 2px 0 rgba(0,0,0,0.3)` gelap):
  kartu default, termasuk kartu keadaan gagal.
- **Elevated** (`--shadow-elevated`: `0 12px 28px -4px rgba(60,50,45,0.06)` terang /
  `0 12px 28px -4px rgba(0,0,0,0.45)` gelap): tooltip chart. Satu-satunya elemen yang benar-benar
  mengambang di atas halaman.
- **Elev** (`--shadow-elev`: inset highlight putih + dua lapis ambient): kartu `elev`, tidak
  dipakai tumpukan Usage.
- **Warm** (`--shadow-warm`: `0 2px 12px -2px rgba(229,106,74,0.18)`): kartu hover, tidak
  dipakai tumpukan Usage.
- **Focus** (`--shadow-focus`: `0 0 0 3px rgba(229,106,74,0.18)`): token tersedia; komponen
  Usage memakai pola ring Tailwind (`focus-visible:ring-2 ring-primary/45`) alih-alih token ini.

### Named Rules
**The Fold-Not-Card Rule.** Kedalaman tumpukan dinyatakan oleh garis lipatan dan indentasi,
bukan oleh bayangan bertingkat. Menambahkan kartu ber-shadow di dalam lapis akan memecah
tumpukan menjadi daftar kartu dan menghapus hierarki yang jadi alasan halaman ini ada.

**The Flat-At-Rest Rule.** Permukaan lapis datar saat diam. Latar muncul hanya sebagai
respons state: `bg-bg-subtle` saat lapis terbuka, `bg-bg-hover` saat hover.

## Shapes

Bahasa bentuknya siku membulat kecil dengan satu pengecualian pada skala kartu:

- `2px` (`rounded-[2px]`): swatch legenda, batang aliran per menit. Nilai terkecil; dipakai
  untuk elemen setinggi 5px yang ujungnya tidak boleh terlihat tajam.
- `4px` (`rounded-sm`): pembungkus angka yang bisa difokus dengan rincian token.
- `6px` (`rounded-md`): tombol mode nilai, tombol aksi baris (drill), tombol paginasi.
- `8px` (`rounded-lg`): input pencarian, chip saringan, baris lapis, tombol Retry, tombol
  kontrol, dan kotak daftar request.
- `10px` (`rounded-[10px]` / `--radius-brand`): kepala lapis dan kontrol segmented di
  `SegmentedControl` yang dipakai halaman.
- `14px` (`rounded-[14px]` / `--radius-brand-lg`): kartu dan kerangka skeleton. Satu-satunya
  radius besar; menyimpannya untuk kartu membuat unit tumpukan tetap terasa lebih ringan.
- `9999px` (`rounded-full`): track dan segmen batang proporsi, track strip komposisi token,
  garis proporsi baris, dot status 6px, chip pill di `/dashboard/quota`.

Garis luar tipis 1px dengan `--color-border` dipakai di kontrol (input, chip, tombol sekunder,
kotak tabel). Garis dalam daftar lapis **tidak** memakai border penuh — hanya `border-top`
sebagai garis lipatan, dan `border-b` antar baris di dalam tabel drill.

## Components

### Buttons
- **Shape:** `6px` untuk tombol ikon dan aksi baris; `8px` untuk tombol berlabel; `10px` untuk kepala lapis.
- **Primary (mode nilai aktif):** latar `--color-primary-strong`, teks `#ffffff`, padding `4px 10px`,
  `text-xs` (12px) bobot 500, `shadow-sm`.
- **Idle (mode nilai tidak aktif):** latar `transparent`, teks `--color-text-muted`, hover
  `bg-bg-hover` + `text-text-main`. Transisi `150ms` color/background.
- **Ghost (ikon):** `p-1.5` (`6px`), `rounded-md`, teks `--color-text-subtle`, hover `bg-bg-hover`
  + `text-text-main`. Saat aktif: `bg-primary/8 text-primary`.
- **Secondary (Retry, Reset range, Peak):** `rounded-lg` atau `rounded-md`, border
  `--color-border`, teks `--color-text-main`/`--color-text-muted`, hover `bg-bg-hover`.
- **Focus (semua tombol, tanpa kecuali):** `focus-visible:outline-none focus-visible:ring-2
  focus-visible:ring-primary/45`. Segmen batang proporsi memakai `ring-inset ring-white/70`
  karena ia duduk langsung di atas warna solid.
- **Disabled:** `opacity-40`–`opacity-60` + `cursor-not-allowed`. Segmen `__rest` pada batang
  proporsi memang `disabled` secara semantik (`cursor-default`), bukan sekadar tampak nonaktif.
- **Ikon di dalam tombol:** selalu `material-symbols-outlined` dengan ukuran eksplisit
  (`text-[15px]`, `text-[16px]`), `aria-hidden="true"`, dan — bila ikon itu satu-satunya isi
  tombol — `aria-label` pada tombolnya.

### Chips
- **Filter chip (saringan provider aktif):** latar `primary/8`, border `primary/30`, teks
  `--color-primary` 12px bobot 500, `rounded-lg`, padding `6px 10px`. Isinya: ikon `filter_alt`
  + nama provider (truncate `max-w-[10rem]`) + ikon `close`. Seluruh chip adalah satu tombol
  yang menghapus saringan; hover `bg-primary/15`.
- **Mode chip:** lihat Buttons — satu grup `role="group"` berlabel "What to show", di dalam
  pembungkus `rounded-lg border border-border bg-bg-subtle p-0.5`.
- **Pill (hanya di `/dashboard/quota`, konteks sistem yang sama):** `rounded-full`, latar
  `brand-500/10` atau `blue-500/10`, teks 10px bobot 600. Bukan bagian tumpukan Usage.

### Cards / Containers
- **Corner Style:** `14px`.
- **Background:** `--color-surface`.
- **Border:** 1px `--color-border-subtle`.
- **Shadow Strategy:** `--shadow-soft` (lihat Elevation & Depth).
- **Internal Padding:** `p-3` / `p-4` / `p-6` / `p-8`; tumpukan Usage memakai `padding="md"` (`24px`)
  hanya untuk kartu keadaan gagal.
- Kartu dipakai **hanya** untuk keadaan khusus (gagal memuat), bukan untuk membungkus lapis.

### Inputs / Fields
- **Style:** `rounded-lg`, border 1px `--color-border`, latar `--color-surface`, `text-sm`,
  tinggi efektif `py-1.5` dengan ikon `search` di `left-2.5` dan padding kiri `pl-8`.
- **Placeholder:** `--color-text-subtle`.
- **Hover:** `border-text-subtle/40`.
- **Focus:** `border-primary/60` + `ring-2 ring-primary/25`. Ini satu-satunya kontrol yang
  memakai ring 25%; tombol memakai 45%.
- **Adornment:** pintasan `/` ditampilkan sebagai `kbd` 10px di kanan, disembunyikan di mobile
  (tidak ada papan ketik yang perlu dijelaskan di perangkat sentuh). Saat ada isi, `kbd`
  digantikan tombol `close` dengan `aria-label="Clear search"`.

### Navigation
- **Tab tingkat halaman:** `SegmentedControl` dengan **tiga** nilai (`Overview`, `Logs`,
  `Details`). Nilai disimpan di URL (`?tab=`), bukan di state — deep-link harus tetap bekerja,
  dan `activeTab` hanya menerima ketiga nilai itu. `Overview` merender tumpukan Usage;
  `Logs` merender `RequestLogger`; `Details` merender `RequestDetailsTab`. Ketiganya wajib ada
  sebagai opsi: selama `logs` tidak ada di daftar opsi, tampilannya hanya terjangkau dengan
  mengetik URL sendiri, dan saat aktif tidak ada tombol yang tersorot karena `value` tidak
  cocok dengan opsi mana pun.
- **Pemilih periode:** `SegmentedControl` enam nilai (`Today`, `24h`, `7D`, `30D`, `60D`, `All`)
  dengan `size="sm"`, duduk di baris header halaman. Hanya tampil di tab `Overview`; periode
  juga yang dikirim ke `/api/usage/request-details` oleh drill-down.
- **Navigasi dalam tumpukan:** lapis, bukan tab. `role`-nya `<section>` dengan `<h3>` berisi
  tombol ber-`aria-expanded` + `aria-controls`; panel punya `id` dari `useId()`. Bentuknya
  sengaja bukan `<details>/<summary>`: kontrol penuh atas animasi tinggi, `aria-expanded` yang
  benar, dan isi yang tetap ada di DOM saat tertutup.
- **Saringan URL:** `?provider=` dibaca langsung dari `searchParams` sebagai satu-satunya
  sumber kebenaran; tidak disalin ke state, supaya tombol maju/mundur browser tidak
  meninggalkan salinan basi.

### Signature Component: Layer + LayerRow (`stack/Layer.js`)
Unit dasar tumpukan, dan pengganti tab. Tiga hal yang membuatnya bekerja:

1. **Kepala lapis** — `flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5`, latar
   `bg-bg-subtle` saat terbuka / transparan saat tertutup, hover `bg-bg-hover`. Isinya:
   chevron `chevron_right` yang **berputar** (`rotate(90deg)`) bukan berganti ikon, judul
   `text-sm font-semibold` (menjadi `text-primary` saat `accent`), meta `text-xs text-text-muted`
   yang bisa truncate, lalu di `ml-auto` nilai pendamping dan nilai utama rata kanan.
2. **Panel** — `grid-template-rows: 1fr ↔ 0fr`, transisi `240ms cubic-bezier(.2,.8,.2,1)`.
   Isi lapis lain boleh terbuka bersamaan; himpunan `openLayers` adalah `Set`, bukan satu id,
   karena tumpukan yang menutup lapis induk saat anaknya dibuka bukan lagi tumpukan.
   `Providers` terbuka bawaan.
3. **Garis proporsi baris** — `h-[3px]`, track `bg-border-subtle`, isian `bg-primary` dengan
   `width: max(pct, 1.5%)` supaya baris yang porsinya kecil tetap terlihat, transisi `500ms`.
   Sengaja garis tipis, bukan progress bar berlatar penuh: yang dibutuhkan hanya perbandingan
   panjang antar baris, dan garis tipis melakukannya tanpa menambah massa visual.

### Signature Component: StackHead (`stack/StackHead.js`)
Kepala tumpukan. Urutan vertikalnya:
1. Baris kendali: label `Usage · {periode}` di kiri, grup mode nilai di `ml-auto`. Kontrol
   duduk **di atas** nilai, bukan di bawah, supaya operator tahu angka ini untuk apa sebelum
   membacanya.
2. Kalimat jujur: "No period-over-period comparison — the usage API returns a single
   aggregate series, so there is no prior period to diff against."
3. Nilai utama (satu di mode tunggal, dua di mode gabungan) + `N requests` + indikator
   `N live` (dot 6px `animate-pulse`) bila ada request berjalan.
4. Strip komposisi token — hanya di mode `Tokens` dan `Cost + Tokens`, tinggi `h-1.5`,
   `max-w-2xl`, tiga segmen: **uncached input** (primary 30%), **cached** (`--color-primary`
   penuh), **output** (`--color-border`).
5. Batang proporsi antar-provider — `h-2.5`, `rounded-full`, proporsi dipetakan lewat
   `flex-grow` (bukan `width: %`) supaya `min-width: 4px` pada segmen kecil tidak membuat
   total melebihi 100% dan memotong segmen terakhir. **Setiap** provider yang punya aktivitas
   mendapat segmennya sendiri dengan warna identitasnya (lihat The Hashed-Hue Rule) — tidak
   ada lagi "tiga teratas + N others", karena dengan 40+ provider itu berarti hampir semuanya
   tidak punya identitas di kepala halaman. Tiap segmen adalah tombol: klik menyaring seluruh
   halaman. Segmen terpilih ditandai `opacity-100`, yang lain `opacity-25`.
6. **Donut komposisi provider**, di dalam blok kepala. SVG murni (bukan pustaka chart):
   potongan donut dengan dua busur + dua garis radial, celah 1,2° antar-segmen, mulai dari
   jam 12. Delapan provider teratas digambar; sisanya digabung menjadi satu potongan netral
   berlabel "N provider lainnya" dengan tombol untuk membuka semuanya. Pusat donut menampilkan
   total, atau nilai potongan yang sedang disorot. Klik potongan menyaring halaman.
   Pustaka chart tidak dipakai di sini karena yang dibutuhkan hanya satu lingkaran berpotong —
   ~40 baris SVG terhadap ~15KB bundel untuk fitur yang tidak terpakai.
7. **Kalender aktivitas**, satu kotak `size-3 rounded-[3px]` per hari, lima tingkat dari
   peringkat terhadap hari TERBERAT (bukan ambang tetap — ambang tetap salah begitu besaran
   pemakaian berubah). Hari tanpa pemakaian dapat tingkat tersendiri, tidak pernah terlihat
   seperti "aktivitas sedikit". **Hanya per hari, bukan hari × jam**: `/api/usage/chart` sudah
   menjumlahkan per jam, dan `usageDaily` menyimpan agregat per hari — membuat kisi jam
   berarti menambah query yang memindai `usageHistory` setiap kali halaman dibuka.
8. Legenda yang bisa diklik, dengan angka `tabular-nums` — provider gratis menampilkan
   `N req` alih-alih `0%`, karena "0%" terbaca sebagai "tidak dipakai".
9. Catatan provider gagal: `rounded-lg border border-danger/25 bg-danger/8 px-3 py-2`, ikon
   `error` 16px, teks `text-xs`.
10. `FlowLine`: baris tipis 10 ember per menit dari `last10Minutes`, tiap batang `rounded-[2px]`,
   tinggi `max(12%, (req/peak)×100%)` dengan lantai 6%, opasitas `0.35 + (req/peak)×0.65`,
   transisi `500ms` dengan easing yang sama. Tidak menampilkan angka di tengah — hanya label
   kiri `Live flow` dan kanan `N req / 10m` atau `idle`.

### Signature Component: FlowChart (`stack/FlowChart.js`)
Satu seri agregat. Tidak ada seri palsu per-provider: proporsi provider hari ini bukan
proporsi provider minggu lalu, dan menumpuknya di atas sumbu waktu akan berbohong soal waktu.
Yang ditambahkan adalah interaksi yang memang didukung datanya: `Brush` rentang waktu
(muncul hanya bila titiknya ≥8), tombol `Peak` untuk melompat ke titik tertinggi, tombol
`Reset range`, dan ringkasan terpilih yang selalu terlihat (bukan hanya di tooltip).
Area `monotone` dengan `stroke-width: 2`, isian gradient satu warna dua alfa (0.18 → 0.02),
grid `strokeDasharray="2 4"` hanya horizontal, animasi `400ms ease-out`.

**Dua formatter, karena dua tempat ini lebarnya berbeda.** Sumbu-Y hanya **52px** dan labelnya
cuma penunjuk arah, jadi ia memakai `fmtTokens` (`1.2K`). Tooltip dan ringkasan punya ruang
dan harus mencetak angka yang **sama persis** dengan tabel di bawahnya, jadi keduanya memakai
`fmtTokenCount`/`fmtCost` (angka penuh). Ringkasan yang membulat sementara tabelnya penuh
membuat keduanya tampak tidak sinkron — dan pembulatan itu tidak bisa dicocokkan dengan
catatan mana pun, yaitu satu-satunya guna halaman ini.

### Signature Component: RequestDrill (`stack/RequestDrill.js`)
Ujung penelusuran, tampil **di dalam** baris lapis (bukan modal, bukan tab). Tabel 4 kolom
(`When`, `Status`, `Tokens`, `Latency`), `max-h-80`, `thead` sticky `bg-bg-subtle` dengan
`text-[10px] uppercase`. Status ditandai dot 6px (`success`/`danger`) plus teks. Ada
`<caption className="sr-only">`. Paginasi 25 baris/halaman, hanya tampil bila `totalPages > 1`.

Kolom `Tokens` memakai `fmtTokenCount` — angka penuh (`1,234`), **bukan** `fmtTokens`.
Satu-satunya tempat angka ringkas boleh hidup adalah gutter sumbu-Y selebar 52px di `FlowChart`,
dan kolom ini bukan salah satunya: justru di sini operator membandingkan dua request baris
demi baris, dan "1.2K" menyembunyikan 34 token yang membedakan keduanya. Lebar kolom dijaga
`tabular-nums` + `whitespace-nowrap`, jadi angka panjang tidak menggeser tata letak.

Sumbernya `d.tokens`, dengan penamaan ganda yang harus ditangani: baris kanonik menyimpan
`{ input_tokens, output_tokens }`, baris lama menyimpan `prompt_tokens`/`completion_tokens`.
Idiomnya (`prompt_tokens || input_tokens`, plus cadangan cache untuk baris Claude lama yang
menyimpan input TANPA cache) disalin dari `RequestDetailsTab.js`. Membaca hanya satu penamaan
membuat kolom ini mencetak `0` — angka salah yang tampak seperti jawaban sah.

**Kolom keempat adalah Latency, bukan Cost.** Baris request tidak menyimpan biaya sama sekali:
`buildRequestDetail` (`open-sse/handlers/chatCore/requestDetail.js`) tidak punya field `cost`,
dan terukur **0 dari 1.000** baris di database memilikinya. Kolom yang selalu `—` bukan
informasi kurang, melainkan ruang yang menuntut perhatian untuk memberi tahu bahwa tidak ada
apa-apa. `latency.total` ada di 1.000/1.000 baris, dan "kenapa request ini lambat" sama
seringnya ditanyakan dengan "kenapa gagal". Biaya per request tetap bisa dibaca di tab Details.
Nilainya dicetak penuh dengan satuan (`26,997 ms`), bukan `fmtCount` yang menyingkat jadi `27K`.

**Rentang waktu mengikuti period, bukan "25 terakhir".** `periodStart(period)`
menerjemahkan period menjadi `startDate` untuk `/api/usage/request-details`. Pemetaannya
disalin dari `PERIOD_MS` di `@/lib/db/repos/usageRepo.js` dan **harus tetap sama**: `24h`,
`7d`, `30d`, `60d` sebagai durasi, `today` sebagai tengah malam **lokal** (bukan UTC),
`all` tanpa batas. Modul itu server-only (SQLite) sehingga tidak bisa diimpor komponen
klien — duplikasi ini disengaja. Kalau nilainya menyimpang, daftar ini menampilkan rentang
yang berbeda dari total di baris atasnya, yaitu kelas bug yang sama dengan angka periode
lama di bawah label periode baru. `period` ikut masuk key paginasi karena rentang pendek
punya halaman lebih sedikit.

**Ketika daftar kosong padahal baris di atasnya melaporkan banyak request, itu bukan bug
tampilan.** `requestDetails` adalah **buffer bergulir**: `saveRequestDetail` berhenti
menulis bila observability dimatikan (`if (!config.enabled) return`), dan baris tertua
dibuang saat jumlah melewati `maxRecords` (`DEFAULT_MAX_RECORDS = 200`,
`DELETE ... ORDER BY timestamp ASC LIMIT (n - maxRecords)`). Arsip historisnya ada di
`usageHistory`, yang punya rincian per-periode tetapi tanpa identitas request tunggal.
Karena itu drill-down hanya punya dasar untuk period yang masih tercakup buffer.

## Do's and Don'ts

### Do:
- **Do** cetak biaya dan token sebagai angka penuh: `fmtCost` (`$7,123.45`, dan 4 desimal di
  bawah `$0.01`), `fmtFull`/`fmtTokenCount` (`toLocaleString("en-US")`). "16,042,831,295" bisa
  dicocokkan dengan catatan lain; "16.0B" tidak bisa.
- **Do** letakkan angka utama di kolom `min-w-[4.5rem]` rata kanan dengan `tabular-nums`, dan
  nilai pendamping di sebelah kirinya.
- **Do** perlakukan `cached` sebagai **bagian dari** `input`, tidak pernah sebagai tambahan.
  `total = input + output`. Legend menuliskan "cached (N% of input)" dan "output (N% of total)";
  batangnya menggambar cached **di dalam** porsi input.
- **Do** jaga agar label periode dan angka selalu berasal dari periode yang sama: `statsPeriod`
  disimpan bersama `stats` dan render hanya menerima stats saat keduanya cocok; selama belum
  cocok, yang tampil adalah kerangka.
- **Do** pasang `key` di **anak dalam** yang dianimasikan (`.value-fade`), dan taruh
  `tabIndex`/`title`/`aria-describedby` di **pembungkus luar yang stabil**.
- **Do** pakai `focus-visible:ring-2 ring-primary/45` di setiap kontrol yang bisa difokus.
- **Do** beri garis lipatan `border-border-subtle` di kepala tiap lapis kecuali yang pertama,
  dan biarkan ia ikut menjorok bersama indentasi 14px.
- **Do** sediakan keadaan yang berbeda untuk **memuat** (kerangka berdenyut), **gagal**
  (sebut periode yang gagal + tombol Retry yang benar-benar mengulang), dan **tidak ada
  aktivitas** ("No activity in this period.").
- **Do** pakai `flex-grow` untuk proporsi, bukan `width: %`, bila ada `min-width` pada segmen.
- **Do** pasangkan setiap ikon dengan `aria-hidden="true"`, dan beri tombol `aria-label` bila
  ikon itu satu-satunya isinya.

### Don't:
- **Don't** menyingkat angka biaya atau token di kepala halaman, baris lapis, ringkasan chart,
  atau kolom `Tokens` di tabel drill. Satu-satunya tempat angka ringkas boleh hidup adalah
  gutter sumbu-Y selebar 52px dan penghitung request sekunder (`fmtCount`).
- **Don't** menampilkan empat kartu angka sejajar, atau mengubah lapis menjadi tab yang
  mengganti isi — lapis membuka di tempat, lapis induk tetap terbaca.
- **Don't** memakai `--color-primary` sebagai latar dengan teks putih untuk teks di bawah
  14px. Pakai `--color-primary-strong` (`#a64027`, 6,21:1).
- **Don't** mencampur oranye dengan `--color-text-main` untuk membuat variasi warna; pakai
  `color-mix` dengan `--color-surface` atau opasitas.
- **Don't** menambahkan kartu ber-shadow di dalam lapis. Kedalaman dibawa garis lipatan dan
  indentasi, bukan bayangan.
- **Don't** merender batang kosong atau `0` sebagai jawaban atas "tidak ada dasar
  perhitungan". Tulis sebabnya ("N requests served by M providers at no recorded cost").
- **Don't** memakai glyph Unicode sebagai ikon, dan jangan menambah keluarga font ketiga.
  Ikon selalu Material Symbols Outlined dengan `aria-hidden="true"`; ikon yang berdiri sebagai
  satu-satunya isi tombol wajib disertai `aria-label`.
- **Don't** menampilkan panah perbandingan periode. API tidak punya periode pembanding, dan
  meminjamkan konteks yang tidak ada sama buruknya dengan menghilangkannya diam-diam.
- **Don't** menambahkan entrance animation yang menyembunyikan konten.

## Drift

**Sudah diperbaiki** (dicatat supaya tidak dikira masih terbuka):

- Dua ikon Export/Import di `page.js` kini memakai `aria-hidden="true"`; sebelumnya nama
  aksesibel tombolnya terbaca "download Export" — ligature font terbaca sebagai kata.
- `SegmentedControl` (shared) kini memberi `aria-hidden="true"` pada `option.icon` dan
  `aria-pressed` pada tombolnya. Sebelumnya keadaan terpilih hanya tersampaikan lewat warna
  (`bg-surface`), yang tidak terbaca pembaca layar; halaman Usage adalah satu-satunya
  pengguna komponen ini.

**Masih terbuka, dicatat apa adanya:**

- **`briefs/usage.md` masih mencatat tab "Logs" sebagai `Unresolved`** ("kodenya ada di
  `page.js` tapi tidak ada tombol yang menuju ke sana"). Build sudah menyelesaikannya:
  `page.js` kini memasang tiga opsi dan `logs` merender `RequestLogger`. Brief belum
  diperbarui, jadi ia tertinggal dari kode — kode yang menang.
- **Observability mati membuat drill-down dan tab Logs kosong** untuk semua period kecuali
  `all`. Sakelarnya di Profile → Observability ("Record request details for inspection in the
  logs view"). `settings.enableObservability` yang tidak di-set dibaca sebagai `false`, dan
  `saveRequestDetail` berhenti menulis. Ini urusan setelan, bukan tampilan; halaman Usage
  sudah menampilkan ketiadaannya dengan jujur.
