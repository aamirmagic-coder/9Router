import crypto from "node:crypto";

/**
 * Job store untuk operasi massal di menu Automation.
 *
 * ── Kenapa job, bukan satu permintaan panjang ───────────────────────────────
 *
 * Memeriksa kuota 500 akun berarti 500 permintaan keluar. Kalau itu dikerjakan
 * di dalam satu permintaan HTTP, halaman menggantung tanpa kabar sampai
 * selesai, tidak ada cara membatalkannya, dan proxy apa pun di tengah jalan
 * akan memutusnya lebih dulu. Yang dibutuhkan operator bukan satu jawaban
 * besar di akhir, melainkan kemajuan yang terlihat.
 *
 * Jadi pekerjaannya dijalankan di latar, dan klien menontonnya. State-nya
 * hidup di `global` dengan alasan yang sama seperti state lain di repo ini:
 * Next.js memuat ulang modul antar-request, dan state yang hidup di scope
 * modul akan hilang di tengah pekerjaan.
 *
 * ── Yang membuat ini TIDAK tumbuh tanpa batas ───────────────────────────────
 *
 * Tiga pagar, dan ketiganya perlu:
 *   1. Umur — job yang sudah lama selesai dibuang saat ada yang melihat.
 *   2. Batas simpan hasil — 500 akun x 20 job = memori yang tidak dibutuhkan.
 *   3. Batas jumlah job — mencegah operator (atau tab yang di-refresh berkali-
 *      kali) menumpuk pekerjaan sampai memori habis.
 */

const MAX_JOBS = 20;
const MAX_RESULTS_KEPT = 800;
const JOB_TTL_MS = 30 * 60 * 1000;

function store() {
  if (!global._automationJobs) global._automationJobs = new Map();
  return global._automationJobs;
}

/** Buang job yang sudah tua, dan yang paling tua kalau sudah terlalu banyak. */
function prune() {
  const jobs = store();
  const now = Date.now();

  for (const [id, job] of jobs) {
    const done = job.status === "done" || job.status === "error" || job.status === "cancelled";
    if (done && now - (job.finishedAt || job.startedAt) > JOB_TTL_MS) jobs.delete(id);
  }

  // Masih kebanyakan: buang yang sudah selesai lebih dulu, terlama dulu.
  if (jobs.size >= MAX_JOBS) {
    const finished = [...jobs.entries()]
      .filter(([, j]) => j.status === "done" || j.status === "error" || j.status === "cancelled")
      .sort((a, b) => (a[1].finishedAt || 0) - (b[1].finishedAt || 0));
    for (const [id] of finished) {
      if (jobs.size < MAX_JOBS) break;
      jobs.delete(id);
    }
  }
}

export function createJob({ kind, label, total, meta = {} }) {
  prune();
  const jobs = store();
  const id = crypto.randomUUID();
  const job = {
    id,
    kind,
    label,
    total,
    meta,
    done: 0,
    ok: 0,
    failed: 0,
    status: "running", // running | done | error | cancelled
    startedAt: Date.now(),
    finishedAt: null,
    results: [],
    error: null,
    /** Ditulis oleh pemanggil; diperiksa di antara item supaya batal bekerja. */
    cancelRequested: false,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  prune();
  return store().get(id) || null;
}

export function listJobs() {
  prune();
  return [...store().values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Catat satu hasil. Dipanggil dari dalam loop pekerjaan.
 *
 * `results` dipotong di depan: untuk pekerjaan 500 akun, hasil paling awal
 * bukan yang paling dibutuhkan operator — yang gagal dan yang terakhir
 * diperiksa adalah yang dia cari. Menyimpan semuanya hanya membuat satu job
 * menghabiskan memori yang tidak dibutuhkan.
 */
export function recordResult(job, result) {
  job.done++;
  if (result?.ok) job.ok++;
  else job.failed++;

  job.results.push(result);
  if (job.results.length > MAX_RESULTS_KEPT) {
    job.results.splice(0, job.results.length - MAX_RESULTS_KEPT);
  }
  return job;
}

export function finishJob(job, status = "done", error = null) {
  job.status = status;
  job.error = error;
  job.finishedAt = Date.now();
  // Hasil mentah dibuang untuk job yang tidak menyimpan apa-apa.
  if (status === "cancelled") job.results = [];
  return job;
}

/**
 * Jalankan `worker` untuk setiap item, satu per satu, sambil mencatat kemajuan.
 *
 * SERIAL, dan itu keputusan sadar. Memeriksa kuota 500 akun secara paralel
 * berarti 500 koneksi keluar serentak ke upstream yang sama — pola yang persis
 * terlihat seperti penyalahgunaan, dan yang membuat upstream mulai menolak
 * dengan 429. Serial memang lebih lambat, tapi hasilnya bisa dipercaya; laju
 * yang paralel lalu di-throttle balik lebih buruk daripada laju yang wajar
 * sejak awal.
 *
 * `concurrency` bisa dinaikkan untuk pekerjaan yang memang aman (mis. memanggil
 * gateway lokal sendiri), tapi jangan lewat 8.
 */
export async function runJob(job, items, worker, { concurrency = 1 } = {}) {
  const queue = [...items.entries()];

  const runOne = async () => {
    while (queue.length) {
      if (job.cancelRequested) return;
      const [index, item] = queue.shift();
      let result;
      try {
        result = await worker(item, index);
      } catch (err) {
        result = { ok: false, error: err?.message || String(err), index };
      }
      if (job.cancelRequested) return;
      recordResult(job, { index, ...result });
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, runOne));
    finishJob(job, job.cancelRequested ? "cancelled" : "done");
  } catch (err) {
    finishJob(job, "error", err?.message || String(err));
  }
  return job;
}
