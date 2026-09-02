import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const NOTE_HUB_SKILL_CHILD = "NOTE_HUB_SKILL_CHILD";

export function findRepoRoot(): string {
  if (process.env.NOTE_HUB_ROOT) return process.env.NOTE_HUB_ROOT;
  const cwd = process.cwd();
  if (
    cwd.endsWith("/skills-runtime") ||
    cwd.endsWith("/api") ||
    cwd.endsWith("/worker") ||
    cwd.endsWith("/skill-runner") ||
    cwd.endsWith("/web")
  ) {
    return join(cwd, "../..");
  }
  return cwd;
}

export function officialSkillsRoot(repoRoot = findRepoRoot()): string {
  return join(repoRoot, "skills");
}

export function officialSkillDir(name: string, repoRoot = findRepoRoot()): string {
  return join(officialSkillsRoot(repoRoot), name);
}

export function listOfficialSkillDirs(repoRoot = findRepoRoot()): string[] {
  const root = officialSkillsRoot(repoRoot);
  if (!existsSync(root)) return [];
  const names = readdirSync(root);
  return names
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, "SKILL.md")));
}

export function readSkillMd(dir: string): string {
  return readFileSync(join(dir, "SKILL.md"), "utf8");
}

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

