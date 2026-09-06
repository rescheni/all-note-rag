import { Hono } from "hono";
import {
  assembleSourceTree,
  buildSourceGroups,
  clipTreeToDepth,
  findTreeNode,
  guessContentType,
  isAssetNoteId,
  isMediaPath,
  isNoteAclVisibility,
  loadAiSettings,
  noteVisibleTo,
  parseNoteAcl,
  serializeNoteAcl,
  siyuanIconToEmoji,
  toTsQueryTokens,
  type NoteAcl,
  type TreeInput,
} from "@note-hub/core";
import { isCurrentPreviewHtml, renderPreviewHtml, rewritePreviewAssetUrls, type PreviewBacklink, type PreviewNoteLink } from "@note-hub/preview";
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
import { getObjectBytes, getObjectText, putObject } from "../s3.ts";
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
  const pathRaw = c.req.query("path") ?? "";
  const path = pathRaw.startsWith("src:") || pathRaw.startsWith("conn:") ? "" : pathRaw;
  const connectionId = c.req.query("connection_id");
  const source = c.req.query("source");
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
  if (connectionId) {
    params.push(connectionId);
    sql += ` AND connection_id = $${params.length}`;
  } else if (source) {
    params.push(source);
    sql += ` AND connection_id IN (SELECT id FROM connections WHERE space_id = $1 AND source = $${params.length})`;
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
  const parent = (c.req.query("parent") ?? "").replace(/\/+$/, "");
  const connectionFilter = c.req.query("connection_id") ?? "";
  // Lazy expand: when $5 (parent) is set, only that folder's descendants are loaded.
  // Empty $5 keeps the whole vault (root / bookshelf open).
  const parentScope = `($5::text = '' OR n.path = $5 OR n.path = ($5 || '.sy') OR n.path LIKE ($5 || '/%') OR n.path LIKE ($5 || '.sy/%'))`;
  const assetScope = `($5::text = '' OR a.source_path = $5 OR a.source_path LIKE ($5 || '/%') OR n.path = $5 OR n.path = ($5 || '.sy') OR n.path LIKE ($5 || '/%') OR n.path LIKE ($5 || '.sy/%'))`;
  try {
    const notes = await query<{
      id: string;
      path: string;
      title: string;
      source_id: string;
      connection_id: string;
      source: string;
      connection_name: string;
      icon: string | null;
    }>(
      `SELECT n.id, n.path, n.title, n.source_id, n.connection_id, c.source, c.name AS connection_name,
              NULLIF(TRIM(n.frontmatter->>'icon'), '') AS icon
       FROM notes n
       INNER JOIN connections c ON c.id = n.connection_id
       WHERE n.space_id = $1 AND n.deleted_at IS NULL
         AND n.source_id NOT LIKE 'asset:%'
         AND n.path !~* '\\.(png|jpe?g|gif|webp|svg)$'
         AND n.path NOT ILIKE 'assets/%'
         AND n.path NOT ILIKE 'data/assets/%'
         AND ($4::text = '' OR n.connection_id = $4::uuid)
         AND ${parentScope}
         AND note_visible_to(n.acl_snapshot, $2::uuid, $3::text)`,
      [spaceId, user.id, gate.mem.role, connectionFilter, parent],
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
         AND ($4::text = '' OR n.connection_id = $4::uuid)
         AND ${assetScope}
         AND note_visible_to(n.acl_snapshot, $2::uuid, $3::text)`,
      [spaceId, user.id, gate.mem.role, connectionFilter, parent],
    );
    const conns = await query<{ id: string; source: string; name: string; cursor: unknown; config: unknown }>(
      `SELECT id, source, name, cursor, config FROM connections WHERE space_id = $1`,
      [spaceId],
    );
    const boxNamesByConnection: Record<string, Record<string, string>> = {};
    const connections = conns.rows.map((row) => {
      boxNamesByConnection[row.id] = boxNamesFromConn(row.cursor, row.config);
      return { id: row.id, source: row.source, name: row.name };
    });
    const items: TreeInput[] = [
      ...notes.rows
        .filter((n) => !isAssetNoteId(n.source_id))
        .map((n) => {
          const emoji = n.icon ? siyuanIconToEmoji(n.icon) : "";
          return {
            path: n.path,
            kind: "note" as const,
            note_id: n.id,
            title: n.title,
            source: n.source,
            source_id: n.source_id,
            connection_id: n.connection_id,
            connection_name: n.connection_name,
            icon: emoji || null,
          };
        }),
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
    // Root: clipDepth 1 — never materialize the full vault tree just to strip it.
    // Parent expand: SQL already scopes rows; build that subtree then clip children to 1.
    const groups = buildSourceGroups(items, {
      boxNamesByConnection,
      connections: connectionFilter ? connections.filter((x) => x.id === connectionFilter) : connections,
      clipDepth: parent ? undefined : 1,
    });
    if (parent) {
      for (const g of groups) {
        if (connectionFilter && g.connection_id !== connectionFilter) continue;
        const node = findTreeNode(g.tree, parent);
        if (node) {
          return c.json({ tree: clipTreeToDepth(node.children ?? [], 1), groups: [] });
        }
      }
      return c.json({ tree: [], groups: [] });
    }
    const payload = groups.map((g) => ({
      source: g.source,
      connection_id: g.connection_id,
      name: g.name,
      // Already built shallow; clip again for a stable wire shape (no nested children).
      tree: clipTreeToDepth(g.tree, 1),
    }));
    return c.json({ groups: payload, tree: assembleSourceTree(payload) });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "tree failed", error: String(e) }));
    return c.json({ tree: [], groups: [] });
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


type NoteLinkDbRow = {
  raw_link: string;
  label: string;
  target_note_id: string | null;
  heading: string | null;
  link_kind: string;
  source_offset: number;
  raw_target: string;
  native_target_id: string | null;
};

const SIYUAN_ID_RE = /^\d{14}-[a-z0-9]+$/i;

function looksLikePlaceholderLinkLabel(label: string): boolean {
  const t = (label ?? "").trim().replace(/\.sy$/i, "");
  return !t || t === "引用块" || SIYUAN_ID_RE.test(t);
}

function stripLinkMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_`#]+/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function truncateLabel(text: string, max = 40): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return "";
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** Prefer real block text / target title over stored 「引用块」 or bare SiYuan ids. */
function resolvePreviewLinkLabel(row: {
  label: string;
  target_title: string | null;
  block_text: string | null;
}): string {
  const stored = (row.label ?? "").trim();
  if (!looksLikePlaceholderLinkLabel(stored)) return stored;
  const fromBlock = truncateLabel(stripLinkMarkup(row.block_text ?? ""));
  if (fromBlock) return fromBlock;
  const fromTitle = truncateLabel(row.target_title ?? "");
  if (fromTitle) return fromTitle;
  return stored || "引用块";
}

async function loadOutgoingPreviewLinks(noteId: string): Promise<PreviewNoteLink[]> {
  const r = await query<
    NoteLinkDbRow & { resolved_target_id: string | null; target_source_id: string | null; target_title: string | null; block_text: string | null }
  >(
    `SELECT l.raw_link, l.label, l.target_note_id, l.heading, l.link_kind, l.source_offset, l.raw_target, l.native_target_id,
            t.id AS resolved_target_id, t.source_id AS target_source_id, t.title AS target_title,
            b.text AS block_text
     FROM note_links l
     LEFT JOIN LATERAL (
       SELECT id, source_id, title
       FROM notes
       WHERE (
         id = l.target_note_id
         OR (NULLIF(l.native_target_id, '') IS NOT NULL AND source_id = l.native_target_id)
         OR (NULLIF(l.raw_target, '') IS NOT NULL AND source_id = l.raw_target)
       )
       ORDER BY (deleted_at IS NULL) DESC, (id = l.target_note_id) DESC NULLS LAST
       LIMIT 1
     ) t ON TRUE
     LEFT JOIN LATERAL (
       SELECT text FROM blocks
       WHERE source_block_id = l.native_target_id
         AND (t.id IS NULL OR note_id = t.id)
       LIMIT 1
     ) b ON TRUE
     WHERE l.source_note_id = $1
     ORDER BY l.source_offset`,
    [noteId],
  );
  return r.rows.map((row) => {
    // Wiki [[Note#heading]] keeps heading; block_ref uses native_target_id so href is /notes/<id>#b-<block>.
    // Doc-level refs (native id == note source_id) omit the fragment — no matching section id.
    const heading = (row.heading ?? "").trim();
    const native = (row.native_target_id ?? "").trim();
    const docId = (row.target_source_id ?? "").trim();
    const fragment = heading || (native && native !== docId ? native : "") || undefined;
    return {
      raw: row.raw_link,
      label: resolvePreviewLinkLabel(row),
      targetNoteId: row.target_note_id || row.resolved_target_id,
      heading: fragment,
    };
  });
}

/** Overlay DB source_block_ids onto extractBlocks so preview sections match #b-<native_id>. */
async function loadPreviewBlocks(noteId: string, markdownBody: string) {
  const extracted = extractBlocks(markdownBody);
  const r = await query<{
    source_block_id: string;
    type: string;
    text: string | null;
    order_key: string;
    depth: number;
  }>(
    `SELECT source_block_id, type, text, order_key, depth
     FROM blocks
     WHERE note_id = $1 AND source_block_id NOT LIKE 'asset%'
     ORDER BY order_key`,
    [noteId],
  );
  if (!r.rows.length) return extracted;

  const pool = r.rows.map((row, i) => ({
    row,
    i,
    norm: (row.text ?? "").replace(/\s+/g, " ").trim(),
  }));
  const used = new Set<number>();
  let mapped = 0;
  const out = extracted.map((ex) => {
    const exNorm = (ex.text || ex.markdown || "").replace(/\s+/g, " ").trim();
    if (!exNorm) return ex;
    let bestI = -1;
    let bestScore = 0;
    for (const p of pool) {
      if (used.has(p.i) || !p.norm) continue;
      if (p.row.type !== ex.type) continue;
      let score = 0;
      if (p.norm === exNorm) score = 1;
      else if (exNorm.includes(p.norm) || p.norm.includes(exNorm)) {
        score = Math.min(p.norm.length, exNorm.length) / Math.max(p.norm.length, exNorm.length);
      }
      if (score > bestScore) {
        bestScore = score;
        bestI = p.i;
      }
    }
    if (bestI >= 0 && bestScore >= 0.45) {
      used.add(bestI);
      mapped += 1;
      return { ...ex, source_block_id: pool[bestI].row.source_block_id };
    }
    return ex;
  });

  if (mapped >= Math.min(3, Math.ceil(r.rows.length * 0.15))) return out;

  // Low match rate: render from DB blocks so #b-<native_id> anchors still exist.
  return r.rows.map((row) => {
    const text = row.text ?? "";
    let markdown = text;
    if (row.type === "heading") {
      const d = Math.min(6, Math.max(1, row.depth || 1));
      markdown = `${"#".repeat(d)} ${text}`;
    } else if (row.type === "code") {
      markdown = text.startsWith("```") ? text : "```\n" + text + "\n```";
    } else if (row.type === "quote") {
      markdown = text
        .split("\n")
        .map((l) => (l.startsWith(">") ? l : `> ${l}`))
        .join("\n");
    } else if (row.type === "list") {
      const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      markdown = lines.map((l) => (/^[-*+\d.]/.test(l) ? l : `- ${l}`)).join("\n");
    }
    return {
      source_block_id: row.source_block_id,
      type: row.type as (typeof extracted)[number]["type"],
      text,
      markdown,
      order_key: row.order_key,
      depth: row.depth,
    };
  });
}

async function loadVisibleBacklinks(
  noteId: string,
  userId: string,
  role: string,
): Promise<PreviewBacklink[]> {
  const r = await query<{ note_id: string; title: string; path: string }>(
    `SELECT DISTINCT ON (n.id) n.id AS note_id, n.title, n.path
     FROM note_links l
     INNER JOIN notes n ON n.id = l.source_note_id AND n.deleted_at IS NULL
     WHERE l.target_note_id = $1
       AND note_visible_to(n.acl_snapshot, $2::uuid, $3::text)
     ORDER BY n.id, n.title`,
    [noteId, userId, role],
  );
  return r.rows.map((row) => ({ noteId: row.note_id, title: row.title, path: row.path }));
}

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

noteRoutes.get("/notes/:id/links", async (c) => {
  const user = c.get("user");
  const loaded = await noteIfMember(user.id, c.req.param("id"));
  if (!loaded) return errors.notFound(c);
  const note = loaded.note;
  const outgoingRows = await query<{
    id: string;
    raw_link: string;
    raw_target: string;
    label: string;
    link_kind: string;
    source_offset: number;
    heading: string | null;
    native_target_id: string | null;
    target_note_id: string | null;
    target_title: string | null;
    target_path: string | null;
    block_text: string | null;
  }>(
    `SELECT l.id, l.raw_link, l.raw_target, l.label, l.link_kind, l.source_offset, l.heading, l.native_target_id,
            COALESCE(l.target_note_id, t.id) AS target_note_id, t.title AS target_title, t.path AS target_path, b.text AS block_text
     FROM note_links l
     LEFT JOIN LATERAL (
       SELECT id, title, path
       FROM notes
       WHERE (
         id = l.target_note_id
         OR (NULLIF(l.native_target_id, '') IS NOT NULL AND source_id = l.native_target_id)
         OR (NULLIF(l.raw_target, '') IS NOT NULL AND source_id = l.raw_target)
       )
       ORDER BY (deleted_at IS NULL) DESC, (id = l.target_note_id) DESC NULLS LAST
       LIMIT 1
     ) t ON TRUE
     LEFT JOIN LATERAL (
       SELECT text FROM blocks
       WHERE source_block_id = l.native_target_id
         AND (t.id IS NULL OR note_id = t.id)
       LIMIT 1
     ) b ON TRUE
     WHERE l.source_note_id = $1
     ORDER BY l.source_offset`,
    [note.id],
  );
  const backlinks = await loadVisibleBacklinks(note.id, user.id, loaded.mem.role);
  return c.json({
    outgoing: outgoingRows.rows.map((row) => ({
      id: row.id,
      raw: row.raw_link,
      raw_target: row.raw_target,
      label: resolvePreviewLinkLabel(row),
      kind: row.link_kind,
      offset: row.source_offset,
      heading: row.heading,
      native_target_id: row.native_target_id,
      target_note_id: row.target_note_id,
      target_title: row.target_title,
      target_path: row.target_path,
      resolved: Boolean(row.target_note_id),
    })),
    backlinks: backlinks.map((b) => ({
      note_id: b.noteId,
      title: b.title,
      path: b.path,
    })),
  });
});

noteRoutes.get("/notes/:id/preview", async (c) => {
  const user = c.get("user");
  const loaded = await noteIfMember(user.id, c.req.param("id"));
  if (!loaded) return errors.notFound(c);
  const note = loaded.note;
  const key = `preview/${note.space_id}/${note.id}/${note.hash}.html`;
  const assetBase = `/v1/notes/${note.id}/assets?path=`;
  // Always refresh with live note_links + ACL-filtered backlinks (S3 cache alone goes stale on reverse edges).
  const canon = await getObjectText(`canonical/${note.space_id}/${note.id}/note.md`);
  const markdown = canon ?? note.markdown ?? "";
  const blocks = await loadPreviewBlocks(note.id, stripFm(markdown));
  const links = await loadOutgoingPreviewLinks(note.id);
  const backlinks = await loadVisibleBacklinks(note.id, user.id, loaded.mem.role);
  let html = renderPreviewHtml(
    {
      title: note.title,
      blocks,
      hash: note.hash,
      path: note.path,
    },
    { assetBase, links, backlinks },
  );
  try {
    await putObject(key, html, "text/html; charset=utf-8");
  } catch {
    /* still serve the fresh render */
  }
  html = rewritePreviewAssetUrls(html, assetBase);
  void isCurrentPreviewHtml;
  const wantJson = (c.req.query("format") ?? c.req.header("accept") ?? "").includes("json");
  if (wantJson) return c.json({ html, hash: note.hash, links, backlinks });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "x-note-hash": note.hash },
  });
});


function contentDispositionHeader(kind: "inline" | "attachment", filename: string): string {
  const safe = filename.replace(/"/g, "").trim() || "file";
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_") || "file";
  const star = encodeURIComponent(safe).replace(/['()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

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
  const stored = row.rows[0]?.content_type || "";
  const guessed = guessContentType(p);
  // SiYuan often stores playable media as application/octet-stream — remint by extension.
  let type = stored;
  if (!type || type === "application/octet-stream") {
    if (guessed !== "application/octet-stream") type = guessed;
    else type = stored || guessed;
  }
  const inline =
    type.startsWith("image/") ||
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    type === "application/pdf" ||
    isMediaPath(p) ||
    isMediaPath(base);
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": type || "application/octet-stream",
      "content-disposition": contentDispositionHeader(inline ? "inline" : "attachment", base),
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

const SEARCH_SIMILAR_BUDGET_MS = 400;

function withBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
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
  const fts = tokens || "";
  const similarStarted = Date.now();
  const similarWork = (async () => {
    const ai = await loadAiSettings(query, env.hubSecret);
    const [emb] = await embedTexts([q], {
      baseUrl: ai.base_url,
      apiKey: ai.api_key,
      model: ai.embedding_model,
    });
    if (!emb?.length) return [] as Awaited<ReturnType<typeof similarNotesInSpace>>;
    // exclude filled after keyword query; placeholder until then
    return { emb } as { emb: number[] };
  })();
  // Fast path: title/path ILIKE + capped GIN FTS on chunks.
  // Avoid notes.markdown ILIKE and chunks.text ILIKE (full-corpus sequential scans).
  const results = await query<{
    id: string;
    title: string;
    path: string;
    connection_id: string;
    snippet: string | null;
    source_block_id: string | null;
    match: "keyword" | "path";
  }>(
    `WITH title_path AS (
       SELECT n.id,
              (CASE WHEN n.title ILIKE $2 THEN 2.0 ELSE 0 END
               + CASE WHEN n.path ILIKE $2 THEN 1.5 ELSE 0 END)::float8 AS base_rank,
              CASE WHEN n.path ILIKE $2 THEN 'path'::text ELSE 'keyword'::text END AS match
       FROM notes n
       WHERE n.space_id = $1 AND n.deleted_at IS NULL
         AND note_visible_to(n.acl_snapshot, $4::uuid, $5::text)
         AND (n.title ILIKE $2 OR n.path ILIKE $2)
     ),
     fts_notes AS (
       SELECT ch.note_id AS id,
              max(CASE WHEN $3 <> '' THEN ts_rank(ch.fts, to_tsquery('simple', $3)) ELSE 0 END)::float8 AS base_rank,
              'keyword'::text AS match
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
       SELECT id,
              max(base_rank) AS base_rank,
              CASE WHEN bool_or(match = 'path') THEN 'path'::text ELSE 'keyword'::text END AS match
       FROM (
         SELECT * FROM title_path
         UNION ALL
         SELECT * FROM fts_notes
       ) u
       GROUP BY id
     )
     SELECT n.id, n.title, n.path, n.connection_id,
            COALESCE(c.snippet, left(COALESCE(n.markdown, ''), 180)) AS snippet,
            c.source_block_id,
            m.match
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
     LIMIT 30`,
    [spaceId, like, fts, user.id, gate.mem.role],
  );
  const sourceHits = results.rows.map((row) => ({
    note_id: row.id,
    title: row.title,
    path: row.path,
    connection_id: row.connection_id,
    snippet: clipQuote(row.snippet ?? "", 180),
    source_block_id: row.source_block_id,
    preview_url: previewUrl(row.id, row.source_block_id),
    match: row.match,
  }));
  let similar: Awaited<ReturnType<typeof similarNotesInSpace>> = [];
  try {
    const remaining = Math.max(50, SEARCH_SIMILAR_BUDGET_MS - (Date.now() - similarStarted));
    const embPhase = await withBudget(similarWork, remaining, null);
    void similarWork.catch((e) => {
      console.error(JSON.stringify({ level: "error", message: "embed query failed", error: String(e) }));
    });
    if (embPhase && "emb" in embPhase && embPhase.emb?.length) {
      const left = Math.max(50, SEARCH_SIMILAR_BUDGET_MS - (Date.now() - similarStarted));
      similar = await withBudget(
        similarNotesInSpace(
          spaceId,
          embPhase.emb,
          sourceHits.map((h) => h.note_id),
          user.id,
          gate.mem.role,
        ),
        left,
        [],
      );
    }
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "embed query failed", error: String(e) }));
  }
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
