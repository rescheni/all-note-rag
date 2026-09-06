"use client";
import { useEffect, useRef } from "react";
import "./ambient-layer.css";
import { createScene, type Scene } from "./paint";
import { resolveSeason, type AmbientIntensity, type AmbientSeason } from "./season";
import {
  AMBIENT_PREVIEW_EVENT,
  fetchAmbient,
  readCachedAmbient,
  subscribeAmbient,
  type AmbientPreviewDetail,
} from "./store";

/** Quiet reading is the default state; the effect only shows up after a real pause. */
const IDLE_MS = 45_000;
/** 夏天「偶尔下雨」: only a minority of idle sessions bring rain. */
const RAIN_CHANCE = 0.32;
const PREVIEW_MS = 9_000;
const FADE_OUT_MS = 520;
const CHECK_MS = 2_000;
/** A slow drift does not need 60fps, and the canvas is the only cost we pay. */
const FPS = 20;
const FRAME_MS = 1000 / FPS;
/** Retina backing stores are the expensive part of a full-viewport canvas. */
const MAX_DPR = 1.25;

const COUNT: Record<AmbientIntensity, number> = { faint: 7, soft: 11, rich: 16 };
const OPACITY: Record<AmbientIntensity, number> = { faint: 0.62, soft: 0.8, rich: 0.95 };

export function AmbientLayer() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sunRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rootNode = rootRef.current;
    const canvasNode = canvasRef.current;
    const sunNode = sunRef.current;
    if (!rootNode || !canvasNode || !sunNode) return;
    const root: HTMLDivElement = rootNode;
    const sun: HTMLDivElement = sunNode;
    const canvas: HTMLCanvasElement = canvasNode;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let settings = readCachedAmbient();
    let scene: Scene | null = null;
    let raf = 0;
    let frameTimer = 0;
    let lastFrame = 0;
    let running = false;
    let on = false;
    let stopAt = 0;
    let previewUntil = 0;
    let previewSeason: AmbientSeason | null = null;
    let previewRain: boolean | null = null;
    let rainNow = false;
    let lastActive = performance.now();
    let resizeTimer = 0;
    let disposed = false;

    const viewport = () => ({
      w: canvas.clientWidth || window.innerWidth,
      h: canvas.clientHeight || window.innerHeight,
    });

    function configure(s: Scene) {
      const { w, h } = viewport();
      const scale = Math.min(1.5, Math.max(0.7, (w * h) / (1440 * 900)));
      const season = previewSeason ?? resolveSeason(settings.season);
      const rain = season === "summer" && rainNow;
      s.configure({ season, count: Math.max(3, Math.round(COUNT[settings.intensity] * scale)), rain });
      // 太阳 is a static CSS gradient layer: no per-frame full-screen fill.
      sun.style.display = season === "summer" ? "block" : "none";
      sun.style.opacity = season === "summer" ? (rain ? "0.4" : "1") : "0";
    }

    function measure(s: Scene) {
      const { w, h } = viewport();
      s.resize(Math.min(MAX_DPR, window.devicePixelRatio || 1), w, h);
    }

    function halt() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      if (frameTimer) window.clearTimeout(frameTimer);
      raf = 0;
      frameTimer = 0;
      scene?.clear();
    }

    /** setTimeout + rAF: ~30 wakeups a second instead of 60, and none when hidden. */
    function schedule() {
      frameTimer = window.setTimeout(() => {
        frameTimer = 0;
        raf = requestAnimationFrame(loop);
      }, FRAME_MS);
    }

    function loop(now: number) {
      raf = 0;
      if (disposed) return;
      const dt = Math.min(0.12, Math.max(0, (now - lastFrame) / 1000));
      lastFrame = now;
      scene?.frame(dt);
      if (!on && now >= stopAt) {
        halt();
        return;
      }
      schedule();
    }

    function show(preview: boolean) {
      if (media.matches || document.hidden) return;
      if (!preview && !settings.enabled) return;
      if (!scene) scene = createScene(canvas);
      rainNow = preview && previewRain !== null ? previewRain : Math.random() < RAIN_CHANCE;
      measure(scene);
      configure(scene);
      root.style.setProperty("--ambient-op", String(OPACITY[settings.intensity]));
      root.classList.add("is-on");
      on = true;
      stopAt = 0;
      if (!running) {
        running = true;
        lastFrame = performance.now();
        raf = requestAnimationFrame(loop);
      }
    }

    function hide(immediate = false) {
      if (!on && !running) return;
      on = false;
      root.classList.remove("is-on");
      stopAt = performance.now() + (immediate ? 0 : FADE_OUT_MS);
      if (immediate) halt();
    }

    function endPreview() {
      previewUntil = 0;
      previewSeason = null;
      previewRain = null;
    }

    // Ref-only bookkeeping: no React state, so nothing under this layer re-renders.
    function onActivity() {
      lastActive = performance.now();
      if (previewUntil) return;
      if (on) hide();
    }

    function tick() {
      const now = performance.now();
      if (previewUntil) {
        if (now >= previewUntil) {
          endPreview();
          hide();
        }
        return;
      }
      if (!settings.enabled || media.matches || document.hidden) {
        if (on) hide();
        return;
      }
      if (!on && now - lastActive >= IDLE_MS) show(false);
    }

    function onVisibility() {
      if (document.hidden) {
        endPreview();
        hide(true);
      }
      lastActive = performance.now();
    }

    /** Another window (or the note preview iframe) has focus: nothing to be ambient about. */
    function onBlur() {
      endPreview();
      hide(true);
      lastActive = performance.now();
    }

    function onFocus() {
      lastActive = performance.now();
    }

    function onResize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!scene) return;
        measure(scene);
        configure(scene);
      }, 180);
    }

    function onPreview(e: Event) {
      const d = ((e as CustomEvent<AmbientPreviewDetail>).detail ?? {}) as AmbientPreviewDetail;
      previewSeason = d.season ?? null;
      previewRain = typeof d.rain === "boolean" ? d.rain : null;
      previewUntil = performance.now() + (d.ms ?? PREVIEW_MS);
      show(true);
    }

    function onReducedMotion() {
      if (media.matches) {
        endPreview();
        hide(true);
      }
    }

    const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const ev of events) {
      window.addEventListener(ev, onActivity, { passive: true, capture: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("resize", onResize);
    window.addEventListener(AMBIENT_PREVIEW_EVENT, onPreview as EventListener);
    media.addEventListener("change", onReducedMotion);
    const timer = window.setInterval(tick, CHECK_MS);
    const unsubscribe = subscribeAmbient((next) => {
      settings = next;
      if (!settings.enabled && !previewUntil) {
        hide();
        return;
      }
      if (scene && (on || previewUntil)) {
        root.style.setProperty("--ambient-op", String(OPACITY[settings.intensity]));
        configure(scene);
      }
    });

    void fetchAmbient()
      .then((s) => {
        if (!s || disposed) return;
        settings = s;
        if (!settings.enabled) hide();
      })
      .catch(() => {
        /* signed out or API asleep: the cached preference stands */
      });

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearTimeout(resizeTimer);
      for (const ev of events) {
        window.removeEventListener(ev, onActivity, { capture: true } as EventListenerOptions);
      }
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("resize", onResize);
      window.removeEventListener(AMBIENT_PREVIEW_EVENT, onPreview as EventListener);
      media.removeEventListener("change", onReducedMotion);
      unsubscribe();
      halt();
      root.classList.remove("is-on");
    };
  }, []);

  return (
    <div ref={rootRef} className="ambient-layer" aria-hidden="true">
      <div ref={sunRef} className="ambient-sun" />
      <canvas ref={canvasRef} className="ambient-canvas" />
    </div>
  );
}
