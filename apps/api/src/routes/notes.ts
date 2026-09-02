import { Hono } from "hono";
import {
  buildFileTree,
  guessContentType,
  isAssetNoteId,
  isNoteAclVisibility,
  loadAiSettings,
  noteVisibleTo,
  parseNoteAcl,
  serializeNoteAcl,
  toFtsTokens,
  toTsQueryTokens,
  type NoteAcl,
} from "@note-hub/core";
import { renderPreviewHtml, rewritePreviewAssetUrls } from "@note-hub/preview";
import {
  averageVectors,
  clipQuote,
  embedTexts,
  formatVector,
  parseEmbedding,
  previewUrl,
  SIMILAR_LIMIT,
} from "@note-hub/retrieve";
import { query } from "../db.ts";
import { env } from "../env.ts";
import { errors, jsonError } from "../errors.ts";
import { loadMembership, requireRole, requireUser, roleDenied, type AuthUser } from "../auth.ts";
import { getObjectBytes, getObjectText } from "../s3.ts";
import { extractBlocks } from "@note-hub/normalize";

type Vars = { user: AuthUser };
export const noteRoutes = new Hono<{ Variables: Vars }>();
noteRoutes.use("*", requireUser);

type NoteRow = {
  id: string;
  space_id: string;
  connection_id: string;
  source_id: string;
  path: string;
  title: string;
  markdown: string | null;
  frontmatter: unknown;
  hash: string;
  acl_snapshot: unknown;
  deleted_at: string | null;
  updated_at: string;
};

async function noteIfMember(userId: string, noteId: string) {
  const r = await query<NoteRow>(
    `SELECT id, space_id, connection_id, source_id, path, title, markdown, frontmatter, hash, acl_snapshot, deleted_at, updated_at
     FROM notes WHERE id = $1`,
    [noteId],
  );
  const note = r.rows[0];
  if (!note || note.deleted_at) return null;
  const mem = await loadMembership(userId, note.space_id);
  if (!mem) return null;
  const acl = parseNoteAcl(note.acl_snapshot);
  if (!noteVisibleTo(acl, userId, mem.role)) return null;
  return { note, mem, acl };
}

function publicNote(note: NoteRow, acl: NoteAcl) {
  return {
    id: note.id,
    space_id: note.space_id,
    connection_id: note.connection_id,
    source_id: note.source_id,
    path: note.path,
    title: note.title,
    markdown: note.markdown,
    frontmatter: note.frontmatter,
    hash: note.hash,
    deleted_at: note.deleted_at,
    updated_at: note.updated_at,
    acl: serializeNoteAcl(acl),
  };
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
             FROM notes WHERE space_id = $1 AND deleted_at IS NULL AND source_id NOT LIKE 'asset:%'
               AND path !~* '\\.(png|jpe?g|gif|webp|svg)$'
               AND path NOT ILIKE 'assets/%'
               AND path NOT ILIKE 'data/assets/%'`;
  if (path) {
    const prefix = path.replace(/\/+$/, "");
    params.push(prefix);
    params.push(prefix + "/");
    sql += ` AND (path = $${params.length - 1} OR path LIKE ($${params.length} || '%'))`;
  }
  if (q) {
    params.push("%" + q + "%");
    sql += ` AND (title ILIKE $${params.length} OR path ILIKE $${params.length})`;
  }
  params.push(user.id, gate.mem.role);
  sql += ` AND note_visible_to(acl_snapshot, $${params.length - 1}::uuid, $${params.length}::text)`;
  sql += " ORDER BY updated_at DESC LIMIT 200";
  const r = await query(sql, params);
  return c.json({ notes: r.rows });
});


function boxNamesFromConn(cursor: unknown, config: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const cur = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>) : {};
  const cfg = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const take = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
  };
  take(cur.boxNames);
  take(cur.notebooks);
  take(cfg.notebook_names);
  if (Array.isArray(cfg.notebooks)) {
    for (const nb of cfg.notebooks) {
      if (!nb || typeof nb !== "object") continue;
      const rec = nb as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      if (id && name) out[id] = name;
    }
  }
  return out;
}

noteRoutes.get("/spaces/:id/tree", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  try {
    const notes = await query<{
      id: string;
      path: string;
      title: string;
      source_id: string;
      connection_id: string;
      source: string;
      connection_name: string;
    }>(
      `SELECT n.id, n.path, n.title, n.source_id, n.connection_id, c.source, c.name AS connection_name
       FROM notes n
       INNER JOIN connections c ON c.id = n.connection_id
       WHERE n.space_id = $1 AND n.deleted_at IS NULL
         AND n.source_id NOT LIKE 'asset:%'
         AND n.path !~* '\\.(png|jpe?g|gif|webp|svg)$'
         AND n.path NOT ILIKE 'assets/%'
         AND n.path NOT ILIKE 'data/assets/%'
         AND note_visible_to(n.acl_snapshot, $2::uuid, $3::text)`,
      [spaceId, user.id, gate.mem.role],
    );
    const assets = await query<{
      id: string;
      source_path: string;
      note_id: string;
      note_path: string;
      note_source_id: string;
      source: string;
      connection_id: string;
      connection_name: string;
    }>(
      `SELECT a.id, a.source_path, a.note_id, n.path AS note_path, n.source_id AS note_source_id,
              c.source, n.connection_id, c.name AS connection_name
       FROM assets a
       INNER JOIN notes n ON n.id = a.note_id
       INNER JOIN connections c ON c.id = n.connection_id
       WHERE a.space_id = $1 AND n.deleted_at IS NULL
         AND n.source_id NOT LIKE 'asset:%'
         AND n.path !~* '\\.(png|jpe?g|gif|webp|svg)$'
         AND n.path NOT ILIKE 'assets/%'
         AND n.path NOT ILIKE 'data/assets/%'
         AND a.source_path !~* '\\.(png|jpe?g|gif|webp|svg)$'
         AND note_visible_to(n.acl_snapshot, $2::uuid, $3::text)`,
      [spaceId, user.id, gate.mem.role],
    );
    const conns = await query<{ id: string; cursor: unknown; config: unknown }>(
      `SELECT id, cursor, config FROM connections WHERE space_id = $1`,
      [spaceId],
    );
    const boxNamesByConnection: Record<string, Record<string, string>> = {};
    for (const row of conns.rows) {
      boxNamesByConnection[row.id] = boxNamesFromConn(row.cursor, row.config);
    }
    const items = [
      ...notes.rows
        .filter((n) => !isAssetNoteId(n.source_id))
        .map((n) => ({
          path: n.path,
          kind: "note" as const,
          note_id: n.id,
          title: n.title,
          source: n.source,
          source_id: n.source_id,
          connection_id: n.connection_id,
          connection_name: n.connection_name,
        })),
      ...assets.rows
        .filter((a) => !isAssetNoteId(a.note_source_id))
        .map((a) => ({
          path: a.source_path,
          kind: "asset" as const,
          note_id: a.note_id,
          asset_id: a.id,
          source: a.source,
          note_path: a.note_path,
          note_source_id: a.note_source_id,
          connection_id: a.connection_id,
          connection_name: a.connection_name,
        })),
    ];
    return c.json({
      tree: buildFileTree(items, { groupBySource: true, boxNamesByConnection }),
    });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "tree failed", error: String(e) }));
    return c.json({ tree: [] });
  }
});


noteRoutes.get("/notes/:id", async (c) => {
  const user = c.get("user");
  const loaded = await noteIfMember(user.id, c.req.param("id"));
  if (!loaded) return errors.notFound(c);
  return c.json({
    note: publicNote(loaded.note, loaded.acl),
    can_patch_acl: loaded.mem.role === "owner",
  });
});

noteRoutes.patch("/notes/:id/acl", async (c) => {
  const user = c.get("user");
  const noteId = c.req.param("id");
  const r = await query<NoteRow>(
    `SELECT id, space_id, connection_id, source_id, path, title, markdown, frontmatter, hash, acl_snapshot, deleted_at, updated_at
     FROM notes WHERE id = $1`,
    [noteId],
  );
  const note = r.rows[0];
  if (!note || note.deleted_at) return errors.notFound(c);
  const gate = await requireRole(user.id, note.space_id, "owner");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as {
    visibility?: unknown;
    user_ids?: unknown;
    roles?: unknown;
  };
  const visRaw = typeof body.visibility === "string" ? body.visibility.trim() : "";
  if (!isNoteAclVisibility(visRaw)) {
    return jsonError(c, 400, "invalid_request", "请选择空间里的人、仅所有者，或指定成员");
  }
  const userIds = Array.isArray(body.user_ids)
    ? body.user_ids.filter((id): id is string => typeof id === "string")
    : [];
  const roles = Array.isArray(body.roles)
    ? body.roles.filter((id): id is string => typeof id === "string")
    : [];
  const acl = parseNoteAcl({ visibility: visRaw, user_ids: userIds, roles });
  if (acl.visibility === "members" && acl.user_ids.length) {
    const members = await query<{ user_id: string }>(
      `SELECT user_id FROM space_members WHERE space_id = $1 AND user_id = ANY($2::uuid[])`,
      [note.space_id, acl.user_ids],
    );
    if (members.rows.length !== acl.user_ids.length) {
      return jsonError(c, 400, "invalid_request", "只能指定这个空间里的成员");
    }
    acl.user_ids = members.rows.map((row) => String(row.user_id).toLowerCase());
  }
  const snapshot = serializeNoteAcl(acl);
  await query(`UPDATE notes SET acl_snapshot = $2::jsonb, updated_at = now() WHERE id = $1`, [
    note.id,
    JSON.stringify(snapshot),
  ]);
  return c.json({ note: { ...publicNote(note, acl), acl: snapshot }, can_patch_acl: true });
});

noteRoutes.get("/notes/:id/blocks", async (c) => {
  const user = c.get("user");
  const loaded = await noteIfMember(user.id, c.req.param("id"));
  if (!loaded) return errors.notFound(c);
  const note = loaded.note;
  const r = await query(
    `SELECT id, source_block_id, type, text, order_key, depth
     FROM blocks WHERE note_id = $1 ORDER BY order_key`,
    [note.id],
  );
  return c.json({ blocks: r.rows });
});

noteRoutes.get("/notes/:id/preview", async (c) => {
  const user = c.get("user");
  const loaded = await noteIfMember(user.id, c.req.param("id"));
  if (!loaded) return errors.notFound(c);
  const note = loaded.note;
  const key = `preview/${note.space_id}/${note.id}/${note.hash}.html`;
  const assetBase = `/v1/notes/${note.id}/assets?path=`;
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
    }, { assetBase });
  }
  html = rewritePreviewAssetUrls(html, assetBase);
  const wantJson = (c.req.query("format") ?? c.req.header("accept") ?? "").includes("json");
  if (wantJson) return c.json({ html, hash: note.hash });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "x-note-hash": note.hash },
  });
});

noteRoutes.get("/notes/:id/assets", async (c) => {
  const user = c.get("user");
  const loaded = await noteIfMember(user.id, c.req.param("id"));
  if (!loaded) return errors.notFound(c);
  const note = loaded.note;
  const p = (c.req.query("path") ?? "").replace(/^\/+/, "");
  if (!p || p.includes("..")) return errors.notFound(c);
  const base = p.split("/").pop() ?? p;
  const row = await query<{ s3_key: string; content_type: string | null }>(
    `SELECT s3_key, content_type FROM assets
     WHERE note_id = $1 AND (source_path = $2 OR source_path LIKE '%' || $3)
     ORDER BY (source_path = $2) DESC LIMIT 1`,
    [note.id, p, base],
  );
  const key = row.rows[0]?.s3_key || `canonical/${note.space_id}/${note.id}/assets/${base}`;
  const bytes = await getObjectBytes(key);
  if (!bytes) return errors.notFound(c);
  const type = row.rows[0]?.content_type || guessContentType(p);
  const disposition = type.startsWith("image/") || type === "application/pdf" ? "inline" : "attachment";
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": type,
      "content-disposition": `${disposition}; filename="${base.replace(/"/g, "")}"`,
    },
  });
});

type SimilarRow = {
  note_id: string;
  title: string;
  path: string;
  snippet: string | null;
  score: number | string | null;
};

async function similarNotesInSpace(
  spaceId: string,
  embedding: number[],
  excludeIds: string[],
  userId: string,
  role: string,
  limit = SIMILAR_LIMIT,
): Promise<{
  note_id: string;
  title: string;
  path: string;
  snippet: string;
  preview_url: string;
  score: number;
}[]> {
  if (!embedding.length) return [];
  try {
    const r = await query<SimilarRow>(
      `SELECT note_id, title, path, snippet, score FROM (
         SELECT DISTINCT ON (n.id)
           n.id AS note_id,
           n.title,
           n.path,
           left(ch.text, 180) AS snippet,
           (1 - (ch.embedding <=> $2::vector))::float8 AS score
         FROM chunks ch
         INNER JOIN notes n ON n.id = ch.note_id AND n.deleted_at IS NULL
         WHERE n.space_id = $1 AND ch.space_id = $1
           AND ch.embedding IS NOT NULL
           AND NOT (n.id = ANY($3::uuid[]))
           AND note_visible_to(n.acl_snapshot, $5::uuid, $6::text)
         ORDER BY n.id, ch.embedding <=> $2::vector
       ) s
       ORDER BY score DESC NULLS LAST
       LIMIT $4`,
      [spaceId, formatVector(embedding), excludeIds, limit, userId, role],
    );
    return r.rows.map((row) => ({
      note_id: row.note_id,
      title: row.title,
      path: row.path,
      snippet: clipQuote(row.snippet ?? "", 180),
      preview_url: previewUrl(row.note_id),
      score: Number(row.score ?? 0),
    }));
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "similar search failed", error: String(e) }));
    return [];
  }
}

async function noteAverageEmbedding(noteId: string): Promise<number[]> {
  const r = await query<{ embedding: unknown }>(
    `SELECT embedding FROM chunks WHERE note_id = $1 AND embedding IS NOT NULL ORDER BY created_at`,
    [noteId],
  );
  const vecs = r.rows.map((row) => parseEmbedding(row.embedding)).filter((v): v is number[] => Boolean(v?.length));
  return averageVectors(vecs);
}

noteRoutes.get("/spaces/:id/search", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("id");
  const gate = await requireRole(user.id, spaceId, "viewer");
  const denied = roleDenied(c, gate);
  if (denied) return denied;
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ query: q, results: [], similar: [] });
  const like = "%" + q + "%";
  const tokens = toTsQueryTokens(q);
  const results = await query<{
    id: string;
    title: string;
    path: string;
    snippet: string | null;
    source_block_id: string | null;
    match: "keyword" | "path";
  }>(
    `SELECT n.id, n.title, n.path,
            COALESCE(c.snippet, left(n.markdown, 180)) AS snippet,
            c.source_block_id,
            CASE WHEN n.path ILIKE $2 THEN 'path' ELSE 'keyword' END AS match
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
       AND note_visible_to(n.acl_snapshot, $4::uuid, $5::text)
       AND (n.title ILIKE $2 OR n.markdown ILIKE $2 OR n.path ILIKE $2
            OR ($3 <> '' AND c.rank IS NOT NULL))
     ORDER BY GREATEST(c.rank, t.similarity_title) DESC NULLS LAST, n.updated_at DESC
     LIMIT 30`,
    [spaceId, like, tokens || "", user.id, gate.mem.role],
  );
  const sourceHits = results.rows.map((row) => ({
    note_id: row.id,
    title: row.title,
    path: row.path,
    snippet: clipQuote(row.snippet ?? "", 180),
    source_block_id: row.source_block_id,
    preview_url: previewUrl(row.id, row.source_block_id),
    match: row.match,
  }));
  let similar: Awaited<ReturnType<typeof similarNotesInSpace>> = [];
  try {
    const ai = await loadAiSettings(query, env.hubSecret);
    const [emb] = await embedTexts([q], {
      baseUrl: ai.base_url,
      apiKey: ai.api_key,
      model: ai.embedding_model,
    });
    if (emb?.length) {
      similar = await similarNotesInSpace(
        spaceId,
        emb,
        sourceHits.map((h) => h.note_id),
        user.id,
        gate.mem.role,
      );
    }
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "embed query failed", error: String(e) }));
  }
  void toFtsTokens;
  return c.json({ query: q, results: sourceHits, similar });
});

noteRoutes.get("/notes/:id/similar", async (c) => {
  const user = c.get("user");
  const loaded = await noteIfMember(user.id, c.req.param("id"));
  if (!loaded) return errors.notFound(c);
  const note = loaded.note;
  const emb = await noteAverageEmbedding(note.id);
  if (!emb.length) return c.json({ similar: [] });
  const similar = await similarNotesInSpace(note.space_id, emb, [note.id], user.id, loaded.mem.role);
  return c.json({ similar });
});

function stripFm(md: string): string {
  if (!md.startsWith("---")) return md;
  const m = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1] : md;
}
