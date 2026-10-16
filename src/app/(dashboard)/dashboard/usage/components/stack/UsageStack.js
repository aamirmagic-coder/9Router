"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Card from "@/shared/components/Card";
import StackHead from "./StackHead";
import LivePanel from "./LivePanel";

import ActivityHeatmap from "./ActivityHeatmap";
import { buildProviderColors, providerCss, providerChipBg } from "./providerColor";
import Layer, { LayerRow } from "./Layer";
import FilterBar from "./FilterBar";
import FlowChart from "./FlowChart";
import RequestDrill from "./RequestDrill";
import {
  fmtCost,
  fmtFull,
  fmtCount,
  fmtTokenDetail,
  fmtWhole,
  share,
  valueOfMode,
  PERIOD_LABELS,
} from "./format";

/**
 * UsageStack — susunan halaman Usage sebagai satu tumpukan.
 *
 * Hierarki yang dibaca dari atas ke bawah:
 *   kepala (ringkasan + aliran) → provider → model → akun → endpoint
 *
 * Tiap lapis MENYARING lapis di bawahnya, bukan menggantinya: memilih provider
 * membuat lapis model menampilkan hanya model provider itu, dan seterusnya.
 * Itu yang membuat penelusuran terasa sebagai satu gerakan turun, bukan
 * perpindahan antar halaman.
 */

const DIMENSIONS = [
  { id: "provider", title: "Providers", key: "byProvider", groupBy: null },
  { id: "model", title: "Models", key: "byModel", groupBy: "rawModel" },
  { id: "account", title: "Accounts", key: "byAccount", groupBy: "accountName" },
  { id: "endpoint", title: "Endpoints", key: "byEndpoint", groupBy: "endpoint" },
];

/** Normalisasi satu entri peta menjadi baris seragam. */
function normalizeRow(id, d) {
  const prompt = d?.promptTokens || 0;
  const completion = d?.completionTokens || 0;
  const cached = d?.cachedTokens || 0;
  return {
    id,
    rawModel: d?.rawModel || id,
    provider: d?.provider || null,
    connectionId: d?.connectionId || null,
    accountName: d?.accountName || null,
    endpoint: d?.endpoint || null,
    keyName: d?.keyName || null,
    requests: d?.requests || 0,
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
    tokens: prompt + completion,
    cost: d?.cost || 0,
    lastUsed: d?.lastUsed || null,
  };
}

/**
 * Nama provider yang bisa dibaca manusia.
 *
 * Provider kustom ber-id UUID panjang; node-nya punya nama yang operator
 * kenali ("apigabot", "jos"). Kalau namanya tidak ada, id-nya dipendekkan
 * supaya tidak memenuhi lebar kolom — dengan awalan yang cukup untuk tetap
 * membedakan dua node sejenis.
 */
function providerLabel(id, nodeNames) {
  if (!id) return "—";
  const named = nodeNames?.[id];
  if (named) return named;
  if (id.length <= 22) return id;
  return `${id.slice(0, 14)}…`;
}

export default function UsageStack({ period, stats, live = null, loading, onRetry, nodeNames = {} }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [mode, setMode] = useState("costs");
  const [query, setQuery] = useState("");
  // Lapis terbuka disimpan sebagai himpunan, BUKAN satu id. Alasannya penting:
  // tumpukan yang menutup lapis induk saat anaknya dibuka bukan lagi tumpukan —
  // konteks "ini bagian dari provider mana" hilang justru saat paling
  // dibutuhkan. Beberapa lapis boleh terbuka sekaligus.
  //
  // "Providers" masuk bawaan: operator mendarat langsung ke sesuatu yang bisa
  // dibaca, bukan ke deretan baris tertutup yang harus dibuka satu per satu.
  const [openLayers, setOpenLayers] = useState(() => new Set(["provider"]));

  const toggleLayer = useCallback((id) => {
    setOpenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const searching = query.trim().length > 0;

  // Saringan provider DIBACA LANGSUNG dari URL, bukan disalin ke state lewat
  // effect. URL adalah satu-satunya sumber kebenarannya: dengan menyalinnya,
  // ada dua salinan yang bisa berbeda (mis. tombol maju/mundur browser hanya
  // mengubah URL, sehingga salinan di state jadi basi), dan effect yang menulis
  // state saat mount memicu render berantai yang tidak perlu.
  //
  // Ini juga membuat saringan otomatis bisa dibagikan dan di-bookmark,
  // mengikuti kebiasaan yang sudah ada di halaman ini (?tab=, ?sortBy=).
  const providerFilter = searchParams.get("provider") || null;

  const setProvider = useCallback(
    (id) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set("provider", id);
      else params.delete("provider");
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Satu basis peringkat dan proporsi untuk seluruh halaman, ditentukan mode
  // yang dipilih operator. Diambil dari `format.js` supaya kepala, lapis, dan
  // strip tidak pernah memakai basis yang berbeda.
  const valueOf = useCallback((row) => valueOfMode(row, mode), [mode]);

  /**
   * Peta warna identitas provider.
   *
   * Dihitung dari SELURUH provider yang ada di stats, bukan hanya yang terlihat
   * setelah disaring: warna "b.ai" harus sama apakah ia sedang tampil sendirian
   * atau bersama 40 provider lain. Kalau warnanya dihitung dari yang terlihat,
   * menyaring halaman akan mengubah warna — dan penanda yang berubah saat
   * dipakai tidak berguna sebagai penanda.
   *
   * Nama node dipakai sebagai kunci kalau ada, karena itulah yang dibaca
   * operator ("b.ai"), sementara id mentahnya adalah UUID yang tidak berarti.
   */
  const colorMap = useMemo(() => {
    const ids = Object.keys(stats?.byProvider || {}).map(
      (id) => nodeNames?.[id] || id,
    );
    return buildProviderColors(ids);
  }, [stats, nodeNames]);

  /** Baris komposisi provider untuk donut di kepala. Satu sumber untuk
      donut dan strip proporsi, supaya keduanya tidak pernah berbeda angka. */
  const donutRows = useMemo(() => {
    if (!stats) return null;
    return Object.entries(stats.byProvider || {}).map(([id, d]) => ({
      id: nodeNames?.[id] || id,
      rawId: id,
      cost: d?.cost || 0,
      tokens: (d?.promptTokens || 0) + (d?.completionTokens || 0),
      requests: d?.requests || 0,
    }));
  }, [stats, nodeNames]);

  const colorOf = useCallback(
    (id, tone = "solid") => {
      const label = nodeNames?.[id] || id;
      return providerCss(colorMap.get(label)?.hue ?? null, { tone });
    },
    [colorMap, nodeNames],
  );

  /**
   * Titik harian untuk kalender aktivitas.
   *
   * Diambil di sini, bukan di dalam ActivityHeatmap, supaya periodenya dijaga
   * dengan cara yang sama seperti stats: `pointsPeriod` disimpan bersama
   * datanya, dan render hanya menerima saat keduanya cocok. Kalender yang
   * menampilkan hari-hari periode lama di bawah label periode baru persis
   * kesalahan yang dijaga seluruh berkas ini — dan pada kalender justru lebih
   * mudah lolos, karena bentuknya tidak berubah saat isinya berganti.
   */
  const [points, setPoints] = useState([]);
  const [pointsPeriod, setPointsPeriod] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/usage/chart?period=${encodeURIComponent(period)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !Array.isArray(d)) return;
        setPoints(d);
        setPointsPeriod(period);
      })
      .catch(() => {
        // Kalender bukan bagian yang menjawab pertanyaan utama halaman ini;
        // gagal memuatnya tidak boleh menjatuhkan seluruh tumpukan.
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  // Semua lapis dinormalisasi sekali, lalu disaring berlapis-lapis. Dihitung
  // sebagai satu useMemo supaya pencarian dan saringan tidak menelusuri peta
  // yang sama empat kali.
  const layers = useMemo(() => {
    if (!stats) return null;

    const q = query.trim().toLowerCase();
    const matches = (row) => {
      if (providerFilter && row.provider !== providerFilter && row.id !== providerFilter) {
        // Lapis provider memakai id sebagai provider-nya sendiri.
        if (!(row.id === providerFilter && row.provider === null)) return false;
      }
      if (!q) return true;
      return (
        row.id.toLowerCase().includes(q) ||
        (row.rawModel || "").toLowerCase().includes(q) ||
        (row.provider || "").toLowerCase().includes(q) ||
        (row.accountName || "").toLowerCase().includes(q) ||
        (row.endpoint || "").toLowerCase().includes(q) ||
        (row.keyName || "").toLowerCase().includes(q)
      );
    };

    const build = (dim) => {
      const raw = stats[dim.key] || {};
      const rows = Object.entries(raw).map(([k, d]) => normalizeRow(k, d));
      return { ...dim, rows };
    };

    const providerLayer = build(DIMENSIONS[0]);
    const modelLayer = build(DIMENSIONS[1]);
    const accountLayer = build(DIMENSIONS[2]);
    const endpointLayer = build(DIMENSIONS[3]);

    const apply = (layer) => {
      const rows = layer.rows.filter(matches);
      const total = rows.reduce((s, r) => s + valueOf(r), 0);
      const sorted = rows.slice().sort((a, b) => valueOf(b) - valueOf(a));
      return {
        ...layer,
        rows: sorted,
        total,
        // Kedua total dihitung di sini juga, dari baris yang sudah tersaring —
        // bukan dari `stats` mentah. Kalau diambil dari sumber lain, angka
        // kepala lapis bisa berbicara tentang himpunan baris yang berbeda dari
        // yang sedang ditampilkan di bawahnya.
        totalCost: rows.reduce((s, r) => s + r.cost, 0),
        totalTokens: rows.reduce((s, r) => s + r.tokens, 0),
        allCount: layer.rows.length,
      };
    };

    return {
      provider: apply(providerLayer),
      model: apply(modelLayer),
      account: apply(accountLayer),
      endpoint: apply(endpointLayer),
      // Dasar proporsi selalu TOTAL GLOBAL, bukan total hasil saring: kalau
      // dasarnya ikut berubah, semua batang jadi 100% saat disaring ke satu
      // provider dan perbandingannya hilang.
      grandTotal: providerLayer.rows.reduce((s, r) => s + valueOf(r), 0),
      grandCount: providerLayer.rows.length,
    };
  }, [stats, query, providerFilter, valueOf]);

  // Lapis mana yang terbuka adalah NILAI TURUNAN dari (pencarian, hasil
  // pencarian, pilihan operator) — bukan state tersendiri yang harus disinkronkan
  // lewat effect. Diturunkan saat render, hasilnya selalu konsisten dan tidak ada
  // render perantara yang menampilkan halaman setengah jadi.
  //
  // Saat pencarian aktif, lapis yang punya hasil DIPAKSA terbuka: menyembunyikan
  // hasil cocok di balik baris tertutup adalah hal terburuk yang bisa dilakukan
  // saat operator sedang mencari.
  const isOpen = useCallback(
    (id) => {
      if (!searching) return openLayers.has(id);
      const layer = layers?.[id];
      if (!layer) return openLayers.has(id);
      return layer.rows.length > 0 || openLayers.has(id);
    },
    [searching, openLayers, layers],
  );

  // Live tidak terikat periode: saat ganti periode `stats` sengaja null
  // (angka periode lain tidak boleh tampil), tapi panel Live harus tetap
  // jalan — datanya berasal dari state `live` yang diperbarui REST/SSE
  // terpisah dari angka periode.
  const liveStats = {
    activeRequests: live?.activeRequests ?? stats?.activeRequests ?? [],
    recentRequests: live?.recentRequests ?? stats?.recentRequests ?? [],
  };

  if (!stats && loading) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <LivePanel stats={liveStats} nodeNames={nodeNames} />
        <div className="flex min-w-0 flex-col gap-5">
          <div className="h-24 animate-pulse rounded-[14px] bg-border-subtle" />
          <div className="h-40 animate-pulse rounded-[14px] bg-border-subtle" />
        </div>
      </div>
    );
  }

  // Tidak memuat dan tidak ada stats = stats untuk periode ini tidak pernah
  // tiba. Keadaan ini WAJIB punya tampilannya sendiri: kalau ia jatuh ke
  // kerangka berdenyut, kegagalan tampak sebagai "sebentar lagi" yang tidak
  // pernah selesai. Pesannya menyebut periode yang gagal dimuat, karena itu
  // satu-satunya petunjuk yang berguna saat mencoba lagi.

  if (!stats) {
    return (
      <Card padding="md">
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <span className="material-symbols-outlined text-[28px] text-text-subtle" aria-hidden="true">
            cloud_off
          </span>
          <p className="text-sm text-text-muted">
            Could not load usage for {PERIOD_LABELS[period] || period}.
          </p>
          <p className="text-xs text-text-subtle">
            Nothing is shown rather than numbers from another time range.
          </p>
          {/* Tombol ini memicu pengambilan ulang yang sesungguhnya. Versi
              sebelumnya memanggil `router.refresh()`, yang pada halaman client
              component hanya memuat ulang pohon server — bukan effect yang
              mengambil data di sini — sehingga tombol "Retry" tidak mengulang
              apa pun. */}
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-main transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            Retry
          </button>
        </div>
      </Card>
    );
  }

  const visibleResults =
    (layers?.provider.rows.length || 0) +
    (layers?.model.rows.length || 0) +
    (layers?.account.rows.length || 0) +
    (layers?.endpoint.rows.length || 0);
  const totalResults =
    (layers?.provider.allCount || 0) +
    (layers?.model.allCount || 0) +
    (layers?.account.allCount || 0) +
    (layers?.endpoint.allCount || 0);

  // Angka di ujung kanan tiap baris SELALU penuh — biaya dua desimal, token
  // dengan pemisah ribuan. Tidak ada "7.1K" atau "16.0B" di halaman ini:
  // angka yang disingkat tidak bisa dicocokkan dengan catatan mana pun, dan
  // itulah gunanya halaman ini.
  //
  // Di mode "both" yang tampil DUA angka, dan yang pertama adalah basis
  // peringkatnya. Urutan yang tetap (biaya dulu) lebih berguna daripada urutan
  // yang mengikuti besaran: kolom yang berpindah-pindah antar baris memaksa
  // mata membacanya ulang setiap kali.
  const valueFor = (row) => (mode === "tokens" ? fmtFull(row.tokens) : fmtCost(row.cost));
  const secondaryFor = (row) => (mode === "both" ? `${fmtFull(row.tokens)} tok` : null);
  const totalFor = (layer) =>
    mode === "tokens" ? fmtFull(layer.totalTokens) : fmtCost(layer.totalCost);
  const totalSecondaryFor = (layer) =>
    mode === "both" ? `${fmtFull(layer.totalTokens)} tok` : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <StackHead
        stats={stats}
        mode={mode}
        period={period}
        onModeChange={setMode}
        onSelectProvider={setProvider}
        selectedProvider={providerFilter}
        nodeNames={nodeNames}
        colorOf={colorOf}
        donutRows={donutRows}
        onPickProvider={(row) => setProvider(row.rawId)}
      />

      {/* Live — request berjalan (model/provider/token/elapsed) + terakhir
          (model/waktu relatif). Datanya menumpang SSE yang sudah ada.
          `liveStats` mengutamakan state live (selalu segar via SSE) dan hanya
          jatuh ke angka periode saat state live belum terisi. */}
      <LivePanel stats={liveStats} nodeNames={nodeNames} />

      {/* Donut + kalender berdampingan.
          Keduanya menjawab pertanyaan yang berbeda dan saling melengkapi:
          donut menjawab "ke MANA pemakaian pergi" (per provider), kalender
          menjawab "KAPAN pemakaian terjadi" (per hari). Menumpuknya vertikal
          akan memaksa menggulir untuk membandingkan keduanya. */}
      {/* Kalender aktivitas — "KAPAN pemakaian terjadi". Donut yang menjawab
          "ke MANA" sudah pindah ke kepala, karena di situlah ruangnya. */}
      {stats ? (
        <ActivityHeatmap points={pointsPeriod === period ? points : []} mode={mode} />
      ) : null}

      {/* Chart — satu seri, dengan brush dan ringkasan rentang terpilih. */}
      <FlowChart period={period} mode={mode} />

      <div className="border-t border-border-subtle" />

      <FilterBar
        query={query}
        onQueryChange={setQuery}
        activeFilter={providerFilter}
        onClearFilter={() => setProvider(null)}
        resultCount={visibleResults}
        totalCount={totalResults}
      />

      {/* Tumpukan lapis. Lapis "Providers" terbuka bawaan; lapis lain dibuka
          operator sesuai kebutuhan, dan beberapa boleh terbuka sekaligus supaya
          konteks induk tidak hilang saat menelusuri anaknya. */}
      <div className="flex min-w-0 flex-col gap-1">
        {DIMENSIONS.map((dim, i) => {
          const layer = layers?.[dim.id];
          if (!layer) return null;
          const open = isOpen(dim.id);
          const isProviderLayer = dim.id === "provider";

          return (
            <Layer
              key={dim.id}
              title={dim.title}
              // Kedalaman = urutan dimensi. Inilah yang membuat tumpukan ini
              // terbaca sebagai SATU gerakan turun: provider di tepi kiri,
              // lalu model, akun, dan endpoint masing-masing menjorok ke
              // dalam. Sebelumnya nilainya selalu 0, sehingga hierarki yang
              // disebut kontrak sebagai tanda tangan halaman ini tidak pernah
              // terlihat — empat lapis tampak setara padahal tidak.
              depth={i}
              // Garis lipatan tiap lapis, bukan satu pemisah di atas FilterBar.
              // Tiap lapis adalah satu helai; garis di kepala tiap helai yang
              // membuat lipatannya terbaca.
              folded={i > 0}
              count={totalFor(layer)}
              countValue={mode === "tokens" ? layer.totalTokens : layer.totalCost}
              countFormat={valueFormatFor(mode)}
              countSecondary={totalSecondaryFor(layer)}
              countSecondaryValue={mode === "both" ? layer.totalTokens : undefined}
              countSecondaryFormat={mode === "both" ? formatTokensWithSuffix : undefined}
              meta={
                layer.rows.length === 0
                  ? "no match"
                  : `${layer.rows.length}${layer.rows.length !== layer.allCount ? ` of ${layer.allCount}` : ""}`
              }
              accent={isProviderLayer && Boolean(stats.errorProvider)}
              open={open}
              onOpenChange={() => toggleLayer(dim.id)}
            >
              <LayerBody
                layer={layer}
                dimension={dim.id}
                mode={mode}
                grandTotal={layers?.grandTotal || 0}
                valueFor={valueFor}
                secondaryFor={secondaryFor}
                onSelectProvider={isProviderLayer ? setProvider : undefined}
                selectedProvider={providerFilter}
                open={open}
                hasQuery={query.trim().length > 0}
                period={period}
                nodeNames={nodeNames}
              />
            </Layer>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Isi satu lapis. Menerima batas jumlah baris supaya lapis dengan ratusan
 * model tidak memaksa operator menggulir selamanya — sisanya dibuka dengan
 * sengaja, dan jumlah yang disembunyikan disebutkan.
 *
 * Saat pencarian aktif, batasnya dinaikkan: kalau operator sedang mencari,
 * menyembunyikan hasil cocok adalah hal terburuk yang bisa dilakukan.
 */
const ROW_LIMIT = 8;
const ROW_LIMIT_SEARCHING = 40;

/**
 * Berapa baris teratas yang angkanya IKUT beranimasi.
 *
 * Tiap angka yang beranimasi menjalankan `requestAnimationFrame`-nya sendiri
 * selama ±0,5 dtk. Lapis dengan "Show all" bisa membuka ratusan baris, dan saat
 * payload SSE tiba, ratusan loop itu berebut frame yang sama — persis beban yang
 * diperingatkan di `useAnimatedNumber`. Di atas batas ini angkanya tetap benar
 * dan tetap diperbarui, hanya saja melompat alih-alih berjalan.
 *
 * 24 cukup: baris ke-25 ke bawah hampir selalu di luar layar saat angkanya
 * berubah.
 */
const ANIMATE_LIMIT = 24;

/**
 * Pemformat untuk angka yang BERANIMASI.
 *
 * Diletakkan di tingkat MODUL, bukan di dalam komponen: nilai ini dipakai oleh
 * `UsageStack` (angka total tiap lapis) DAN oleh `LayerBody` (nilai tiap baris),
 * dan keduanya adalah komponen yang berbeda. Menaruhnya di dalam `UsageStack`
 * membuat `LayerBody` merujuk nama yang tidak ada di lingkupnya.
 *
 * Aturannya harus sama di kedua tempat: token selalu BULAT (`fmtWhole`), biaya
 * selalu dua/empat desimal (`fmtCost`). Tanpa `fmtWhole`, token yang sedang
 * berjalan akan tercetak berdesimal di tengah animasi.
 */
const valueFormatFor = (mode) => (mode === "tokens" ? fmtWhole : fmtCost);
const formatTokensWithSuffix = (v) => `${fmtWhole(v)} tok`;

function LayerBody({
  layer,
  dimension,
  mode,
  grandTotal,
  valueFor,
  secondaryFor,
  onSelectProvider,
  selectedProvider,
  open,
  hasQuery,
  period,
  nodeNames,
}) {
  const [showAll, setShowAll] = useState(false);
  // Baris yang sedang ditelusuri. Hanya satu pada satu waktu: membuka dua
  // daftar request sekaligus membuat halaman kehilangan bentuk tumpukannya.
  const [drill, setDrill] = useState(null);
  const limit = hasQuery ? ROW_LIMIT_SEARCHING : ROW_LIMIT;
  const rows = showAll ? layer.rows : layer.rows.slice(0, limit);
  const hidden = layer.rows.length - rows.length;

  // Pemformat angka yang beranimasi untuk lapis ini. `valueFormatFor` hidup di
  // tingkat modul karena `UsageStack` memakainya juga untuk angka total lapis.
  const valueFormat = valueFormatFor(mode);

  if (layer.rows.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-text-muted">
        {hasQuery
          ? "Nothing matches the current search."
          : "Nothing recorded in this period yet."}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      {rows.map((row, rowIndex) => {
        // Nama baris ini dipakai untuk label DAN untuk aria-label tombol
        // telusur, jadi dihitung sekali dan tidak bisa berbeda antara yang
        // terlihat dan yang dibacakan pembaca layar.
        const rowLabel =
          dimension === "provider"
            ? providerLabel(row.id, nodeNames)
            : dimension === "account"
              ? row.accountName || row.id
              : dimension === "endpoint"
                ? row.endpoint || row.id
                : row.rawModel || row.id;
        const value = valueOfMode(row, mode);
        // Proporsi dihitung terhadap total GLOBAL, bukan total lapis yang
        // tersaring — lihat catatan di UsageStack.
        const pct = share(value, grandTotal);
        // Di lapis provider, baris melakukan DUA hal: klik utamanya menyaring
        // halaman (aksi yang jauh lebih sering dipakai), dan tombol terpisah di
        // ujung membuka daftar request-nya. Menggabungkan keduanya jadi satu
        // klik akan memaksa operator memilih antara "saring" dan "lihat isi".
        const selectable = typeof onSelectProvider === "function";
        const isDrilled = drill === row.id;

        return (
          <div key={row.id} className="min-w-0">
            <div className="flex min-w-0 items-start gap-1">
              <div className="min-w-0 flex-1">
                <LayerRow
                  // Label tiap lapis harus menyebut dimensi YANG LAPIS ITU,
                  // bukan dimensi yang kebetulan tersedia. Sebelumnya lapis
                  // "Accounts" memakai `rawModel` — sama persis dengan lapis
                  // "Models" di atasnya — sehingga ia terbaca sebagai daftar
                  // model kedua, dan identitas akun yang jadi alasan lapis itu
                  // ada justru tidak pernah muncul. Empat dimensi di PRODUCT.md
                  // hanya berarti empat kalau tiap lapis benar-benar
                  // menampilkan dimensinya sendiri.
                  label={rowLabel}
                  // Sublabel memberi konteks: akun butuh model+provider yang
                  // dipakainya, model butuh provider, endpoint butuh provider.
                  sublabel={
                    dimension === "provider"
                      ? null
                      : dimension === "account"
                        ? [row.rawModel, row.provider].filter(Boolean).join(" · ") || null
                        : dimension === "endpoint"
                          ? row.provider || null
                          : row.provider || null
                  }
                  value={valueFor(row)}
                  valueRaw={rowIndex < ANIMATE_LIMIT ? value : undefined}
                  valueFormat={valueFormat}
                  valueSecondary={secondaryFor(row)}
                  valueSecondaryRaw={rowIndex < ANIMATE_LIMIT ? row.tokens : undefined}
                  valueSecondaryFormat={mode === "both" ? formatTokensWithSuffix : undefined}
                  // Rincian token di tooltip: angka di layar tetap satu nilai
                  // yang bisa dipindai, tapi pecahan input/cached/output harus
                  // terjangkau dari baris yang sama — kalau tidak, operator
                  // harus pindah halaman untuk menjawab "kenapa tokennya besar".
                  detail={fmtTokenDetail({
                    input: row.promptTokens,
                    output: row.completionTokens,
                    cached: row.cachedTokens,
                    total: row.tokens,
                  })}
                  barValue={pct}
                  status={
                    row.id === selectedProvider && dimension === "provider" ? "active" : undefined
                  }
                  selected={selectable ? selectedProvider === row.id : false}
                  onSelect={selectable ? () => onSelectProvider(row.id) : undefined}
                  trailing={
                    <span
                      className="hidden text-xs tabular-nums text-text-subtle sm:inline"
                      title={`${fmtCount(row.requests)} requests`}
                    >
                      {fmtCount(row.requests)} req
                    </span>
                  }
                />
              </div>

              {/* Tombol buka daftar request. Hanya kalau baris ini memang punya
                  request tercatat — tombol yang membuka daftar kosong lebih
                  buruk daripada tidak ada tombol. */}
              {row.requests > 0 ? (
                <button
                  type="button"
                  onClick={() => setDrill(isDrilled ? null : row.id)}
                  aria-expanded={isDrilled}
                  aria-label={
                    isDrilled
                      ? `Hide requests for ${rowLabel}`
                      : `Show ${row.requests} requests for ${rowLabel}`
                  }
                  className={[
                    "mt-1.5 shrink-0 rounded-md p-1.5 transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
                    isDrilled
                      ? "bg-primary/8 text-primary"
                      : "text-text-subtle hover:bg-bg-hover hover:text-text-main",
                  ].join(" ")}
                >
                  <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                    {isDrilled ? "expand_less" : "receipt_long"}
                  </span>
                </button>
              ) : null}
            </div>

            {/* Daftar request di dalam baris — ujung penelusuran. */}
            {isDrilled ? (
              <div className="mb-1 ml-2 min-w-0">
                <RequestDrill
                  provider={dimension === "provider" ? row.id : row.provider}
                  model={dimension === "model" ? row.rawModel : null}
                  period={period}
                />
              </div>
            ) : null}
          </div>
        );
      })}

      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 self-start rounded-lg px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        >
          Show {hidden} more
        </button>
      ) : null}

      {showAll && layer.rows.length > ROW_LIMIT ? (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="mt-1 self-start rounded-lg px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        >
          Show top {ROW_LIMIT}
        </button>
      ) : null}
    </div>
  );
}
