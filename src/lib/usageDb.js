// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, reportPendingProgress, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
  saveRequestDetail, getRequestDetails, getRequestDetailById,
  exportUsageData, importUsageData,
} from "@/lib/db/index.js";
