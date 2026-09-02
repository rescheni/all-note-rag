"use client";

export type HeatDay = { date: string; notes: number; upserts?: number };

function weekdaySun0(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

function tooltip(day: HeatDay): string {
  const [, m, d] = day.date.split("-");
  return `${day.notes} 篇 · ${Number(m)}月${Number(d)}日`;
}

function level(n: number, max: number): number {
  if (n <= 0 || max <= 0) return 0;
  const t = n / max;
  if (t > 0.75) return 4;
  if (t > 0.5) return 3;
  if (t > 0.25) return 2;
  return 1;
}

export function Heatmap({ days }: { days: HeatDay[] }) {
  if (!days.length) return null;
  const max = Math.max(0, ...days.map((d) => d.notes));
  const pad = weekdaySun0(days[0]!.date);
  const cells: (HeatDay | null)[] = [];
  for (let i = 0; i < pad; i++) cells.push(null);
  cells.push(...days);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="heat-wrap">
      <h2>活动</h2>
      <div className="heat-grid" role="img" aria-label="笔记更新热力图">
        {cells.map((day, i) => {
          if (!day) {
            return <span key={`e-${i}`} className="heat-cell empty" style={{ ["--i" as string]: i }} />;
          }
          const lv = level(day.notes, max);
          return (
            <span
              key={day.date}
              className={`heat-cell lv${lv}`}
              style={{ ["--i" as string]: i }}
              title={tooltip(day)}
            />
          );
        })}
      </div>
      <div className="heat-legend">
        少
        <i className="heat-cell" style={{ opacity: 1, animation: "none" }} />
        <i className="heat-cell lv1" style={{ opacity: 1, animation: "none" }} />
        <i className="heat-cell lv2" style={{ opacity: 1, animation: "none" }} />
        <i className="heat-cell lv3" style={{ opacity: 1, animation: "none" }} />
        <i className="heat-cell lv4" style={{ opacity: 1, animation: "none" }} />
        多
      </div>
    </div>
  );
}
