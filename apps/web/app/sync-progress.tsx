"use client";

export type SyncRunProgress = {
  id: string;
  started_at: string;
  finished_at: string | null;
  upserts?: number;
  files_total?: number;
  files_done?: number;
  chunks_total?: number;
  chunks_done?: number;
  failed?: number;
  skipped?: number;
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function isRunInProgress(run: SyncRunProgress | null | undefined): boolean {
  return Boolean(run && !run.finished_at);
}

export function SyncRunStatus({ run }: { run: SyncRunProgress | null | undefined }) {
  if (!run) return null;
  const filesTotal = n(run.files_total);
  const filesDone = n(run.files_done);
  const chunksTotal = n(run.chunks_total);
  const chunksDone = n(run.chunks_done);
  const running = !run.finished_at;
  const barTotal = chunksTotal > 0 ? chunksTotal : filesTotal;
  const barDone = chunksTotal > 0 ? chunksDone : filesDone;
  const pct = barTotal > 0 ? Math.min(100, Math.round((barDone / barTotal) * 100)) : 0;

  if (running) {
    const listing = filesTotal <= 0;
    return (
      <div className="sync-progress">
        <div className="sync-progress-label">
          <strong>同步中</strong>
          <span>
            {listing
              ? "正在列出文件…"
              : `文件 ${filesDone} / ${filesTotal} · 数据块 ${chunksDone} / ${chunksTotal}`}
          </span>
        </div>
        {barTotal > 0 && (
          <div
            className="sync-progress-bar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    );
  }

  const files = filesDone || filesTotal;
  const chunks = chunksDone || chunksTotal;
  return (
    <div className="sync-progress sync-progress-done">
      上次 {files} 篇 · {chunks} 个数据块
    </div>
  );
}
