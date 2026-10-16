"use client";

import { useEffect, useRef, useState } from "react";
import UsageStack from "./UsageStack";

/**
 * UsageStackConnected — mengambil data, lalu menyerahkannya ke UsageStack.
 *
 * Logika pengambilan data di sini SENGAJA mempertahankan perilaku komponen
 * lama yang sudah terbukti, karena setiap detail di dalamnya lahir dari bug
 * nyata:
 *
 *   · REST dipakai saat periode berubah, SSE untuk pembaruan berjalan.
 *   · AbortController membatalkan fetch yang sudah tidak relevan — periode bisa
 *     berganti lagi sebelum fetch selesai, dan respons lama akan menimpa yang
 *     baru kalau tidak dibatalkan.
 *   · REST MENGGANTI (bukan merge) peta dimensi. Dengan merge, key yang tidak
 *     ada di respons baru (mis. byModel saat pindah dari "all" ke "today")
 *     tetap tertinggal dan angkanya tampak tidak berubah.
 *   · SSE hanya mengganti stats penuh kalau `data.period` cocok dengan periode
 *     yang sedang diminta; kalau tidak, hanya field ringan yang di-merge.
 *
 * Yang TIDAK dibawa dari komponen lama: pemanggilan /api/providers untuk
 * topologi. Struktur tumpukan tidak memakai topologi.
 *
 * Yang DITAMBAH: peta nama node provider. Provider kustom ber-id UUID
 * ("openai-compatible-chat-7665141b-…"), dan menampilkan UUID terpotong di
 * strip proporsi maupun legenda membuat halaman ini tidak terbaca — operator
 * mengenali providernya sebagai "apigabot", bukan sebagai rangkaian heksadesimal.
 *
 * ── Aturan yang mengikat seluruh berkas ini ──────────────────────────────────
 *
 * ANGKA DAN LABEL PERIODE HARUS SELALU BERASAL DARI PERIODE YANG SAMA.
 *
 * `period` (dari halaman) dan `stats` (angka yang tertulis di layar) adalah dua
 * hal berbeda selama permintaan berjalan. Tanpa penjagaan, pindah dari "Today"
 * ke "All" menampilkan label "all time" di atas angka pemakaian hari ini selama
 * ±1,5 detik. Diukur di Edge, period "all" (58.107 request, $7.1K):
 *
 *   +300ms   label "Usage · all time"   angka "$0.95 spent · 739 requests"   ← salah
 *   +1500ms  label "Usage · all time"   angka "$7.1K spent · 58,107 requests" ← benar
 *
 * Operator yang tidak menunggu membaca $0,95 sebagai pemakaian seumur hidup —
 * kesalahan yang sama kelasnya dengan bug "ganti period tidak mengubah angka"
 * yang dijaga tests/unit/usage-period-switch.test.js.
 *
 * Karena itu `statsPeriod` mencatat periode milik `stats`, dan render hanya
 * menerima stats saat keduanya cocok. Selama belum cocok, yang tampil adalah
 * kerangka — bukan angka periode lain dengan label baru, dan bukan pula 0 yang
 * berpura-pura jadi jawaban.
 */
export default function UsageStackConnected({ period }) {
  /** Payload stats terakhir yang tiba, dari REST maupun SSE. */
  const [stats, setStats] = useState(null);
  /** Periode yang datanya sedang dipegang `stats`. `null` = belum ada apa pun. */
  const [statsPeriod, setStatsPeriod] = useState(null);
  /**
   * Data live (tidak terikat periode): request berjalan + terakhir.
   * Dipisah dari `stats` supaya panel Live tidak ikut hilang saat ganti
   * periode — `stats` sengaja di-null-kan selama `statsPeriod !== period`
   * (angka periode lain tidak boleh tampil), tapi live justru harus tetap
   * jalan karena ia bukan angka periode mana pun.
   */
  const [live, setLive] = useState({ activeRequests: [], recentRequests: [] });
  /**
   * Periode yang gagal dimuat — DISIMPAN BERSAMA PERIODENYA, bukan sebagai
   * boolean lepas.
   *
   * Boolean lepas akan tetap `true` saat operator pindah periode, dan periode
   * berikutnya langsung menampilkan "gagal" sebelum satu pun permintaan
   * dijalankan untuknya. Menyimpan periodenya membuat pertanyaan "apakah
   * periode INI gagal?" selalu punya jawaban yang benar tanpa perlu ada yang
   * mereset.
   */
  const [failure, setFailure] = useState(null);
  const [nodeNames, setNodeNames] = useState({});
  /**
   * Penghitung percobaan ulang. Satu-satunya cara memicu ulang pengambilan
   * data: `router.refresh()` tidak akan menolong di sini karena halaman ini
   * client component — ia memuat ulang pohon server, bukan effect di atas.
   * Tombol yang menjanjikan "Retry" tapi tidak mengulang apa pun lebih buruk
   * daripada tidak ada tombol.
   */
  const [attempt, setAttempt] = useState(0);

  // Periode yang sedang berlaku, dibaca di dalam callback SSE.
  //
  // SSE punya masa hidup yang lebih panjang dari satu nilai `period`, dan
  // callback yang dijadwalkan sebelum pergantian periode akan menilai pesan
  // masuk dengan nilai yang sudah basi — persis jenis kesalahan yang dijaga
  // berkas ini. Ref ini ditulis di dalam effect, bukan saat render: menulis ref
  // saat render adalah hal yang dilarang React, dan larangannya benar — render
  // yang dibatalkan akan meninggalkan nilai yang tidak pernah ditampilkan.
  const periodRef = useRef(period);
  useEffect(() => {
    periodRef.current = period;
  }, [period]);

  // Sekali saja, tidak bergantung periode: daftar provider tidak berubah saat
  // operator berpindah jendela waktu.
  useEffect(() => {
    fetch("/api/provider-nodes")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.nodes) return;
        const map = {};
        for (const node of data.nodes) {
          if (node?.id && node?.name) map[node.id] = node.name;
        }
        setNodeNames(map);
      })
      .catch(() => {
        // Gagal memuat nama bukan kegagalan halaman: id mentah tetap tampil,
        // hanya kurang enak dibaca. Karena itu tidak ada state error di sini.
      });
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const requestedPeriod = period;

    fetch(`/api/usage/stats?period=${requestedPeriod}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          // Server menjawab, tapi tanpa stats yang bisa dipakai. Itu kegagalan
          // yang sama bagi operator: menunggu lebih lama tidak akan mengubahnya.
          if (periodRef.current === requestedPeriod) setFailure(requestedPeriod);
          return;
        }
        if (data.activeRequests !== undefined || data.recentRequests !== undefined) {
          setLive((prev) => ({
            activeRequests: data.activeRequests ?? prev.activeRequests,
            recentRequests: data.recentRequests ?? prev.recentRequests,
          }));
        }
        setStats((prev) => ({
          ...prev,
          ...data,
          byProvider: data.byProvider ?? {},
          byModel: data.byModel ?? {},
          byAccount: data.byAccount ?? {},
          byApiKey: data.byApiKey ?? {},
          byEndpoint: data.byEndpoint ?? {},
          last10Minutes: data.last10Minutes ?? [],
        }));
        // Ditulis bersama datanya, dan hanya setelah data benar-benar tiba.
        // Kalau ditulis di awal effect, penanda ini berbohong tepat di jendela
        // yang ia ada untuk menjaga.
        setStatsPeriod(requestedPeriod);
        setFailure(null);
      })
      .catch((e) => {
        // Yang membatalkan adalah pergantian periode, dan permintaan
        // penggantinya sedang berjalan — itu bukan kegagalan.
        if (e?.name === "AbortError") return;
        console.warn("[usage] failed to load stats:", e?.message || e);
        if (periodRef.current === requestedPeriod) setFailure(requestedPeriod);
      });

    return () => ac.abort();
  }, [period, attempt]);

  useEffect(() => {
    const requestedPeriod = period;
    const es = new EventSource(`/api/usage/stream?period=${encodeURIComponent(period)}`);

    es.onmessage = (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch (err) {
        console.error("[usage] SSE parse error:", err);
        return;
      }

      // Dinilai terhadap periode yang berlaku SEKARANG, bukan yang tertangkap
      // saat effect ini dibuat. Server sudah melabeli setiap payload dengan
      // period-nya; mempercayai label itu apa adanya berarti stream periode lama
      // yang telat bicara bisa menggantikan data periode yang sedang dilihat.
      const current = periodRef.current;
      const isFullStats = data.totalRequests !== undefined && data.period === current;

      // Live selalu diperbarui dari payload apa pun yang membawa field-nya —
      // ia tidak terikat periode, jadi tidak ikut aturan period-match di bawah.
      if (data.activeRequests !== undefined || data.recentRequests !== undefined) {
        setLive((prev) => ({
          activeRequests: data.activeRequests ?? prev.activeRequests,
          recentRequests: data.recentRequests ?? prev.recentRequests,
        }));
      }

      setStats((prev) => {
        if (!prev) return data;
        if (isFullStats) {
          return {
            ...data,
            activeRequests: data.activeRequests,
            recentRequests: data.recentRequests,
            errorProvider: data.errorProvider,
            pending: data.pending,
          };
        }
        return {
          ...prev,
          activeRequests: data.activeRequests ?? prev.activeRequests,
          recentRequests: data.recentRequests ?? prev.recentRequests,
          errorProvider: data.errorProvider ?? prev.errorProvider,
          pending: data.pending ?? prev.pending,
          last10Minutes: data.last10Minutes ?? prev.last10Minutes,
        };
      });

      // Stats lengkap untuk periode ini tiba lewat jalur cepat. Ini juga satu-
      // satunya keadaan yang memadamkan `failure`: selama stream bicara, tidak
      // ada yang gagal, apa pun yang dikatakan REST.
      if (isFullStats) {
        setStatsPeriod(current);
        setFailure(null);
      }
    };

    // Stream yang sudah ditutup (efek dibersihkan karena periode berganti) tidak
    // boleh lagi melaporkan kegagalan: penutupannya disengaja. Tanpa penjagaan
    // ini, satu `es.close()` akan menyalakan kegagalan untuk periode berikutnya
    // yang justru sedang berjalan lancar.
    es.onerror = () => {
      if (periodRef.current === requestedPeriod) setFailure(requestedPeriod);
    };

    return () => es.close();
  }, [period]);

  // Satu-satunya tempat kedua nilai itu bertemu, dan hasilnya tidak bisa basi:
  // keduanya dibaca saat render, bukan disalin ke state lain.
  const periodMatches = statsPeriod === period;
  const failed = failure === period;
  // Empat keadaan yang mungkin, dan masing-masing punya tampilannya sendiri:
  //
  //   periodMatches            → angka periode ini
  //   failed                   → "tidak bisa memuat", dengan tombol Retry
  //   !periodMatches && !failed→ kerangka (masih menunggu)
  const loading = !periodMatches && !failed;

  return (
    <UsageStack
      period={period}
      // `null` saat periodenya tidak cocok. UsageStack menerjemahkannya menjadi
      // kerangka selama `loading`, dan menjadi keadaan gagal saat tidak —
      // sehingga tidak ada jalan bagi angka periode lain untuk tampil.
      stats={periodMatches ? stats : null}
      // Live diteruskan terpisah dari `stats`: ia bukan angka periode mana pun,
      // jadi panel Live tetap jalan selama kerangka periode ditampilkan.
      live={live}
      loading={loading}
      // Tidak ada lagi permintaan berjalan begitu angka periode ini tiba: REST
      // yang datang belakangan tidak dihitung, karena yang tampil sudah final
      // untuk periode itu. Indikator "Updating…" yang menyala tanpa ada yang
      // sedang berjalan lebih buruk daripada tidak ada indikator.
      fetching={false}
      onRetry={() => {
        setFailure(null);
        setAttempt((n) => n + 1);
      }}
      nodeNames={nodeNames}
    />
  );
}
