import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { app } from "../src/app.ts";
import { env } from "../src/env.ts";
import { pool } from "../src/db.ts";
import { redis, syncFileJobId, syncFileQueue } from "../src/queue.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = `filesync-${suffix}@example.test`;
const password = "secret1";

async function parse(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

function headers(token?: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", ...(extra ?? {}) };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function post(path: string, body: unknown, token?: string, extra?: Record<string, string>) {
  return parse(
    await app.request(path, {
      method: "POST",
      headers: headers(token, extra),
      body: JSON.stringify(body),
    }),
  );
}

describe("file-level s3 hook", () => {
  let token = "";
  let userId = "";
  let spaceId = "";
  let connId = "";

  beforeAll(async () => {
    const a = await post("/v1/auth/register", { email, password, display_name: "同步" });
    expect(a.status).toBe(201);
    token = a.body.token;
    userId = a.body.user.id;
    spaceId = a.body.space.id;
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO connections (space_id, source, name, config, status)
       VALUES ($1, 'obsidian', 'vault-hook', $2::jsonb, 'active')
       RETURNING id`,
      [
        spaceId,
        JSON.stringify({
          bucket: "obsidian-src",
          remote_prefix: "vault1",
          endpoint: env.s3Endpoint,
          region: "us-east-1",
          force_path_style: true,
        }),
      ],
    );
    connId = ins.rows[0].id;
  });

  afterAll(async () => {
    try {
      if (connId) {
        const job = await syncFileQueue.getJob(syncFileJobId(connId));
        if (job) try { await job.remove(); } catch { /* */ }
        const next = await syncFileQueue.getJob(`${syncFileJobId(connId)}-next`);
        if (next) try { await next.remove(); } catch { /* */ }
      }
      if (userId) {
        await pool.query("DELETE FROM spaces WHERE owner_user_id = $1", [userId]);
        await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      }
    } finally {
      await redis.quit();
      await pool.end();
    }
  });

  it("maps vault1/Daily/x.md on obsidian-src to the fixture connection", async () => {
    const r = await post(
      "/v1/hooks/s3",
      {
        Records: [
          {
            eventName: "s3:ObjectCreated:Put",
            s3: { bucket: { name: "obsidian-src" }, object: { key: "vault1/Daily/x.md" } },
          },
        ],
      },
      undefined,
      { "x-hub-secret": env.hubSecret },
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const jobs = Array.isArray(r.body.jobs) ? r.body.jobs : [];
    const ids = [r.body.connection_id, ...jobs.map((j: { connection_id: string }) => j.connection_id)];
    expect(ids).toContain(connId);
    const job = jobs.find((j: { connection_id: string }) => j.connection_id === connId) ?? r.body;
    expect(job.job_id).toBe(syncFileJobId(connId));
    expect(job.keys).toContain("vault1/Daily/x.md");
    expect(JSON.stringify(r.body)).not.toContain(env.s3SecretKey);
    expect(JSON.stringify(r.body)).not.toMatch(/secret_key|access_key/i);
  });

  it("accepts { bucket, key } and editor file-level sync", async () => {
    const hook = await post(
      "/v1/hooks/s3",
      { bucket: "obsidian-src", key: "vault1/Daily/x.md", eventName: "s3:ObjectCreated:Put" },
      undefined,
      { "x-hub-secret": env.hubSecret },
    );
    expect(hook.status).toBe(200);
    const hookIds = [
      hook.body.connection_id,
      ...(Array.isArray(hook.body.jobs) ? hook.body.jobs.map((j: { connection_id: string }) => j.connection_id) : []),
    ];
    expect(hookIds).toContain(connId);

    const sync = await post(`/v1/connections/${connId}/sync`, { keys: ["vault1/Daily/x.md"] }, token);
    expect(sync.status).toBe(200);
    expect(sync.body.ok).toBe(true);
    expect(sync.body.job_id).toMatch(/^syncfile-/);
    expect(sync.body.keys).toEqual(["vault1/Daily/x.md"]);
  });

  it("debounces a burst of puts into one job with merged keys", async () => {
    const a = await post(
      "/v1/hooks/s3",
      { bucket: "obsidian-src", key: "vault1/Daily/a.md", eventName: "s3:ObjectCreated:Put" },
      undefined,
      { "x-hub-secret": env.hubSecret },
    );
    const b = await post(
      "/v1/hooks/s3",
      { bucket: "obsidian-src", key: "vault1/Daily/b.md", eventName: "s3:ObjectRemoved:Delete" },
      undefined,
      { authorization: `Bearer ${env.hubSecret}` },
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const jobA = (a.body.jobs ?? []).find((j: { connection_id: string }) => j.connection_id === connId) ?? a.body;
    const jobB = (b.body.jobs ?? []).find((j: { connection_id: string }) => j.connection_id === connId) ?? b.body;
    expect(jobA.job_id).toBe(syncFileJobId(connId));
    expect(jobB.job_id).toBe(jobA.job_id);
    const queued = await syncFileQueue.getJob(syncFileJobId(connId));
    expect(queued).toBeTruthy();
    const keys = (queued?.data?.keys ?? jobB.keys) as string[];
    expect(keys).toEqual(expect.arrayContaining(["vault1/Daily/a.md", "vault1/Daily/b.md"]));
  });

  it("unknown bucket 404", async () => {
    const r = await post(
      "/v1/hooks/s3",
      { bucket: "no-such-bucket", key: "vault1/Daily/x.md" },
      undefined,
      { "x-hub-secret": env.hubSecret },
    );
    expect(r.status).toBe(404);
  });

  it("ignores unrelated prefix and hub canonical keys", async () => {
    const wrongPrefix = await post(
      "/v1/hooks/s3",
      { bucket: "obsidian-src", key: "other-vault/Daily/x.md" },
      undefined,
      { "x-hub-secret": env.hubSecret },
    );
    expect(wrongPrefix.status).toBe(404);
    const hub = await post(
      "/v1/hooks/s3",
      { bucket: env.s3Bucket, key: "canonical/space/note/note.md" },
      undefined,
      { "x-hub-secret": env.hubSecret },
    );
    expect(hub.status).toBe(404);
    const ignored = await post(
      "/v1/hooks/s3",
      { bucket: "obsidian-src", key: "vault1/.obsidian/app.json" },
      undefined,
      { "x-hub-secret": env.hubSecret },
    );
    expect(ignored.status).toBe(404);
  });

  it("rejects missing hub secret", async () => {
    const r = await post("/v1/hooks/s3", { bucket: "obsidian-src", key: "vault1/Daily/x.md" });
    expect(r.status).toBe(401);
  });
});
