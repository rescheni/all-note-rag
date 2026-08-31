import { parseSkillMd } from "./parse.ts";
import { listOfficialSkillDirs, officialSkillDir, readSkillMd } from "./paths.ts";
import type { SkillManifest, SqlQuery } from "./types.ts";

export type CatalogSkill = SkillManifest & { id: string; official: true; path: string };

export function listOfficialCatalog(): CatalogSkill[] {
  const dirs = listOfficialSkillDirs();
  const out: CatalogSkill[] = [];
  for (const dir of dirs) {
    const { manifest } = parseSkillMd(readSkillMd(dir));
    out.push({ ...manifest, id: manifest.name, official: true, path: dir });
  }
  if (!out.some((s) => s.id === "growth-weekly")) {
    const dir = officialSkillDir("growth-weekly");
    try {
      const { manifest } = parseSkillMd(readSkillMd(dir));
      out.push({ ...manifest, id: manifest.name, official: true, path: dir });
    } catch {
      // catalog file missing in some test cwd
    }
  }
  return out;
}

export async function upsertOfficialSkillRow(query: SqlQuery, skillId = "growth-weekly"): Promise<SkillManifest> {
  const dir = officialSkillDir(skillId);
  const { manifest } = parseSkillMd(readSkillMd(dir));
  await query(
    `INSERT INTO skills (id, version, name, description, hooks, manifest, path)
     VALUES ($1,$2,$3,$4,$5::text[],$6::jsonb,$7)
     ON CONFLICT (id) DO UPDATE SET
       version = EXCLUDED.version,
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       hooks = EXCLUDED.hooks,
       manifest = EXCLUDED.manifest,
       path = EXCLUDED.path`,
    [
      manifest.name,
      manifest.version,
      manifest.name,
      manifest.description,
      manifest.hooks,
      JSON.stringify(manifest),
      `skills/${manifest.name}`,
    ],
  );
  return manifest;
}

export async function ensureSkillOnSpace(
  query: SqlQuery,
  spaceId: string,
  skillId = "growth-weekly",
): Promise<{ enabled: boolean; installed: boolean }> {
  await upsertOfficialSkillRow(query, skillId);
  const existing = await query(
    "SELECT enabled FROM space_skills WHERE space_id = $1 AND skill_id = $2",
    [spaceId, skillId],
  );
  if (existing.rows[0]) {
    return { enabled: Boolean(existing.rows[0].enabled), installed: true };
  }
  await query(
    `INSERT INTO space_skills (space_id, skill_id, enabled, config)
     VALUES ($1,$2,true,'{}'::jsonb)
     ON CONFLICT (space_id, skill_id) DO NOTHING`,
    [spaceId, skillId],
  );
  return { enabled: true, installed: true };
}

export async function setSpaceSkillEnabled(
  query: SqlQuery,
  spaceId: string,
  skillId: string,
  enabled: boolean,
): Promise<boolean> {
  const r = await query(
    `UPDATE space_skills SET enabled = $3 WHERE space_id = $1 AND skill_id = $2`,
    [spaceId, skillId, enabled],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function isSkillEnabled(
  query: SqlQuery,
  spaceId: string,
  skillId: string,
): Promise<boolean> {
  const r = await query(
    "SELECT enabled FROM space_skills WHERE space_id = $1 AND skill_id = $2",
    [spaceId, skillId],
  );
  return Boolean(r.rows[0]?.enabled);
}

export function isOfficialSkillId(skillId: string): boolean {
  if (!skillId.trim()) return false;
  return listOfficialCatalog().some((s) => s.id === skillId);
}
