/**
 * Canvas painting for the seasonal idle ambience.
 * Cost rules: only dirty rectangles are cleared (never the whole canvas), the sun
 * is a static CSS layer (no per-frame full-screen gradient), and the caller drives
 * this at a capped frame rate.
 * No dependency, no per-frame path building for the falling pieces: every leaf /
 * petal / flake is pre-rendered once into a small sprite and then blitted.
 * Colours stay inside the hub palette (warm paper + 抹茶), never emoji, never neon.
 */
import type { AmbientSeason } from "./season";

export type SceneConfig = {
  season: AmbientSeason;
  /** Number of drifting pieces (leaves / petals / flakes) at 1440x900. */
  count: number;
  rain: boolean;
};

const SPRITE_PX = 64;
const INK = "60, 51, 44";

/** 秋: 琥珀 / 铁锈 / 赭石 / 将落未落的青 —— all warm, all paper-friendly. */
const MAPLE = ["#c07a46", "#b0603a", "#a8843f", "#8d8552"];
/** 春: 暖灰粉，不是糖果粉. */
const SAKURA = ["#dca49d", "#d0908a", "#e8b9b1"];
/** 冬: 暖白雪粒. */
const SNOW = ["#fffdf8", "#eef1ea"];
const DRAGONFLY_BODY = "#6f8a72";

type Drifter = {
  sprite: number;
  x: number;
  y: number;
  size: number;
  vy: number;
  vx: number;
  rot: number;
  spin: number;
  swayA: number;
  swayW: number;
  swayP: number;
  flutter: number;
  flutterW: number;
  alpha: number;
  squash: boolean;
};

type Flyer = {
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  w: [number, number, number, number];
  p: [number, number, number, number];
  size: number;
  alpha: number;
  beat: number;
  beatW: number;
  angle: number;
  px: number;
  py: number;
};

type Drop = { x: number; y: number; len: number; vy: number; near: boolean };

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function makeSprite(dpr: number, paint: (c: CanvasRenderingContext2D, r: number) => void): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = Math.round(SPRITE_PX * dpr);
  el.height = Math.round(SPRITE_PX * dpr);
  const c = el.getContext("2d");
  if (c) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.translate(SPRITE_PX / 2, SPRITE_PX / 2);
    c.lineJoin = "round";
    c.lineCap = "round";
    paint(c, SPRITE_PX / 2 - 3);
  }
  return el;
}

/**
 * 枫叶: pointed lobes, deep sinuses, a few teeth and a petiole — drawn as one
 * polygon (right half mirrored) so it stays a leaf, not a five-petal flower.
 */
const MAPLE_HALF: [number, number][] = [
  [0.0, 1.0],
  [0.17, 0.72],
  [0.12, 0.62],
  [0.26, 0.52],
  [0.13, 0.4],
  [0.38, 0.52],
  [0.64, 0.44],
  [0.45, 0.26],
  [0.56, 0.16],
  [0.34, 0.1],
  [0.66, 0.02],
  [0.88, -0.1],
  [0.5, -0.22],
  [0.36, -0.42],
  [0.14, -0.36],
  [0.045, -0.46],
  [0.045, -0.95],
];

function paintMaple(c: CanvasRenderingContext2D, r: number, color: string) {
  const R = r * 0.95;
  c.beginPath();
  MAPLE_HALF.forEach(([x, y], i) => {
    const px = x * R;
    const py = -y * R;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  });
  for (let i = MAPLE_HALF.length - 1; i >= 0; i--) {
    const [x, y] = MAPLE_HALF[i];
    c.lineTo(-x * R, -y * R);
  }
  c.closePath();
  c.fillStyle = color;
  c.fill();
  c.strokeStyle = `rgba(${INK}, 0.13)`;
  c.lineWidth = Math.max(0.6, R * 0.03);
  c.stroke();

  c.strokeStyle = `rgba(${INK}, 0.18)`;
  c.lineWidth = Math.max(0.6, R * 0.032);
  const hub: [number, number] = [0, 0.34 * R];
  for (const [x, y] of [
    [0, -0.82],
    [0.5, -0.34],
    [-0.5, -0.34],
    [0.66, 0.02],
    [-0.66, 0.02],
  ] as [number, number][]) {
    c.beginPath();
    c.moveTo(hub[0], hub[1]);
    c.lineTo(x * R, y * R);
    c.stroke();
  }
}

/** Sakura petal: notched tip, base at the bottom, faint blush toward the tip. */
function paintPetal(c: CanvasRenderingContext2D, r: number, color: string) {
  const R = r * 0.95;
  c.translate(0, R * 0.42);
  c.beginPath();
  c.moveTo(0, 0);
  c.bezierCurveTo(-0.50 * R, -0.26 * R, -0.46 * R, -0.70 * R, -0.30 * R, -0.94 * R);
  c.quadraticCurveTo(-0.15 * R, -0.70 * R, 0, -0.68 * R);
  c.quadraticCurveTo(0.15 * R, -0.70 * R, 0.30 * R, -0.94 * R);
  c.bezierCurveTo(0.46 * R, -0.70 * R, 0.50 * R, -0.26 * R, 0, 0);
  c.closePath();
  const g = c.createLinearGradient(0, 0, 0, -R);
  g.addColorStop(0, color);
  g.addColorStop(1, "#eec7bf");
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = "rgba(174, 118, 113, 0.45)";
  c.lineWidth = Math.max(0.5, R * 0.022);
  c.stroke();
  c.strokeStyle = "rgba(174, 118, 113, 0.22)";
  c.lineWidth = Math.max(0.5, R * 0.02);
  for (const dx of [-0.14, 0, 0.14]) {
    c.beginPath();
    c.moveTo(0, -R * 0.06);
    c.quadraticCurveTo(dx * R * 0.9, -R * 0.45, dx * R * 1.6, -R * 0.72);
    c.stroke();
  }
}

/** Six-arm crystal, warm white, soft edge. `dot` renders the far-away grains. */
function paintFlake(c: CanvasRenderingContext2D, r: number, color: string, dot: boolean) {
  const R = r * 0.85;
  if (dot) {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, R * 0.42);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(255, 253, 248, 0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, R * 0.42, 0, Math.PI * 2);
    c.fill();
    return;
  }
  // Two passes: a cool shade so the crystal reads on warm paper, warm white on top.
  for (const pass of [0, 1] as const) {
    c.strokeStyle = pass === 0 ? "rgba(140, 158, 149, 0.52)" : color;
    c.lineWidth = pass === 0 ? Math.max(1.6, R * 0.17) : Math.max(0.9, R * 0.08);
    c.shadowColor = pass === 0 ? "rgba(146, 163, 154, 0.25)" : "rgba(255, 255, 255, 0.5)";
    c.shadowBlur = pass === 0 ? R * 0.1 : R * 0.14;
    drawArms(c, R);
  }
  c.shadowBlur = 0;
}

function drawArms(c: CanvasRenderingContext2D, R: number) {
  for (let i = 0; i < 6; i++) {
    const th = (i / 6) * Math.PI * 2;
    const ex = Math.cos(th) * R;
    const ey = Math.sin(th) * R;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(ex, ey);
    c.stroke();
    for (const at of [0.48, 0.76]) {
      const bx = Math.cos(th) * R * at;
      const by = Math.sin(th) * R * at;
      const arm = R * (at === 0.48 ? 0.28 : 0.18);
      for (const s of [-1, 1]) {
        const bt = th + s * 0.9;
        c.beginPath();
        c.moveTo(bx, by);
        c.lineTo(bx + Math.cos(bt) * arm, by + Math.sin(bt) * arm);
        c.stroke();
      }
    }
  }
}

function spritesFor(season: AmbientSeason, dpr: number): HTMLCanvasElement[] {
  if (season === "autumn") return MAPLE.map((col) => makeSprite(dpr, (c, r) => paintMaple(c, r, col)));
  if (season === "spring") return SAKURA.map((col) => makeSprite(dpr, (c, r) => paintPetal(c, r, col)));
  if (season === "winter") {
    return [
      makeSprite(dpr, (c, r) => paintFlake(c, r, SNOW[0], false)),
      makeSprite(dpr, (c, r) => paintFlake(c, r, SNOW[1], false)),
      makeSprite(dpr, (c, r) => paintFlake(c, r, SNOW[0], true)),
    ];
  }
  return [];
}

const SIZE: Record<AmbientSeason, [number, number]> = {
  autumn: [18, 34],
  spring: [17, 29],
  winter: [13, 24],
  summer: [0, 0],
};

const ALPHA: Record<AmbientSeason, [number, number]> = {
  autumn: [0.5, 0.88],
  spring: [0.75, 1],
  winter: [0.55, 0.92],
  summer: [0.6, 0.9],
};

const FALL: Record<AmbientSeason, [number, number]> = {
  autumn: [15, 27],
  spring: [11, 20],
  winter: [9, 18],
  summer: [0, 0],
};

export function createScene(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  let dpr = 1;
  let w = 0;
  let h = 0;
  let cfg: SceneConfig = { season: "autumn", count: 6, rain: false };
  let sprites: HTMLCanvasElement[] = [];
  let drifters: Drifter[] = [];
  let flyers: Flyer[] = [];
  let drops: Drop[] = [];
  let rainMix = 0;
  let t = 0;
  /** Flat [x,y,w,h,...] of what the last frame touched: we clear those, never the whole canvas. */
  let dirty: number[] = [];
  let clearAll = true;

  function mark(x: number, y: number, r: number) {
    dirty.push(x - r, y - r, r * 2, r * 2);
  }

  function spawnDrifter(fresh: boolean): Drifter {
    const [s0, s1] = SIZE[cfg.season];
    const [f0, f1] = FALL[cfg.season];
    const size = rand(s0, s1);
    const depth = (size - s0) / Math.max(1, s1 - s0);
    return {
      sprite: Math.floor(Math.random() * Math.max(1, sprites.length)),
      x: rand(-40, w + 40),
      y: fresh ? rand(-h * 0.2, h) : rand(-h * 0.35, -30),
      size,
      vy: rand(f0, f1) * (0.7 + 0.5 * depth),
      vx: rand(-7, 7),
      rot: rand(0, Math.PI * 2),
      spin: rand(-0.22, 0.22) * (cfg.season === "winter" ? 0.4 : 1),
      swayA: rand(6, 17) * (cfg.season === "winter" ? 0.7 : 1),
      swayW: rand(0.18, 0.42),
      swayP: rand(0, Math.PI * 2),
      flutter: rand(0, Math.PI * 2),
      flutterW: cfg.season === "winter" ? 0 : rand(0.35, 0.85),
      alpha: ALPHA[cfg.season][0] + (ALPHA[cfg.season][1] - ALPHA[cfg.season][0]) * depth,
      squash: cfg.season !== "winter",
    };
  }

  function spawnFlyer(): Flyer {
    return {
      cx: rand(w * 0.18, w * 0.86),
      cy: rand(h * 0.14, h * 0.68),
      ax: rand(w * 0.07, w * 0.16),
      ay: rand(h * 0.05, h * 0.12),
      w: [rand(0.17, 0.29), rand(0.42, 0.66), rand(0.2, 0.33), rand(0.5, 0.78)],
      p: [rand(0, 6.28), rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)],
      size: rand(44, 58),
      alpha: rand(0.7, 0.95),
      beat: rand(0, 6.28),
      beatW: rand(15, 21),
      angle: 0,
      px: 0,
      py: 0,
    };
  }

  function spawnDrop(fresh: boolean): Drop {
    const near = Math.random() < 0.45;
    return {
      x: rand(-0.1 * w, w * 1.1),
      y: fresh ? rand(-h, h) : rand(-h * 0.4, -20),
      len: near ? rand(20, 30) : rand(11, 18),
      vy: near ? rand(320, 430) : rand(210, 300),
      near,
    };
  }

  function rebuild() {
    sprites = spritesFor(cfg.season, dpr);
    drifters = [];
    flyers = [];
    drops = [];
    if (cfg.season === "summer") {
      const n = Math.min(3, Math.max(2, Math.round(cfg.count * 0.28)));
      for (let i = 0; i < n; i++) flyers.push(spawnFlyer());
      if (cfg.rain) {
        const rainN = Math.round(cfg.count * 2) + 8;
        for (let i = 0; i < rainN; i++) drops.push(spawnDrop(true));
      }
    } else {
      for (let i = 0; i < cfg.count; i++) drifters.push(spawnDrifter(true));
    }
    clearAll = true;
  }

  function drawFlyer(c: CanvasRenderingContext2D, f: Flyer, dt: number) {
    const x = f.cx + f.ax * Math.sin(f.w[0] * t + f.p[0]) + f.ax * 0.42 * Math.sin(f.w[1] * t + f.p[1]);
    const y = f.cy + f.ay * Math.sin(f.w[2] * t + f.p[2]) + f.ay * 0.5 * Math.sin(f.w[3] * t + f.p[3]);
    const dx = x - f.px;
    const dy = y - f.py;
    if (Math.hypot(dx, dy) > 0.04) {
      let d = Math.atan2(dy, dx) - f.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      f.angle += d * Math.min(1, dt * 3.2);
    }
    f.px = x;
    f.py = y;
    f.beat += dt * f.beatW;
    const flick = 0.5 + 0.5 * Math.sin(f.beat);
    const L = f.size;
    mark(x, y, L * 0.7);

    c.save();
    c.translate(x, y);
    c.rotate(f.angle);

    c.globalAlpha = f.alpha * (0.26 + 0.13 * flick);
    c.fillStyle = "#fdf6ea";
    for (const [ox, base] of [
      [0.08, 1.32],
      [-0.12, 1.82],
    ] as const) {
      for (const sgn of [-1, 1]) {
        c.save();
        c.translate(ox * L, 0);
        c.rotate(sgn * (base + 0.1 * flick));
        c.beginPath();
        c.ellipse(L * 0.24, 0, L * 0.24, L * 0.052, 0, 0, Math.PI * 2);
        c.fill();
        c.restore();
      }
    }

    c.globalAlpha = f.alpha * 0.68;
    c.fillStyle = DRAGONFLY_BODY;
    c.beginPath();
    c.moveTo(L * 0.3, 0);
    c.quadraticCurveTo(L * 0.12, -L * 0.08, -L * 0.04, -L * 0.036);
    c.quadraticCurveTo(-L * 0.3, -L * 0.022, -L * 0.54, 0);
    c.quadraticCurveTo(-L * 0.3, L * 0.022, -L * 0.04, L * 0.036);
    c.quadraticCurveTo(L * 0.12, L * 0.08, L * 0.3, 0);
    c.closePath();
    c.fill();
    c.beginPath();
    c.arc(L * 0.31, 0, L * 0.055, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function drawRain(c: CanvasRenderingContext2D, dt: number) {
    for (const d of drops) {
      d.y += d.vy * dt;
      d.x -= d.vy * 0.13 * dt;
      if (d.y - d.len > h || d.x < -60) {
        const n = spawnDrop(false);
        d.x = n.x;
        d.y = n.y;
        d.len = n.len;
        d.vy = n.vy;
        d.near = n.near;
      }
      dirty.push(d.x - 3, d.y - d.len - 3, d.len * 0.13 + 7, d.len + 7);
    }
    for (const near of [false, true]) {
      c.globalAlpha = (near ? 0.26 : 0.15) * rainMix;
      c.strokeStyle = "#7c8a80";
      c.lineWidth = near ? 1.05 : 0.75;
      c.beginPath();
      for (const d of drops) {
        if (d.near !== near) continue;
        c.moveTo(d.x, d.y);
        c.lineTo(d.x + d.len * 0.13, d.y - d.len);
      }
      c.stroke();
    }
  }

  return {
    resize(nextDpr: number, width: number, height: number) {
      dpr = nextDpr;
      w = width;
      h = height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      clearAll = true;
      if (!drifters.length && !flyers.length && !drops.length) rebuild();
    },
    configure(next: SceneConfig) {
      const shape = next.season !== cfg.season || next.count !== cfg.count || next.rain !== cfg.rain;
      cfg = next;
      rainMix = cfg.rain ? rainMix : 0;
      if (shape) rebuild();
    },
    clear() {
      dirty.length = 0;
      clearAll = true;
      if (ctx) ctx.clearRect(0, 0, w, h);
    },
    /** dt in seconds. Called from the throttled loop only while the layer is showing. */
    frame(dt: number) {
      if (!ctx || !w || !h) return;
      t += dt;
      if (clearAll) {
        ctx.clearRect(0, 0, w, h);
        clearAll = false;
      } else {
        for (let i = 0; i < dirty.length; i += 4) ctx.clearRect(dirty[i], dirty[i + 1], dirty[i + 2], dirty[i + 3]);
      }
      dirty.length = 0;

      if (cfg.season === "summer") {
        if (cfg.rain) {
          rainMix = Math.min(1, rainMix + dt / 3.5);
          drawRain(ctx, dt);
        }
        for (const f of flyers) drawFlyer(ctx, f, dt);
        ctx.globalAlpha = 1;
        return;
      }

      for (const p of drifters) {
        p.swayP += p.swayW * dt;
        p.x += (p.vx + Math.sin(p.swayP) * p.swayA) * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        p.flutter += p.flutterW * dt;
        if (p.y - p.size > h) {
          Object.assign(p, spawnDrifter(false));
        } else if (p.x < -60) p.x = w + 40;
        else if (p.x > w + 60) p.x = -40;

        const sprite = sprites[p.sprite % Math.max(1, sprites.length)];
        if (!sprite) continue;
        mark(p.x, p.y, p.size * 0.8);
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        if (p.squash) ctx.scale(Math.max(0.52, Math.abs(Math.cos(p.flutter))), 1);
        ctx.drawImage(sprite, -p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    },
  };
}

export type Scene = ReturnType<typeof createScene>;
