import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeSkillChild, listHooks, parseSkillMd, type SkillChildInput } from "@note-hub/skills-runtime";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const cmd = process.argv[2] ?? "hooks";
const dirArg = process.argv[3];
const dir = resolve(dirArg ?? join(process.cwd(), "skills/growth-weekly"));

if (cmd === "run") {
  const raw = await readStdin();
  let input: SkillChildInput;
  try {
    input = JSON.parse(raw) as SkillChildInput;
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, extra: { error: "invalid_stdin" }, writes: { growth_events: [], reports: [], artifacts: [] } }) + "\n");
    process.exit(1);
  }
  try {
    const out = await executeSkillChild(dir, input);
    process.stdout.write(JSON.stringify(out) + "\n");
    if (!out.ok) process.exitCode = 1;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    process.stdout.write(
      JSON.stringify({
        ok: false,
        extra: { error },
        writes: { growth_events: [], reports: [], artifacts: [] },
      }) + "\n",
    );
    process.exit(1);
  }
} else {
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");
  const { manifest, body } = parseSkillMd(text);
  if (cmd === "parse") {
    console.log(JSON.stringify({ dir, manifest, body_chars: body.length }, null, 2));
  } else {
    console.log(JSON.stringify({ name: manifest.name, version: manifest.version, hooks: listHooks(manifest) }, null, 2));
  }
}
