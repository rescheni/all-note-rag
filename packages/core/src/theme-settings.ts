/**
 * UI theme preferences.
 * Stored per user in hub_settings under id = `theme:<user_id>`, jsonb `data`.
 */

export const HUB_THEMES = ["matcha", "ink", "plain"] as const;
export type HubTheme = (typeof HUB_THEMES)[number];

export type ThemeSettings = {
  theme: HubTheme;
};

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  theme: "matcha",
};

export function themeSettingId(userId: string): string {
  return `theme:${userId}`;
}

function isTheme(v: unknown): v is HubTheme {
  return typeof v === "string" && (HUB_THEMES as readonly string[]).includes(v);
}

/** Unknown / partial payloads fall back to defaults; never throws. */
export function normalizeThemeSettings(raw: unknown): ThemeSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    theme: isTheme(o.theme) ? o.theme : DEFAULT_THEME_SETTINGS.theme,
  };
}

/** Only keeps the keys the caller actually sent, already validated. */
export function themePatchFrom(raw: unknown): Partial<ThemeSettings> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const patch: Partial<ThemeSettings> = {};
  if (isTheme(o.theme)) patch.theme = o.theme;
  return patch;
}

type Sql = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export async function loadThemeSettings(query: Sql, userId: string): Promise<ThemeSettings> {
  try {
    const r = await query(`SELECT data FROM hub_settings WHERE id = $1`, [themeSettingId(userId)]);
    const data = r.rows[0]?.data;
    const parsed = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
    return normalizeThemeSettings(parsed);
  } catch {
    return { ...DEFAULT_THEME_SETTINGS };
  }
}

export async function saveThemeSettings(
  query: Sql,
  userId: string,
  patch: Partial<ThemeSettings>,
): Promise<ThemeSettings> {
  const current = await loadThemeSettings(query, userId);
  const next = normalizeThemeSettings({ ...current, ...patch });
  await query(
    `INSERT INTO hub_settings (id, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [themeSettingId(userId), JSON.stringify(next)],
  );
  return next;
}
