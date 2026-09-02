import { growthWeeklyHandler } from "./growth-weekly.ts";
import { meetingExtractHandler } from "./meeting-extract.ts";
import { writingHealthHandler } from "./writing-health.ts";
import { parseSkillMd } from "./parse.ts";
import { NOTE_HUB_SKILL_CHILD, officialSkillDir, readSkillMd } from "./paths.ts";
import type { SkillHandler, SkillManifest, SkillRunInput, SkillRunResult } from "./types.ts";

export const BUILTIN: Record<string, SkillHandler> = {
  "growth-weekly": growthWeeklyHandler,
  "meeting-extract": meetingExtractHandler,
  "writing-health": writingHealthHandler,
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

/** In-process test double. Production callers must use `runSkill` (child process). */
export async function runSkillInProcess(skill: LoadedSkill, input: SkillRunInput): Promise<SkillRunResult> {
  if (!skill.manifest.hooks.includes(input.hook)) {
    return { ok: false, extra: { error: "hook_not_declared" } };
  }
  const payload = sanitizePayload(input.payload ?? {});
  return skill.handler({ ...input, payload });
}

/**
 * Run a skill in an isolated OS child (`apps/skill-runner`).
 * Parent never executes skill handlers except when `NOTE_HUB_SKILL_CHILD=1` (inside the runner).
 */
export async function runSkill(skill: LoadedSkill, input: SkillRunInput): Promise<SkillRunResult> {
  if (process.env[NOTE_HUB_SKILL_CHILD] === "1") {
    return runSkillInProcess(skill, input);
  }
  const { runSkillIsolated } = await import("./isolate.ts");
  return runSkillIsolated(skill, input);
}

export async function runOfficialHook(name: string, input: SkillRunInput): Promise<SkillRunResult> {
  const skill = loadOfficialSkill(name);
  return runSkill(skill, input);
}
