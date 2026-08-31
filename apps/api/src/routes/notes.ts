import { Hono } from "hono";
import { toFtsTokens, toTsQueryTokens } from "@note-hub/core";
import { renderPreviewHtml } from "@note-hub/preview";
import { query } from "../db.ts";
import { errors } from "../errors.ts";
import { loadMembership, requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";
import { env } from "../env.ts";
import { getObjectBytes, getObjectText } from "../s3.ts";
import { extractBlocks } from "@note-hub/normalize";

type Vars = { user: AuthUser };
export const noteRoutes = new Hono<{ Variables: Vars }>();
noteRoutes.use("*", requireUser);

async function noteIfMember(userId: string, noteId: string) {
  const r = await query<{
    id: string;
    space_id: string;
    connection_id: string;
    source_id: string;
    path: string;
    title: string;
    markdown: string | null;
    frontmatter: unknown;
    hash: string;
    deleted_at: string | null;
    updated_at: string;
  }>(
    `SELECT id, space_id, connection_id, source_id, path, title, markdown, frontmatter, hash, deleted_at, updated_at
     FROM notes WHERE id = $1`,
    [noteId],
  );
  const note = r.rows[0];
  if (!note || note.deleted_at) return null;
  const mem = await loadMembership(userId, note.space_id);
  if (!mem) return null;
  return note;
}

noteRoutes.get("/spaces/:id/notes", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const path = c.req.query("path");
  const q = c.req.query("q");
  const params: unknown[] = [spaceId];
  let sql = `SELECT id, space_id, connection_id, source_id, path, title, hash, updated_at
             FROM notes WHERE space_id = $1 AND deleted_at IS NULL`;
  if (path) {
    params.push(path + "%");
    sql += ` AND path LIKE $${params.length}`;
  }
  if (q) {
    params.push("%" + q + "%");
    sql += ` AND (title ILIKE $${params.length} OR path ILIKE $${params.length})`;
  }
  sql += " ORDER BY updated_at DESC LIMIT 200";
  const r = await query(sql, params);
  return c.json({ notes: r.rows });
});

noteRoutes.get("/notes/:id", async (c) => {
  const user = c.get("user");
  const note = await noteIfMember(user.id, c.req.param("id"));
  if (!note) return errors.notFound(c);
  return c.json({ note });
});

noteRoutes.get("/notes/:id/blocks", async (c) => {
  const user = c.get("user");
  const note = await noteIfMember(user.id, c.req.param("id"));
  if (!note) return errors.notFound(c);
  const r = await query(
    `SELECT id, source_block_id, type, text, order_key, depth
     FROM blocks WHERE note_id = $1 ORDER BY order_key`,
    [note.id],
  );
  return c.json({ blocks: r.rows });
});

noteRoutes.get("/notes/:id/preview", async (c) => {
  const user = c.get("user");
  const note = await noteIfMember(user.id, c.req.param("id"));
  if (!note) return errors.notFound(c);
  const key = `preview/${note.space_id}/${note.id}/${note.hash}.html`;
  let html = await getObjectText(key);
  if (!html) {
    const canon = await getObjectText(`canonical/${note.space_id}/${note.id}/note.md`);
    const markdown = canon ?? note.markdown ?? "";
    const blocks = extractBlocks(stripFm(markdown));
    html = renderPreviewHtml({
      title: note.title,
      blocks,
      hash: note.hash,
      path: note.path,
    }, { assetBase: `/v1/notes/${note.id}/assets?path=` });
  }
  const wantJson = (c.req.query("format") ?? c.req.header("accept") ?? "").includes("json");
  if (wantJson) return c.json({ html, hash: note.hash });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "x-note-hash": note.hash },
  });
});

noteRoutes.get("/notes/:id/assets", async (c) => {
  const user = c.get("user");
  const note = await noteIfMember(user.id, c.req.param("id"));
  if (!note) return errors.notFound(c);
  const p = (c.req.query("path") ?? "").replace(/^\/+/, "");
  if (!p || p.includes("..")) return errors.notFound(c);
  const base = p.split("/").pop() ?? p;
  const key = `canonical/${note.space_id}/${note.id}/assets/${base}`;
  const bytes = await getObjectBytes(key);
  if (!bytes) return errors.notFound(c);
  const type = p.endsWith(".png") ? "image/png" : "application/octet-stream";
  return new Response(Buffer.from(bytes), { headers: { "content-type": type } });
});

noteRoutes.get("/spaces/:id/search", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ results: [] });
  const like = "%" + q + "%";
  const tokens = toTsQueryTokens(q);
  const results = await query(
    `SELECT n.id, n.title, n.path, n.hash,
            COALESCE(c.snippet, left(n.markdown, 180)) AS snippet,
            c.source_block_id,
            GREATEST(c.rank, similarity_title) AS rank
     FROM notes n
     LEFT JOIN LATERAL (
       SELECT ch.text AS snippet, b.source_block_id,
              ts_rank(ch.fts, to_tsquery('simple', $3)) AS rank
       FROM chunks ch
       LEFT JOIN blocks b ON b.id = ch.block_id
       WHERE ch.note_id = n.id
         AND ($3 <> '' AND ch.fts @@ to_tsquery('simple', $3) OR ch.text ILIKE $2)
       ORDER BY rank DESC NULLS LAST
       LIMIT 1
     ) c ON true
     CROSS JOIN LATERAL (
       SELECT CASE WHEN n.title ILIKE $2 THEN 1.0 ELSE 0 END AS similarity_title
     ) t
     WHERE n.space_id = $1 AND n.deleted_at IS NULL
       AND (n.title ILIKE $2 OR n.markdown ILIKE $2 OR n.path ILIKE $2
            OR ($3 <> '' AND c.rank IS NOT NULL))
     ORDER BY rank DESC NULLS LAST, n.updated_at DESC
     LIMIT 30`,
    [spaceId, like, tokens || ""],
  );
  void toFtsTokens;
  return c.json({
    results: results.rows.map((row) => ({
      note_id: row.id,
      title: row.title,
      path: row.path,
      snippet: row.snippet,
      source_block_id: row.source_block_id,
      preview_url: `/notes/${row.id}${row.source_block_id ? `#b-${row.source_block_id}` : ""}`,
    })),
  });
});

function stripFm(md: string): string {
  if (!md.startsWith("---")) return md;
  const m = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1] : md;
}
