/** 待机特效：season model shared by the overlay and the settings control. */

export const AMBIENT_SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type AmbientSeason = (typeof AMBIENT_SEASONS)[number];
export type AmbientSeasonMode = "auto" | AmbientSeason;

export const AMBIENT_INTENSITIES = ["faint", "soft", "rich"] as const;
export type AmbientIntensity = (typeof AMBIENT_INTENSITIES)[number];

export type AmbientSettings = {
  enabled: boolean;
  season: AmbientSeasonMode;
  intensity: AmbientIntensity;
};

export const DEFAULT_AMBIENT: AmbientSettings = {
  enabled: true,
  season: "auto",
  intensity: "faint",
};

/** The hub is a personal, China-based tool: seasons follow 北半球 + Asia/Shanghai. */
export const AMBIENT_TZ = "Asia/Shanghai";

export function seasonFromMonth(month: number): AmbientSeason {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

export function monthInHubTz(now: Date = new Date()): number {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: AMBIENT_TZ, month: "numeric" }).format(now);
    const m = Number.parseInt(s, 10);
    if (m >= 1 && m <= 12) return m;
  } catch {
    /* Intl without tz data: fall back to the local month */
  }
  return now.getMonth() + 1;
}

export function resolveSeason(mode: AmbientSeasonMode, now: Date = new Date()): AmbientSeason {
  return mode === "auto" ? seasonFromMonth(monthInHubTz(now)) : mode;
}

export const SEASON_NAME: Record<AmbientSeason, string> = {
  spring: "春",
  summer: "夏",
  autumn: "秋",
  winter: "冬",
};

export const SEASON_NOTE: Record<AmbientSeason, string> = {
  spring: "樱花慢慢落",
  summer: "日光与蜻蜓，偶尔一阵雨",
  autumn: "枫叶打着旋儿落下",
  winter: "雪粒轻轻飘",
};

export function normalizeAmbient(raw: unknown): AmbientSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const season = o.season;
  const intensity = o.intensity;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_AMBIENT.enabled,
    season:
      season === "auto" || (typeof season === "string" && (AMBIENT_SEASONS as readonly string[]).includes(season))
        ? (season as AmbientSeasonMode)
        : DEFAULT_AMBIENT.season,
    intensity:
      typeof intensity === "string" && (AMBIENT_INTENSITIES as readonly string[]).includes(intensity)
        ? (intensity as AmbientIntensity)
        : DEFAULT_AMBIENT.intensity,
  };
}
