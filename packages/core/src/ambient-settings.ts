/**
 * 待机特效（seasonal idle ambience）preferences.
 * Stored per user in the same hub_settings table the AI endpoint uses,
 * under id = `ambient:<user_id>`, in the jsonb `data` column.
 */

export const AMBIENT_SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type AmbientSeason = (typeof AMBIENT_SEASONS)[number];

/** "auto" derives the season from the current date in the user's timezone. */
export type AmbientSeasonMode = "auto" | AmbientSeason;

export const AMBIENT_INTENSITIES = ["faint", "soft", "rich"] as const;
export type AmbientIntensity = (typeof AMBIENT_INTENSITIES)[number];

export type AmbientSettings = {
  enabled: boolean;
  season: AmbientSeasonMode;
  intensity: AmbientIntensity;
};

export const DEFAULT_AMBIENT_SETTINGS: AmbientSettings = {
  enabled: true,
  season: "auto",
  intensity: "faint",
};

export function ambientSettingId(userId: string): string {
  return `ambient:${userId}`;
}

function isSeasonMode(v: unknown): v is AmbientSeasonMode {
  return v === "auto" || (typeof v === "string" && (AMBIENT_SEASONS as readonly string[]).includes(v));
}

function isIntensity(v: unknown): v is AmbientIntensity {
  return typeof v === "string" && (AMBIENT_INTENSITIES as readonly string[]).includes(v);
}

/** Unknown / partial payloads fall back to defaults; never throws. */
export function normalizeAmbientSettings(raw: unknown): AmbientSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_AMBIENT_SETTINGS.enabled,
    season: isSeasonMode(o.season) ? o.season : DEFAULT_AMBIENT_SETTINGS.season,
    intensity: isIntensity(o.intensity) ? o.intensity : DEFAULT_AMBIENT_SETTINGS.intensity,
  };
}

/** Only keeps the keys the caller actually sent, already validated. */
export function ambientPatchFrom(raw: unknown): Partial<AmbientSettings> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const patch: Partial<AmbientSettings> = {};
  if (typeof o.enabled === "boolean") patch.enabled = o.enabled;
  if (isSeasonMode(o.season)) patch.season = o.season;
  if (isIntensity(o.intensity)) patch.intensity = o.intensity;
  return patch;
}

type Sql = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export async function loadAmbientSettings(query: Sql, userId: string): Promise<AmbientSettings> {
  try {
    const r = await query(`SELECT data FROM hub_settings WHERE id = $1`, [ambientSettingId(userId)]);
    const data = r.rows[0]?.data;
    const parsed = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
    return normalizeAmbientSettings(parsed);
  } catch {
    return { ...DEFAULT_AMBIENT_SETTINGS };
  }
}

export async function saveAmbientSettings(
  query: Sql,
  userId: string,
  patch: Partial<AmbientSettings>,
): Promise<AmbientSettings> {
  const current = await loadAmbientSettings(query, userId);
  const next = normalizeAmbientSettings({ ...current, ...patch });
  await query(
    `INSERT INTO hub_settings (id, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [ambientSettingId(userId), JSON.stringify(next)],
  );
  return next;
}
