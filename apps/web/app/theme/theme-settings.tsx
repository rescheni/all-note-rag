"use client";
import { useEffect, useState } from "react";
import "./theme-settings.css";
import { HUB_THEMES, THEME_META, type HubTheme, type ThemeSettings } from "./themes";
import { fetchTheme, publishTheme, readCachedTheme, saveTheme } from "./store";

export function ThemePanel() {
  const [s, setS] = useState<ThemeSettings>(readCachedTheme());
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setS(readCachedTheme());
    fetchTheme()
      .then((next) => next && setS(next))
      .catch(() => setStatus(""));
  }, []);

  function pick(theme: HubTheme) {
    if (s.theme === theme) return;
    const next = { theme };
    setS(next);
    publishTheme(next);
    setFailed(false);
    setStatus("保存中…");
    saveTheme(theme)
      .then((saved) => {
        setS(saved);
        setStatus("已保存 · 整站已切换");
      })
      .catch((e: unknown) => {
        setFailed(true);
        setStatus(e instanceof Error ? e.message : "保存失败");
      });
  }

  const active = THEME_META[s.theme];

  return (
    <section className="theme-panel">
      <h2>界面主题</h2>
      <p className="hint">三套连贯配色，不是皮肤商店。默认仍是抹茶纸色。</p>
      <div className="card form-card theme-card">
        <div className="theme-grid" role="radiogroup" aria-label="界面主题">
          {HUB_THEMES.map((id) => {
            const meta = THEME_META[id];
            const on = s.theme === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                className={on ? "theme-option is-active" : "theme-option"}
                onClick={() => pick(id)}
              >
                <span className="theme-swatch" aria-hidden="true">
                  <span style={{ background: meta.swatch[0] }} />
                  <span style={{ background: meta.swatch[1] }} />
                  <span style={{ background: meta.swatch[2] }} />
                </span>
                <span className="theme-option-label">{meta.label}</span>
                <p className="theme-option-note">{meta.note}</p>
              </button>
            );
          })}
        </div>
        <p className="theme-live-note">当前：{active.label}。点选即预览并写入账号。</p>
        {status && <p className={failed ? "theme-status is-err" : "theme-status"}>{status}</p>}
      </div>
    </section>
  );
}
