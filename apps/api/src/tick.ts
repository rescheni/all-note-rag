/** Auto-sync poll interval for active connections (periodic tick). */
export const TICK_MS = 3_600_000; // 1 hour — was 30s; keep quiet, prefer manual + S3 wake

/** Only enqueue a connection on tick if never synced or last sync older than this. */
export const TICK_STALE_MS = TICK_MS;
