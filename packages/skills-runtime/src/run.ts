import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { growthWeeklyHandler } from "./growth-weekly.ts";
import { parseSkillMd } from "./parse.ts";
import { officialSkillDir, readSkillMd } from "./paths.ts";
import type { SkillHandler, SkillManifest, SkillRunInput, SkillRunResult } from "./types.ts";

const BUILTIN: Record<string, SkillHandler> = {
  "growth-weekly": growthWeeklyHandler,
};

export type LoadedSkill = {
  dir: string;
  manifest: SkillManifest;
  body: string;
  handler: SkillHandler;
};

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    const key = k.toLowerCase();
    if (key.includes("secret") || key.includes("password") || key.includes("token") || key.includes("credential")) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function loadSkillFromMarkdown(text: string, dir = ""): LoadedSkill {
  const { manifest, body } = parseSkillMd(text);
  const handler = BUILTIN[manifest.name] ?? (async () => ({ ok: false, extra: { error: "no_handler" } }));
  return { dir, manifest, body, handler };
}

export function loadOfficialSkill(name = "growth-weekly"): LoadedSkill {
  const dir = officialSkillDir(name);
  const text = readSkillMd(dir);
  return loadSkillFromMarkdown(text, dir);
}

export async function runSkill(skill: LoadedSkill, input: SkillRunInput): Promise<SkillRunResult> {
  if (!skill.manifest.hooks.includes(input.hook)) {
    return { ok: false, extra: { error: "hook_not_declared" } };
  }
  const payload = sanitizePayload(input.payload ?? {});
  return skill.handler({ ...input, payload });
}

export async function runOfficialHook(
  name: string,
  input: SkillRunInput,
): Promise<SkillRunResult> {
  const skill = loadOfficialSkill(name);
  return runSkill(skill, input);
}

/** Optional helper file is ignored when builtin exists. P1 does not spawn child processes. */
export function helperPath(dir: string): string | null {
  for (const f of ["skill.ts", "skill.js", "index.ts", "index.js"]) {
    const p = join(dir, f);
    if (existsSync(p)) return p;
  }
  return null;
}

export function helperFileUrl(dir: string): string | null {
  const p = helperPath(dir);
  return p ? pathToFileURL(p).href : null;
}
