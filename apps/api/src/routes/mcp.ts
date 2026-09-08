/**
 * MCP-compatible HTTP JSON-RPC endpoint for external AIs (Cursor / Claude Desktop).
 * Auth: same as the rest of /v1 — Bearer hub_… API token (or JWT / Basic).
 *
 * Methods: initialize | tools/list | tools/call | ping
 * Tools: search_notes | get_note | list_connections | list_spaces
 */
import { Hono } from "hono";
import { toTsQueryTokens } from "@note-hub/core";
import { clipQuote, previewUrl } from "@note-hub/retrieve";
import { query } from "../db.ts";
import { jsonError } from "../errors.ts";
import { requireRole, requireUser, type AuthUser } from "../auth.ts";

type Vars = { user: AuthUser };
export const mcpRoutes = new Hono<{ Variables: Vars }>();
mcpRoutes.use("*", requireUser);

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "note-hub", version: "0.1.0" };

type JsonRpcId = string | number | null;
type JsonRpcReq = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const TOOLS: ToolDef[] = [
  {
    name: "search_notes",
    description: "在笔记中枢当前用户可见的空间内搜索笔记（标题 / 路径 / 全文）。返回标题、路径、摘要与 note_id。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        space: {
          type: "string",
          description: "空间 id；省略则使用第一个个人空间",
        },
        limit: { type: "number", description: "最多返回条数，默认 10，最大 30" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_note",
    description: "按 note_id 或 path 读取一篇笔记的标题与 Markdown 正文（只读）。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "笔记 UUID" },
        path: { type: "string", description: "笔记 path（与 id 二选一）" },
        space: { type: "string", description: "空间 id（按 path 查找时建议提供）" },
      },
    },
  },
  {
    name: "list_connections",
    description: "列出某空间已接入的笔记源连接（思源 / Notion / 飞书 / Obsidian）。",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "空间 id；省略则使用第一个个人空间" },
      },
    },
  },
  {
    name: "list_spaces",
    description: "列出当前用户可访问的空间。",
    inputSchema: { type: "object", properties: {} },
  },
];

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

async function defaultSpaceId(userId: string): Promise<string | null> {
  const r = await query<{ space_id: string }>(
    `SELECT sm.space_id
     FROM space_members sm
     INNER JOIN spaces s ON s.id = sm.space_id
     WHERE sm.user_id = $1
     ORDER BY CASE WHEN s.kind = 'personal' THEN 0 ELSE 1 END, s.created_at ASC
     LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.space_id ?? null;
}

async function resolveSpace(userId: string, space?: unknown): Promise<string | null> {
  if (typeof space === "string" && space.trim()) return space.trim();
  return defaultSpaceId(userId);
}

async function toolSearchNotes(userId: string, args: Record<string, unknown>) {
  const q = typeof args.query === "string" ? args.query.trim() : "";
  if (!q) throw new Error("query 必填");
  const spaceId = await resolveSpace(userId, args.space);
  if (!spaceId) throw new Error("找不到可用空间");
  const gate = await requireRole(userId, spaceId, "viewer");
  if (!gate.ok) throw new Error(gate.error === "not_found" ? "空间不存在" : "权限不足");
  const limitRaw = typeof args.limit === "number" ? args.limit : Number(args.limit);
  const limit = Math.min(30, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 10));
  const like = "%" + q + "%";
  const tokens = toTsQueryTokens(q);
  const fts = tokens || "";
  const results = await query<{
    id: string;
    title: string;
    path: string;
    connection_id: string;
    snippet: string | null;
    source_block_id: string | null;
  }>(
    `WITH title_path AS (
       SELECT n.id,
              (CASE WHEN n.title ILIKE $2 THEN 2.0 ELSE 0 END
               + CASE WHEN n.path ILIKE $2 THEN 1.5 ELSE 0 END)::float8 AS base_rank
       FROM notes n
       WHERE n.space_id = $1 AND n.deleted_at IS NULL
         AND note_visible_to(n.acl_snapshot, $4::uuid, $5::text)
         AND (n.title ILIKE $2 OR n.path ILIKE $2)
     ),
     fts_notes AS (
       SELECT ch.note_id AS id,
              max(CASE WHEN $3 <> '' THEN ts_rank(ch.fts, to_tsquery('simple', $3)) ELSE 0 END)::float8 AS base_rank
       FROM chunks ch
       INNER JOIN notes n ON n.id = ch.note_id AND n.deleted_at IS NULL
       WHERE $3 <> ''
         AND n.space_id = $1 AND ch.space_id = $1
         AND CASE WHEN $3 <> '' THEN ch.fts @@ to_tsquery('simple', $3) ELSE false END
         AND note_visible_to(n.acl_snapshot, $4::uuid, $5::text)
       GROUP BY ch.note_id
       ORDER BY max(CASE WHEN $3 <> '' THEN ts_rank(ch.fts, to_tsquery('simple', $3)) ELSE 0 END) DESC
       LIMIT 50
     ),
     combined AS (
       SELECT id, max(base_rank) AS base_rank
       FROM (
         SELECT * FROM title_path
         UNION ALL
         SELECT * FROM fts_notes
       ) u
       GROUP BY id
     )
     SELECT n.id, n.title, n.path, n.connection_id,
            COALESCE(c.snippet, left(COALESCE(n.markdown, ''), 180)) AS snippet,
            c.source_block_id
     FROM combined m
     INNER JOIN notes n ON n.id = m.id
     LEFT JOIN LATERAL (
       SELECT left(ch.text, 180) AS snippet, b.source_block_id,
              CASE WHEN $3 <> '' THEN ts_rank(ch.fts, to_tsquery('simple', $3)) ELSE 0::float4 END AS rank
       FROM chunks ch
       LEFT JOIN blocks b ON b.id = ch.block_id
       WHERE ch.note_id = n.id
         AND $3 <> ''
         AND CASE WHEN $3 <> '' THEN ch.fts @@ to_tsquery('simple', $3) ELSE false END
       ORDER BY rank DESC NULLS LAST
       LIMIT 1
     ) c ON true
     ORDER BY GREATEST(m.base_rank, COALESCE(c.rank, 0)) DESC NULLS LAST, n.updated_at DESC
     LIMIT $6`,
    [spaceId, like, fts, userId, gate.mem.role, limit],
  );
  return {
    space_id: spaceId,
    query: q,
    results: results.rows.map((row) => ({
      note_id: row.id,
      title: row.title,
      path: row.path,
      connection_id: row.connection_id,
      snippet: clipQuote(row.snippet ?? "", 180),
      source_block_id: row.source_block_id,
      preview_url: previewUrl(row.id, row.source_block_id),
    })),
  };
}

async function toolGetNote(userId: string, args: Record<string, unknown>) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!id && !path) throw new Error("请提供 id 或 path");

  let row: {
    id: string;
    space_id: string;
    title: string;
    path: string;
    markdown: string | null;
    connection_id: string;
  } | undefined;

  if (id) {
    const r = await query<{
      id: string;
      space_id: string;
      title: string;
      path: string;
      markdown: string | null;
      connection_id: string;
    }>(
      `SELECT id, space_id, title, path, markdown, connection_id
       FROM notes WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    row = r.rows[0];
  } else {
    const spaceId = await resolveSpace(userId, args.space);
    if (!spaceId) throw new Error("找不到可用空间");
    const r = await query<{
      id: string;
      space_id: string;
      title: string;
      path: string;
      markdown: string | null;
      connection_id: string;
    }>(
      `SELECT id, space_id, title, path, markdown, connection_id
       FROM notes
       WHERE space_id = $1 AND deleted_at IS NULL
         AND (path = $2 OR path = ($2 || '.sy'))
       ORDER BY updated_at DESC
       LIMIT 1`,
      [spaceId, path],
    );
    row = r.rows[0];
  }
  if (!row) throw new Error("笔记不存在");
  const gate = await requireRole(userId, row.space_id, "viewer");
  if (!gate.ok) throw new Error(gate.error === "not_found" ? "笔记不存在" : "权限不足");
  const vis = await query<{ ok: boolean }>(
    `SELECT note_visible_to(acl_snapshot, $2::uuid, $3::text) AS ok FROM notes WHERE id = $1`,
    [row.id, userId, gate.mem.role],
  );
  if (!vis.rows[0]?.ok) throw new Error("笔记不存在");
  const md = row.markdown ?? "";
  const max = 24000;
  return {
    note_id: row.id,
    space_id: row.space_id,
    title: row.title,
    path: row.path,
    connection_id: row.connection_id,
    preview_url: previewUrl(row.id),
    markdown: md.length > max ? md.slice(0, max) + "\n\n…(截断)" : md,
    truncated: md.length > max,
  };
}

async function toolListConnections(userId: string, args: Record<string, unknown>) {
  const spaceId = await resolveSpace(userId, args.space);
  if (!spaceId) throw new Error("找不到可用空间");
  const gate = await requireRole(userId, spaceId, "viewer");
  if (!gate.ok) throw new Error(gate.error === "not_found" ? "空间不存在" : "权限不足");
  const r = await query<{
    id: string;
    name: string;
    source_type: string;
    status: string;
    last_sync_at: string | null;
  }>(
    `SELECT id, name, source_type, status, last_sync_at
     FROM connections WHERE space_id = $1
     ORDER BY created_at ASC`,
    [spaceId],
  );
  return {
    space_id: spaceId,
    connections: r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      source_type: row.source_type,
      status: row.status,
      last_sync_at: row.last_sync_at,
    })),
  };
}

async function toolListSpaces(userId: string) {
  const r = await query<{
    id: string;
    kind: string;
    name: string;
    role: string;
  }>(
    `SELECT s.id, s.kind, s.name, sm.role
     FROM spaces s
     INNER JOIN space_members sm ON sm.space_id = s.id
     WHERE sm.user_id = $1
     ORDER BY CASE WHEN s.kind = 'personal' THEN 0 ELSE 1 END, s.created_at ASC`,
    [userId],
  );
  return { spaces: r.rows };
}

async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "search_notes":
      return toolSearchNotes(userId, args);
    case "get_note":
      return toolGetNote(userId, args);
    case "list_connections":
      return toolListConnections(userId, args);
    case "list_spaces":
      return toolListSpaces(userId);
    default:
      throw new Error(`未知工具：${name}`);
  }
}

function toolResultPayload(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError,
  };
}

async function handleRpc(user: AuthUser, body: JsonRpcReq) {
  const id = body.id;
  const method = typeof body.method === "string" ? body.method : "";
  const params = (body.params && typeof body.params === "object" ? body.params : {}) as Record<
    string,
    unknown
  >;

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "笔记中枢只读 MCP。用 search_notes / get_note 检索与阅读已同步笔记；写作请回思源 / Notion / 飞书 / Obsidian。",
    });
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return rpcResult(id, {});
  }
  if (method === "ping") {
    return rpcResult(id, {});
  }
  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};
    if (!name) return rpcError(id, -32602, "tools/call 需要 name");
    try {
      const data = await callTool(user.id, name, args);
      return rpcResult(id, toolResultPayload(data));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return rpcResult(id, toolResultPayload({ error: msg }, true));
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** Discovery / health for humans and simple clients. */
mcpRoutes.get("/mcp", async (c) => {
  return c.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocol: "mcp-http-jsonrpc",
    protocolVersion: PROTOCOL_VERSION,
    endpoint: "/v1/mcp",
    auth: "Authorization: Bearer hub_<token> （账号页创建）",
    tools: TOOLS.map((t) => t.name),
    docs: "/docs/MCP.md",
  });
});

/** JSON-RPC 2.0 over HTTP (Cursor / Claude remote MCP). Also accepts a bare tool call. */
mcpRoutes.post("/mcp", async (c) => {
  const user = c.get("user");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "invalid_request", "请求体需要 JSON");
  }

  // Convenience: direct tool invoke without JSON-RPC envelope
  if (body && typeof body === "object" && "tool" in (body as object) && !("method" in (body as object))) {
    const b = body as { tool?: unknown; arguments?: unknown };
    const name = typeof b.tool === "string" ? b.tool : "";
    const args =
      b.arguments && typeof b.arguments === "object" ? (b.arguments as Record<string, unknown>) : {};
    if (!name) return jsonError(c, 400, "invalid_request", "tool 必填");
    try {
      const data = await callTool(user.id, name, args);
      return c.json({ ok: true, tool: name, data });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(c, 400, "tool_failed", msg);
    }
  }

  if (Array.isArray(body)) {
    const out = [];
    for (const item of body) {
      out.push(await handleRpc(user, (item ?? {}) as JsonRpcReq));
    }
    return c.json(out);
  }
  return c.json(await handleRpc(user, (body ?? {}) as JsonRpcReq));
});
