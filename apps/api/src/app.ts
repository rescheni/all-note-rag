import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env.ts";
import { authRoutes } from "./routes/auth.ts";
import { spaceRoutes } from "./routes/spaces.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { noteRoutes } from "./routes/notes.ts";
import { askRoutes } from "./routes/ask.ts";
import { growthRoutes } from "./routes/growth.ts";
import { skillRoutes } from "./routes/skills.ts";
import { jsonError } from "./errors.ts";

export const app = new Hono();
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
v1.route("/", askRoutes);
v1.route("/", growthRoutes);
v1.route("/", skillRoutes);
app.route("/v1", v1);

app.notFound((c) => jsonError(c, 404, "not_found", "未找到"));

export default app;
