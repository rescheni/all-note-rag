import YAML from "yaml";
import { ALLOWED_HOOKS, type SkillHook, type SkillManifest } from "./types.ts";

export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const raw = text.replace(/^\uFEFF/, "");
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const rest = raw.slice(3).replace(/^\r?\n/, "");
  const m = rest.match(/^([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  let parsed: unknown = {};
  try {
    parsed = YAML.parse(m[1]) ?? {};
  } catch {
    parsed = {};
  }
  const frontmatter =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: m[2] };
}

export function isAllowedHook(value: string): value is SkillHook {
  return (ALLOWED_HOOKS as readonly string[]).includes(value);
}

export function parseSkillMd(text: string): { manifest: SkillManifest; body: string } {
  const { frontmatter, body } = splitFrontmatter(text);
  const name = String(frontmatter.name ?? "").trim();
  if (!name) throw new Error("SKILL.md missing name");
  const hooksRaw = frontmatter.hooks;
  const hooks: SkillHook[] = [];
  if (Array.isArray(hooksRaw)) {
    for (const h of hooksRaw) {
      const s = String(h).trim();
      if (isAllowedHook(s) && !hooks.includes(s)) hooks.push(s);
    }
  }
  const permRaw =
    frontmatter.permissions && typeof frontmatter.permissions === "object" && !Array.isArray(frontmatter.permissions)
      ? (frontmatter.permissions as Record<string, unknown>)
      : {};
  const spaces = permRaw.spaces === "confirmed-list" ? "confirmed-list" : "current";
  const growth = permRaw.growth === "write" || permRaw.growth === "read" ? permRaw.growth : undefined;
  const notes = permRaw.notes === "read" ? "read" : undefined;
  const tools = Array.isArray(frontmatter.tools) ? frontmatter.tools.map((t) => String(t)) : undefined;
  const manifest: SkillManifest = {
    name,
    description: String(frontmatter.description ?? "").trim(),
    version: String(frontmatter.version ?? "0.0.0").trim() || "0.0.0",
    hooks,
    permissions: {
      spaces,
      growth,
      notes,
      network: permRaw.network === true ? true : false,
    },
    tools,
  };
  return { manifest, body };
}

export function listHooks(manifest: SkillManifest): SkillHook[] {
  return [...manifest.hooks];
}
