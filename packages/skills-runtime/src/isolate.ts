import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMemoryHost } from "./host.ts";
import { parseSkillMd } from "./parse.ts";
import { findRepoRoot, helperPath, NOTE_HUB_SKILL_CHILD, officialSkillDir, readSkillMd } from "./paths.ts";
import { BUILTIN, runSkillInProcess, type LoadedSkill } from "./run.ts";
import type {
  HostApi,
  HostGrowthEvent,
  HostLink,
  HostNote,
  SkillHandler,
  SkillHook,
  SkillRunInput,
  SkillRunResult,
  WriteArtifact,
  WriteGrowthEvent,
} from "./types.ts";

export const DEFAULT_SKILL_TIMEOUT_MS = 30_000;
export const WEEKLY_REPORT_TIMEOUT_MS = 120_000;
const SECRET_ENV_RE = /secret|password|token|credential|database_url|redis_url|api_key|access_key|private_key|hub_secret/i;

const CHILD_ENV_ALLOW = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CACHE_HOME",
  "NODE_ENV",
  "NOTE_HUB_ROOT",
]);

export type SkillSnapshot = {
  notes: HostNote[];
  events: HostGrowthEvent[];
  links: HostLink[];
};

export type SkillWrites = {
  growth_events: WriteGrowthEvent[];
  reports: Array<{ range_from: string; range_to: string; markdown: string }>;
  artifacts: WriteArtifact[];
};

export type SkillChildInput = {
  space_id: string;
  space_kind?: "personal" | "team";
  hook: SkillHook;
  payload: Record<string, unknown>;
  snapshot: SkillSnapshot;
};

export type SkillChildOutput = SkillRunResult & { writes: SkillWrites };

export type SpawnSkillResult = {
  timedOut: boolean;
  killed: boolean;
  pid: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: SkillChildOutput | null;
  error?: string;
};

function emptyWrites(): SkillWrites {
  return { growth_events: [], reports: [], artifacts: [] };
}

export function timeoutForHook(hook: SkillHook): number {
  return hook === "weekly-report" ? WEEKLY_REPORT_TIMEOUT_MS : DEFAULT_SKILL_TIMEOUT_MS;
}

export function skillRunnerEntry(repoRoot = findRepoRoot()): string {
  return join(repoRoot, "apps/skill-runner/src/index.ts");
}

export function tsxBin(repoRoot = findRepoRoot()): string {
  const bin = join(repoRoot, "node_modules/.bin/tsx");
  return existsSync(bin) ? bin : "tsx";
}

export function childEnv(repoRoot = findRepoRoot()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NOTE_HUB_ROOT: repoRoot,
    [NOTE_HUB_SKILL_CHILD]: "1",
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const key of CHILD_ENV_ALLOW) {
    const v = process.env[key];
    if (v == null || v === "") continue;
    if (SECRET_ENV_RE.test(key)) continue;
    env[key] = v;
  }
  return env;
}

function asNotes(payload: Record<string, unknown>): HostNote[] {
  const raw = payload.notes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is HostNote => Boolean(n && typeof n === "object" && "id" in n)).map(slimNote);
}

function slimNote(n: HostNote): HostNote {
  return {
    id: String(n.id),
    path: String(n.path ?? ""),
    title: String(n.title ?? ""),
    markdown: n.markdown == null ? null : String(n.markdown),
    frontmatter: slimFrontmatter(n.frontmatter),
    hash: n.hash == null ? null : String(n.hash),
    updated_at: String(n.updated_at ?? ""),
  };
}

function slimFrontmatter(fm: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return fm ?? null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (SECRET_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function asStringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

export function sanitizeSkillPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    const key = k.toLowerCase();
    if (key.includes("secret") || key.includes("password") || key.includes("token") || key.includes("credential")) {
      continue;
    }
    if (key === "host" || key === "database_url" || key === "hub_secret") continue;
    out[k] = v;
  }
  return out;
}

export async function buildSkillSnapshot(skill: LoadedSkill, input: SkillRunInput): Promise<SkillSnapshot> {
  const payload = input.payload ?? {};
  let notes = asNotes(payload);
  if (!notes.length) {
    const ids = asStringIds(payload.note_ids);
    notes = (await input.host.queryNotes(ids.length ? { ids } : undefined)).map(slimNote);
  }
  let events: HostGrowthEvent[] = [];
  if (skill.manifest.permissions.growth) {
    const from = typeof payload.from === "string" ? payload.from : undefined;
    const to = typeof payload.to === "string" ? payload.to : undefined;
    events = await input.host.queryGrowth({ from, to });
  }
  let links: HostLink[] = [];
  if (skill.manifest.name === "writing-health" || input.hook === "weekly-report" || input.hook === "on-ask") {
    try {
      links = await input.host.queryLinks();
    } catch {
      links = [];
    }
  }
  return { notes, events, links };
}

export async function applySkillWrites(
  host: HostApi,
  writes: SkillWrites,
  spaceKind?: "personal" | "team",
): Promise<void> {
  if (spaceKind !== "team") {
    for (const ev of writes.growth_events) {
      await host.writeGrowthEvent(ev);
    }
  }
  for (const report of writes.reports) {
    await host.writeReport(report);
  }
  for (const artifact of writes.artifacts) {
    await host.writeArtifact(artifact);
  }
}

async function resolveHandler(dir: string, name: string): Promise<SkillHandler> {
  const helper = helperPath(dir);
  if (helper) {
    const mod = (await import(pathToFileURL(helper).href)) as Record<string, unknown>;
    if (typeof mod.handler === "function") return mod.handler as SkillHandler;
    if (typeof mod.default === "function") return mod.default as SkillHandler;
  }
  return BUILTIN[name] ?? (async () => ({ ok: false, extra: { error: "no_handler" } }));
}

/** Child-process entry: never talks to Postgres or hub secrets. */
export async function executeSkillChild(dir: string, input: SkillChildInput): Promise<SkillChildOutput> {
  const text = readSkillMd(dir);
  const { manifest, body: _body } = parseSkillMd(text);
  void _body;
  if (!manifest.hooks.includes(input.hook)) {
    return { ok: false, extra: { error: "hook_not_declared" }, writes: emptyWrites() };
  }
  const handler = await resolveHandler(dir, manifest.name);
  const spaceKind = input.space_kind === "team" ? "team" : "personal";
  const hostState = createMemoryHost({
    spaceId: input.space_id,
    userId: "skill-runner",
    spaceKind,
    notes: input.snapshot.notes ?? [],
    events: input.snapshot.events ?? [],
    links: input.snapshot.links ?? [],
  });
  const writes = emptyWrites();
  const host: HostApi = {
    queryNotes: (opts) => hostState.queryNotes(opts),
    queryGrowth: (opts) => hostState.queryGrowth(opts),
    queryLinks: (opts) => hostState.queryLinks(opts),
    queryArtifacts: (opts) => hostState.queryArtifacts(opts),
    async writeGrowthEvent(event) {
      const r = await hostState.writeGrowthEvent(event);
      if (r.created) writes.growth_events.push(event);
      return r;
    },
    async writeReport(report) {
      const r = await hostState.writeReport(report);
      writes.reports.push(report);
      return r;
    },
    async writeArtifact(artifact) {
      const r = await hostState.writeArtifact(artifact);
      writes.artifacts.push(artifact);
      return r;
    },
  };
  try {
    const result = await runSkillInProcess(
      { dir, manifest, body: "", handler },
      {
        space_id: input.space_id,
        hook: input.hook,
        payload: sanitizeSkillPayload(input.payload ?? {}),
        host,
        space_kind: spaceKind,
      },
    );
    return { ...result, writes };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, extra: { error: msg }, writes };
  }
}

function parseChildStdout(stdout: string): SkillChildOutput | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as SkillChildOutput;
  } catch {
    /* fall through */
  }
  const lines = trimmed.split(/\n/).reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t) as SkillChildOutput;
    } catch {
      /* next */
    }
  }
  return null;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export async function spawnSkillRunner(opts: {
  skillDir: string;
  input: SkillChildInput;
  timeoutMs?: number;
}): Promise<SpawnSkillResult> {
  const repoRoot = findRepoRoot();
  const timeoutMs = opts.timeoutMs ?? timeoutForHook(opts.input.hook);
  const child = spawn(tsxBin(repoRoot), [skillRunnerEntry(repoRoot), "run", opts.skillDir], {
    cwd: repoRoot,
    env: childEnv(repoRoot),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const pid = child.pid ?? null;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let killed = false;
  child.stdout?.on("data", (d: Buffer | string) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer | string) => {
    stderr += d.toString();
  });

  const wait = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

  child.stdin?.write(JSON.stringify(opts.input));
  child.stdin?.end();

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    killed = true;
    killProcessGroup(child, "SIGTERM");
    killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 400);
  }, timeoutMs);

  let exitCode: number | null = null;
  let error: string | undefined;
  try {
    exitCode = await wait;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }

  const output = parseChildStdout(stdout);
  return {
    timedOut,
    killed,
    pid,
    exitCode,
    stdout,
    stderr,
    output,
    error,
  };
}

export async function runSkillIsolated(skill: LoadedSkill, input: SkillRunInput): Promise<SkillRunResult> {
  if (!skill.manifest.hooks.includes(input.hook)) {
    return { ok: false, extra: { error: "hook_not_declared" } };
  }
  const payload = sanitizeSkillPayload(input.payload ?? {});
  const spaceKind = input.space_kind ?? (payload.space_kind === "team" ? "team" : payload.space_kind === "personal" ? "personal" : undefined);
  const snapshot = await buildSkillSnapshot(skill, { ...input, payload });
  const dir = skill.dir || officialSkillDir(skill.manifest.name);
  const spawned = await spawnSkillRunner({
    skillDir: dir,
    input: {
      space_id: input.space_id,
      space_kind: spaceKind,
      hook: input.hook,
      payload,
      snapshot,
    },
    timeoutMs: timeoutForHook(input.hook),
  });
  if (spawned.timedOut) {
    return {
      ok: false,
      extra: { error: "timeout", isolated: true, pid: spawned.pid, stderr: spawned.stderr.slice(0, 4000) },
    };
  }
  if (spawned.error && !spawned.output) {
    return {
      ok: false,
      extra: { error: spawned.error, isolated: true, pid: spawned.pid, stderr: spawned.stderr.slice(0, 4000) },
    };
  }
  const output = spawned.output;
  if (!output) {
    return {
      ok: false,
      extra: {
        error: "spawn_no_output",
        isolated: true,
        pid: spawned.pid,
        exitCode: spawned.exitCode,
        stderr: spawned.stderr.slice(0, 4000),
      },
    };
  }
  await applySkillWrites(input.host, output.writes ?? emptyWrites(), spaceKind);
  return {
    ok: output.ok,
    markdown: output.markdown,
    summary: output.summary,
    events_written: output.events_written,
    extra: { ...output.extra, isolated: true, pid: spawned.pid },
  };
}

export function envLeakedToChild(keys: string[]): string[] {
  return keys.filter((k) => SECRET_ENV_RE.test(k) || k === "DATABASE_URL" || k === "HUB_SECRET");
}
