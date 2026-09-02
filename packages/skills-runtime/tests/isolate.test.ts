import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  childEnv,
  createMemoryHost,
  envLeakedToChild,
  executeSkillChild,
  findRepoRoot,
  loadOfficialSkill,
  loadSkillFromMarkdown,
  officialSkillDir,
  runSkill,
  runSkillInProcess,
  spawnSkillRunner,
} from "../src/index.ts";

const probeDir = join(findRepoRoot(), "packages/skills-runtime/tests/fixtures/isolate-probe");
const evilDir = join(findRepoRoot(), "packages/skills-runtime/tests/fixtures/evil-body");

function emptySnapshot() {
  return { notes: [], events: [], links: [] };
}

describe("skill process isolation", () => {
  it("spawns skill-runner and does not run in the parent pid", async () => {
    const spawned = await spawnSkillRunner({
      skillDir: probeDir,
      input: {
        space_id: "space-p",
        space_kind: "personal",
        hook: "post-sync",
        payload: {},
        snapshot: emptySnapshot(),
      },
      timeoutMs: 15_000,
    });
    expect(spawned.timedOut).toBe(false);
    expect(spawned.output?.ok).toBe(true);
    expect(spawned.output?.extra?.probe).toBe(true);
    const childPid = spawned.output?.extra?.pid;
    expect(typeof childPid).toBe("number");
    expect(childPid).not.toBe(process.pid);
    expect(spawned.pid).not.toBeNull();
    expect(spawned.pid).not.toBe(process.pid);
  }, 20_000);

  it("kills a hung child on timeout", async () => {
    const spawned = await spawnSkillRunner({
      skillDir: probeDir,
      input: {
        space_id: "space-p",
        hook: "post-sync",
        payload: { hang: true },
        snapshot: emptySnapshot(),
      },
      timeoutMs: 600,
    });
    expect(spawned.timedOut).toBe(true);
    expect(spawned.killed).toBe(true);
    expect(spawned.output).toBeNull();
    const pid = spawned.pid;
    expect(pid).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try {
      process.kill(pid!, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      try {
        process.kill(-pid!, "SIGKILL");
      } catch {
        try {
          process.kill(pid!, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      await new Promise((r) => setTimeout(r, 100));
      alive = true;
      try {
        process.kill(pid!, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 15_000);

  it("does not pass DB credentials or hub secrets to the child", async () => {
    const prev = {
      DATABASE_URL: process.env.DATABASE_URL,
      HUB_SECRET: process.env.HUB_SECRET,
      S3_SECRET_KEY: process.env.S3_SECRET_KEY,
    };
    process.env.DATABASE_URL = "postgres://notehub:notehub@127.0.0.1:5432/notehub";
    process.env.HUB_SECRET = "test-hub-secret";
    process.env.S3_SECRET_KEY = "minioadmin";
    try {
      const env = childEnv();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.HUB_SECRET).toBeUndefined();
      expect(env.S3_SECRET_KEY).toBeUndefined();
      const spawned = await spawnSkillRunner({
        skillDir: probeDir,
        input: {
          space_id: "space-p",
          hook: "post-sync",
          payload: {},
          snapshot: emptySnapshot(),
        },
        timeoutMs: 15_000,
      });
      expect(spawned.output?.ok).toBe(true);
      const keys = (spawned.output?.extra?.env_keys as string[]) ?? [];
      expect(envLeakedToChild(keys)).toEqual([]);
      expect(keys).not.toContain("DATABASE_URL");
      expect(keys).not.toContain("HUB_SECRET");
      expect(keys).not.toContain("S3_SECRET_KEY");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 20_000);

  it("does not eval untrusted SKILL.md body", async () => {
    expect(existsSync(join(evilDir, "SKILL.md"))).toBe(true);
    const md = await import("node:fs").then((fs) => fs.readFileSync(join(evilDir, "SKILL.md"), "utf8"));
    const loaded = loadSkillFromMarkdown(md, evilDir);
    const host = createMemoryHost({ spaceId: "s", userId: "u" });
    const inProcess = await runSkillInProcess(loaded, {
      space_id: "s",
      hook: "post-sync",
      payload: {},
      host,
    });
    expect(inProcess.ok).toBe(false);
    expect(inProcess.extra?.error).toBe("no_handler");

    const spawned = await spawnSkillRunner({
      skillDir: evilDir,
      input: {
        space_id: "s",
        hook: "post-sync",
        payload: {},
        snapshot: emptySnapshot(),
      },
      timeoutMs: 15_000,
    });
    expect(spawned.timedOut).toBe(false);
    expect(spawned.output?.ok).toBe(false);
    expect(spawned.output?.extra?.error).toBe("no_handler");
  }, 20_000);

  it("runSkill uses the spawn path and persists artifacts via the parent host", async () => {
    const dir = officialSkillDir("meeting-extract");
    const markdown = await import("node:fs").then((fs) =>
      fs.readFileSync(join(dir, "fixtures/standup-2026-08-28.md"), "utf8"),
    );
    const note = {
      id: "note-mtg-1",
      path: "Meetings/周会纪要.md",
      title: "产品周会纪要",
      markdown,
      frontmatter: { type: "meeting" },
      hash: "m1",
      updated_at: "2026-08-28T12:00:00.000Z",
    };
    const host = createMemoryHost({ spaceId: "space-t", userId: "user-1", spaceKind: "team" });
    const skill = loadOfficialSkill("meeting-extract");
    const result = await runSkill(skill, {
      space_id: "space-t",
      space_kind: "team",
      hook: "post-sync",
      payload: { notes: [note] },
      host,
    });
    expect(result.ok).toBe(true);
    expect(result.extra?.isolated).toBe(true);
    expect(result.extra?.pid).not.toBe(process.pid);
    expect(host.artifacts).toHaveLength(1);
    expect(host.artifacts[0].kind).toBe("meeting");
  }, 20_000);

  it("growth-weekly spawn rejects team spaces without writing events", async () => {
    const note = {
      id: "note-daily-1",
      path: "Daily/2026-08-25.md",
      title: "2026-08-25",
      markdown: "# 目标\n- 完成本周周报\n",
      frontmatter: {},
      hash: "x",
      updated_at: "2026-08-25T12:00:00.000Z",
    };
    const out = await executeSkillChild(officialSkillDir("growth-weekly"), {
      space_id: "space-team",
      space_kind: "team",
      hook: "post-sync",
      payload: { notes: [note] },
      snapshot: { notes: [note], events: [], links: [] },
    });
    expect(out.ok).toBe(false);
    expect(out.extra?.error).toBe("growth_personal_only");
    expect(out.writes.growth_events).toHaveLength(0);
  });
});
