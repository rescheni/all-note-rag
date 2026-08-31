import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
