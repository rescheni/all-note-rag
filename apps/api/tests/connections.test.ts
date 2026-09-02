import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/load-env.ts";
import { decryptSecret } from "@note-hub/core";
import { app } from "../src/app.ts";
import { env } from "../src/env.ts";
import { pool } from "../src/db.ts";
import { enqueueSync, redis } from "../src/queue.ts";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = `conn-${suffix}@example.test`;
const password = "secret1";
const ACCESS = `ak-${suffix}`;
const SECRET = `sk-${suffix}`;
const REPO = `rp-${suffix}`;

async function parse(res: Response) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function post(path: string, body: unknown, token?: string) {
  return parse(
    await app.request(path, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string, token?: string) {
  return parse(await app.request(path, { headers: headers(token) }));
}

async function patch(path: string, body: unknown, token?: string) {
  return parse(
    await app.request(path, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify(body),
    }),
  );
}

async function readStoredSecrets(connId: string) {
  const r = await pool.query<{ ciphertext: string }>(
    `SELECT s.ciphertext FROM connections c JOIN secrets s ON s.id::text = c.secrets_ref WHERE c.id = $1::uuid`,
    [connId],
  );
  const row = r.rows[0];
  expect(row).toBeTruthy();
  return JSON.parse(decryptSecret(row.ciphertext, env.hubSecret)) as Record<string, string>;
}

function assertNoSecretLeak(body: unknown) {
  const raw = JSON.stringify(body);
  expect(raw).not.toContain(ACCESS);
  expect(raw).not.toContain(SECRET);
  expect(raw).not.toContain(REPO);
  expect(raw).not.toMatch(/ciphertext/i);
}

describe("connections GET + PATCH secrets", () => {
  let token = "";
  let userId = "";
  let spaceId = "";
  let connId = "";
  let viewerToken = "";
  let viewerId = "";

  beforeAll(async () => {
    const a = await post("/v1/auth/register", { email, password, display_name: "连" });
    expect(a.status).toBe(201);
    token = a.body.token;
    userId = a.body.user.id;
    spaceId = a.body.space.id;

    const team = await post("/v1/spaces", { name: "连接测试团", kind: "team" }, token);
    expect(team.status).toBe(201);
    spaceId = team.body.space.id;

    const v = await post("/v1/auth/register", {
      email: `conn-v-${suffix}@example.test`,
      password,
      display_name: "看",
    });
    expect(v.status).toBe(201);
    viewerToken = v.body.token;
    viewerId = v.body.user.id;
    const added = await post(
      `/v1/spaces/${spaceId}/members`,
      { email: `conn-v-${suffix}@example.test`, role: "viewer" },
      token,
    );
    expect(added.status).toBe(201);

    const created = await post(
      `/v1/spaces/${spaceId}/connections`,
      {
        source: "siyuan",
        name: "我的思源",
        mode: "workspace",
        config: {
          endpoint: "http://reschen.cn:9000/",
          bucket: "siyuan",
          region: "us-east-1",
          workspace_prefix: "workspace",
        },
        secrets: { access_key: ACCESS, secret_key: SECRET, repo_password: REPO },
      },
      token,
    );
    expect(created.status).toBe(201);
    connId = created.body.connection.id;
    assertNoSecretLeak(created.body);
  });

  afterAll(async () => {
    try {
      const ids = [userId, viewerId].filter(Boolean);
      if (ids.length) {
        await pool.query("DELETE FROM spaces WHERE owner_user_id = ANY($1::uuid[])", [ids]);
        await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids]);
      }
    } finally {
      await redis.quit();
      await pool.end();
    }
  });

  it("GET /v1/connections/:id returns public connection and secret flags only", async () => {
    const r = await get(`/v1/connections/${connId}`, token);
    expect(r.status).toBe(200);
    expect(r.body.connection.id).toBe(connId);
    expect(r.body.connection.name).toBe("我的思源");
    expect(r.body.connection.config.endpoint).toBe("http://reschen.cn:9000/");
    expect(r.body.connection.config.bucket).toBe("siyuan");
    expect(r.body.connection.secrets_ref).toBe("configured");
    expect(r.body.secrets).toEqual({
      configured: true,
      access_key: true,
      secret_key: true,
      token: false,
      access_token: false,
      refresh_token: false,
      repo_password: true,
      app_id: false,
      app_secret: false,
    });
    assertNoSecretLeak(r.body);

    const asViewer = await get(`/v1/connections/${connId}`, viewerToken);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.connection.id).toBe(connId);
    assertNoSecretLeak(asViewer.body);
  });

  it("PATCH blank secrets does not wipe stored keys", async () => {
    const before = await readStoredSecrets(connId);
    expect(before.access_key).toBe(ACCESS);
    expect(before.secret_key).toBe(SECRET);
    expect(before.repo_password).toBe(REPO);

    const r = await patch(
      `/v1/connections/${connId}`,
      {
        name: "我的思源",
        config: {
          endpoint: "http://reschen.cn:9000/",
          bucket: "siyuan",
          workspace_prefix: "workspace",
        },
        secrets: { access_key: "", secret_key: "", repo_password: "", token: "" },
      },
      token,
    );
    expect(r.status).toBe(200);
    assertNoSecretLeak(r.body);

    const after = await readStoredSecrets(connId);
    expect(after.access_key).toBe(ACCESS);
    expect(after.secret_key).toBe(SECRET);
    expect(after.repo_password).toBe(REPO);

    const flags = await get(`/v1/connections/${connId}`, token);
    expect(flags.body.secrets.access_key).toBe(true);
    expect(flags.body.secrets.secret_key).toBe(true);
    expect(flags.body.secrets.repo_password).toBe(true);
  });

  it("GET /v1/spaces/:id/connections includes latest_run progress shape", async () => {
    const before = await get(`/v1/spaces/${spaceId}/connections`, token);
    expect(before.status).toBe(200);
    const listed = before.body.connections.find((c: { id: string }) => c.id === connId);
    expect(listed).toBeTruthy();
    expect(listed.latest_run).toBeNull();

    await pool.query(
      `INSERT INTO sync_run (
         connection_id, finished_at, upserts, files_total, files_done, chunks_total, chunks_done, failed, skipped
       ) VALUES ($1, NULL, 0, 2104, 128, 18220, 3901, 0, 0)`,
      [connId],
    );

    const mid = await get(`/v1/spaces/${spaceId}/connections`, token);
    expect(mid.status).toBe(200);
    const running = mid.body.connections.find((c: { id: string }) => c.id === connId);
    expect(running.latest_run).toBeTruthy();
    expect(running.latest_run.finished_at).toBeNull();
    expect(running.latest_run.files_total).toBe(2104);
    expect(running.latest_run.files_done).toBe(128);
    expect(running.latest_run.chunks_total).toBe(18220);
    expect(running.latest_run.chunks_done).toBe(3901);
    expect(running.latest_run).toHaveProperty("id");
    expect(running.latest_run).toHaveProperty("started_at");
    expect(running.latest_run).toHaveProperty("upserts");
    expect(running.latest_run).toHaveProperty("failed");
    expect(running.latest_run).toHaveProperty("skipped");
    assertNoSecretLeak(mid.body);

    const sync = await get(`/v1/connections/${connId}/sync`, token);
    expect(sync.status).toBe(200);
    expect(sync.body.runs[0].files_done).toBe(128);
    expect(sync.body.runs[0].chunks_done).toBe(3901);
    expect(sync.body.runs[0].finished_at).toBeNull();

    await pool.query(
      `INSERT INTO sync_run (
         connection_id, started_at, finished_at, upserts, files_total, files_done, chunks_total, chunks_done
       ) VALUES ($1, now() + interval '1 second', now(), 9, 9, 9, 9, 9)`,
      [connId],
    );
    const prefer = await get(`/v1/spaces/${spaceId}/connections`, token);
    const after = prefer.body.connections.find((c: { id: string }) => c.id === connId);
    expect(after.latest_run.finished_at).toBeNull();
    expect(after.latest_run.files_done).toBe(128);

    const skipped = await enqueueSync(connId);
    expect(skipped.queued).toBe(false);
    expect(skipped.reason).toBe("sync_in_progress");
  });

  it("PATCH typed repo_password updates only that key", async () => {
    const next = `${REPO}-2`;
    const r = await patch(
      `/v1/connections/${connId}`,
      { secrets: { repo_password: next, access_key: "" } },
      token,
    );
    expect(r.status).toBe(200);
    const after = await readStoredSecrets(connId);
    expect(after.access_key).toBe(ACCESS);
    expect(after.secret_key).toBe(SECRET);
    expect(after.repo_password).toBe(next);
  });
});
