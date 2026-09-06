"use client";
import { useEffect, useState } from "react";
import "./ambient-settings.css";
import {
  DEFAULT_AMBIENT,
  SEASON_NAME,
  SEASON_NOTE,
  resolveSeason,
  type AmbientIntensity,
  type AmbientSeasonMode,
  type AmbientSettings,
} from "./season";
import { fetchAmbient, previewAmbient, publishAmbient, readCachedAmbient, saveAmbient } from "./store";

const SEASON_CHOICES: { value: AmbientSeasonMode; label: string }[] = [
  { value: "auto", label: "跟随季节" },
  { value: "spring", label: "春" },
  { value: "summer", label: "夏" },
  { value: "autumn", label: "秋" },
  { value: "winter", label: "冬" },
];

const INTENSITY_CHOICES: { value: AmbientIntensity; label: string }[] = [
  { value: "faint", label: "极淡" },
  { value: "soft", label: "轻" },
  { value: "rich", label: "稍浓" },
];

export function AmbientPanel() {
  const [s, setS] = useState<AmbientSettings>(DEFAULT_AMBIENT);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [today, setToday] = useState("");

  useEffect(() => {
    setS(readCachedAmbient());
    setToday(SEASON_NAME[resolveSeason("auto")]);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(media.matches);
    const onChange = () => setReduced(media.matches);
    media.addEventListener("change", onChange);
    fetchAmbient()
      .then((next) => next && setS(next))
      .catch(() => setStatus(""));
    return () => media.removeEventListener("change", onChange);
  }, []);

  function update(patch: Partial<AmbientSettings>, preview = false) {
    const next = { ...s, ...patch };
    setS(next);
    publishAmbient(next);
    setFailed(false);
    setStatus("保存中…");
    if (preview) {
      previewAmbient({ season: resolveSeason(next.season) });
    }
    saveAmbient(patch)
      .then((saved) => {
        setS(saved);
        setStatus("已保存");
      })
      .catch((e: unknown) => {
        setFailed(true);
        setStatus(e instanceof Error ? e.message : "保存失败");
      });
  }

  const auto = s.season === "auto";
  const season = resolveSeason(s.season);

  return (
    <section className="ambient-panel">
      <h2>待机特效</h2>
      <p className="hint">
        停手约 45 秒，页面浮起一层当季的动静；碰一下鼠标或键盘就散。只是背景，点不到它。
      </p>
      <div className="card form-card ambient-card">
        <label className="ambient-switch">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => update({ enabled: e.currentTarget.checked })}
          />
          <span className="ambient-track" aria-hidden="true">
            <span className="ambient-knob" />
          </span>
          <span>{s.enabled ? "开启" : "关闭"}</span>
        </label>

        <div className="ambient-field">
          <span className="ambient-field-label" id="ambient-season">
            季节
          </span>
          <div className="segmented" role="group" aria-labelledby="ambient-season">
            {SEASON_CHOICES.map((c) => (
              <button
                key={c.value}
                type="button"
                className={s.season === c.value ? "active" : ""}
                aria-pressed={s.season === c.value}
                onClick={() => update({ season: c.value }, true)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="hint">
            跟随季节按 Asia/Shanghai 当天判断：3–5 月樱花，6–8 月日头与蜻蜓、偶尔一阵雨，9–11 月枫叶，12–2 月雪。
            {auto ? `今天算${today}，${SEASON_NOTE[season]}。` : `现在固定看${SEASON_NAME[season]}，${SEASON_NOTE[season]}。`}
          </p>
        </div>

        <div className="ambient-field">
          <span className="ambient-field-label" id="ambient-density">
            浓度
          </span>
          <div className="segmented" role="group" aria-labelledby="ambient-density">
            {INTENSITY_CHOICES.map((c) => (
              <button
                key={c.value}
                type="button"
                className={s.intensity === c.value ? "active" : ""}
                aria-pressed={s.intensity === c.value}
                onClick={() => update({ intensity: c.value }, true)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="hint">极淡是默认：整屏只有几片，慢慢飘，压在文字后面看得清字。</p>
        </div>

        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => previewAmbient({ season: resolveSeason(s.season) })}
          >
            预览 9 秒
          </button>
          <span className={failed ? "ambient-status is-err" : "ambient-status"}>{status}</span>
        </div>

        {reduced && (
          <p className="hint">系统开着「减少动态效果」，特效已自动停用，设置会先存着。</p>
        )}
      </div>
    </section>
  );
}
