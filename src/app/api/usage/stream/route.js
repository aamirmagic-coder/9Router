import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const encoder = new TextEncoder();
  const { searchParams } = new URL(request?.url || "http://localhost/api/usage/stream");
  const period = searchParams.get("period") || "all";
  // `cachedStatsPeriod` WAJIB ikut dicatat. Sebelumnya cache hanya menyimpan
  // angka, sehingga push cepat bisa mengirim data period LAMA sambil
  // melabelinya dengan `period` yang BARU — klien melihat
  // `data.period === period` (cocok) lalu menerimanya, dan angka di layar
  // tidak berubah saat pengguna mengganti rentang waktu.
  const state = { closed: false, keepalive: null, send: null, sendPending: null, cachedStats: null, cachedStatsPeriod: null };

  const stream = new ReadableStream({
    async start(controller) {
      // Full stats refresh (heavy) + immediate lightweight push
      state.send = async () => {
        if (state.closed) return;
        try {
          // Push ringan hanya boleh dipakai bila cache memang milik period ini.
          // Kalau period berganti, cache lama akan menampilkan angka rentang
          // sebelumnya — jadi lewati push cepat dan langsung hitung ulang.
          if (state.cachedStats && state.cachedStatsPeriod === period) {
            const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
            const quickStats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider, period };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(quickStats)}\n\n`));
          }
          // Then do full recalc for requested period and update cache
          const stats = await getUsageStats(period);
          state.cachedStats = stats;
          state.cachedStatsPeriod = period;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...stats, period })}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };

      // Lightweight push: only refresh activeRequests + recentRequests on pending changes
      state.sendPending = async () => {
        // Sama seperti send(): cache period lain tidak boleh dipush dengan
        // label period ini.
        if (state.closed || !state.cachedStats || state.cachedStatsPeriod !== period) return;
        try {
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
          const stats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider, period };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };

      await state.send();

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.sendPending);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
