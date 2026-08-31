import "./load-env.ts";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env.ts";
import { authRoutes } from "./routes/auth.ts";
import { spaceRoutes } from "./routes/spaces.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { noteRoutes } from "./routes/notes.ts";
import { jsonError } from "./errors.ts";
import { enqueueSync } from "./queue.ts";
import { query } from "./db.ts";

const app = new Hono();
app.use(
  "*",
  cors({
    origin: [env.webOrigin, "http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  }),
);

app.onError((err, c) => {
  console.error(JSON.stringify({ level: "error", message: err.message, stack: err.stack }));
  return jsonError(c, 500, "internal", "服务器错误");
});

app.get("/health", (c) => c.json({ ok: true }));

const v1 = new Hono();
v1.route("/", authRoutes);
v1.route("/", spaceRoutes);
v1.route("/", connectionRoutes);
v1.route("/", noteRoutes);
app.route("/v1", v1);

app.notFound((c) => jsonError(c, 404, "not_found", "未找到"));

const port = env.apiPort;
serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ level: "info", message: `api listening on ${port}` }));
});

const TICK_MS = 5 * 60 * 1000;
setInterval(async () => {
  try {
    const r = await query<{ id: string }>(
      "SELECT id FROM connections WHERE status = 'active'",
    );
    for (const row of r.rows) await enqueueSync(row.id);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: String(e) }));
  }
}, TICK_MS).unref();
