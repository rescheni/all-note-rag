import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listHooks, parseSkillMd } from "@note-hub/skills-runtime";

const cmd = process.argv[2] ?? "hooks";
const dirArg = process.argv[3];
const dir = resolve(dirArg ?? join(process.cwd(), "skills/growth-weekly"));
const text = readFileSync(join(dir, "SKILL.md"), "utf8");
const { manifest, body } = parseSkillMd(text);

if (cmd === "parse") {
  console.log(JSON.stringify({ dir, manifest, body_chars: body.length }, null, 2));
} else {
  console.log(JSON.stringify({ name: manifest.name, version: manifest.version, hooks: listHooks(manifest) }, null, 2));
}
