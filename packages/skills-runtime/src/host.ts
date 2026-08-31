import { growthAccessError } from "./access.ts";
import { growthEventDedupeKey } from "./extract.ts";
import type {
  GrowthKind,
  HostApi,
  HostArtifact,
  HostGrowthEvent,
  HostLink,
  HostNote,
  SqlQuery,
  WriteArtifact,
  WriteGrowthEvent,
} from "./types.ts";

export type MemoryHostState = {
  spaceId: string;
  userId: string;
  spaceKind: "personal" | "team";
  notes: HostNote[];
  events: HostGrowthEvent[];
  reports: Array<{ id: string; range_from: string; range_to: string; markdown: string }>;
  artifacts: HostArtifact[];
  links: HostLink[];
};

let seq = 1;
function nid(prefix: string): string {
  seq += 1;
  return prefix + String(seq);
}

export function createMemoryHost(init: Partial<MemoryHostState> & { spaceId: string; userId: string }): HostApi & MemoryHostState {
  const state: MemoryHostState = {
    spaceId: init.spaceId,
    userId: init.userId,
    spaceKind: init.spaceKind ?? "personal",
    notes: init.notes ? [...init.notes] : [],
    events: init.events ? [...init.events] : [],
    reports: init.reports ? [...init.reports] : [],
    artifacts: init.artifacts ? [...init.artifacts] : [],
    links: init.links ? [...init.links] : [],
  };
  const host: HostApi & MemoryHostState = {
    ...state,
    async queryNotes(opts) {
      let rows = state.notes;
      if (opts?.ids?.length) {
        const allow = new Set(opts.ids);
        rows = rows.filter((n) => allow.has(n.id));
      }
      if (opts?.path) rows = rows.filter((n) => n.path.startsWith(opts.path!));
      return rows;
    },
    async queryGrowth(opts) {
      if (growthAccessError(state.spaceKind)) return [];
      let rows = state.events;
      if (opts?.kinds?.length) {
        const allow = new Set(opts.kinds);
        rows = rows.filter((e) => allow.has(e.kind));
      }
      if (opts?.from) rows = rows.filter((e) => e.happened_at.slice(0, 10) >= opts.from!);
      if (opts?.to) rows = rows.filter((e) => e.happened_at.slice(0, 10) <= opts.to!);
      return rows;
    },
    async writeGrowthEvent(event) {
      const err = growthAccessError(state.spaceKind);
      if (err) throw new Error(err.code);
      const happened = event.happened_at;
      const key = growthEventDedupeKey(event.note_id ?? null, event.kind, happened);
      const dup = state.events.find(
        (e) => growthEventDedupeKey(e.note_id, e.kind, e.happened_at) === key,
      );
      if (dup?.id) return { id: dup.id, created: false };
      const row: HostGrowthEvent = {
        id: nid("ge-"),
        space_id: state.spaceId,
        note_id: event.note_id ?? null,
        kind: event.kind,
        happened_at: happened,
        payload: event.payload ?? {},
      };
      state.events.push(row);
      return { id: row.id!, created: true };
    },
    async writeReport(report) {
      const row = { id: nid("gr-"), ...report };
      state.reports.push(row);
      return { id: row.id };
    },
    async writeArtifact(artifact: WriteArtifact) {
      const noteId = artifact.note_id ?? null;
      const existing = state.artifacts.find(
        (a) => a.skill_id === artifact.skill_id && a.note_id === noteId && a.kind === artifact.kind,
      );
      if (existing?.id) {
        existing.payload = artifact.payload ?? {};
        return { id: existing.id, created: false };
      }
      const row: HostArtifact = {
        id: nid("sa-"),
        space_id: state.spaceId,
        skill_id: artifact.skill_id,
        note_id: noteId,
        kind: artifact.kind,
        payload: artifact.payload ?? {},
        created_at: new Date().toISOString(),
      };
      state.artifacts.push(row);
      return { id: row.id!, created: true };
    },
    async queryArtifacts(opts) {
      let rows = state.artifacts;
      if (opts?.skill_id) rows = rows.filter((a) => a.skill_id === opts.skill_id);
      if (opts?.kind) rows = rows.filter((a) => a.kind === opts.kind);
      if (opts?.note_id) rows = rows.filter((a) => a.note_id === opts.note_id);
      return rows;
    },
    async queryLinks(opts) {
      let rows = state.links;
      if (opts?.note_ids?.length) {
        const allow = new Set(opts.note_ids);
        rows = rows.filter((l) => allow.has(l.from_note_id) || (l.to_note_id != null && allow.has(l.to_note_id)));
      }
      return rows;
    },
  };
  return host;
}

function asNote(row: Record<string, unknown>): HostNote {
  const fm = row.frontmatter;
  return {
    id: String(row.id),
    path: String(row.path),
    title: String(row.title),
    markdown: row.markdown == null ? null : String(row.markdown),
    frontmatter: fm && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {},
    hash: row.hash == null ? null : String(row.hash),
    updated_at: String(row.updated_at),
  };
}

export function createPgHostApi(opts: {
  query: SqlQuery;
  spaceId: string;
  userId: string;
}): HostApi {
  const { query, spaceId, userId } = opts;
  return {
    async queryNotes(args) {
      const params: unknown[] = [spaceId];
      let sql = `SELECT id, path, title, markdown, frontmatter, hash, updated_at
                 FROM notes WHERE space_id = $1 AND deleted_at IS NULL`;
      if (args?.ids?.length) {
        params.push(args.ids);
        sql += ` AND id = ANY($${params.length}::uuid[])`;
      }
      if (args?.path) {
        params.push(args.path + "%");
        sql += ` AND path LIKE $${params.length}`;
      }
      sql += " ORDER BY updated_at DESC LIMIT 500";
      const r = await query(sql, params);
      return r.rows.map(asNote);
    },
    async queryGrowth(args) {
      const params: unknown[] = [spaceId];
      let sql = `SELECT g.id, g.space_id, g.note_id, g.kind, g.happened_at, g.payload
                 FROM growth_events g
                 JOIN spaces s ON s.id = g.space_id AND s.kind = 'personal'
                 WHERE g.space_id = $1`;
      if (args?.from) {
        params.push(args.from);
        sql += ` AND g.happened_at >= $${params.length}::date`;
      }
      if (args?.to) {
        params.push(args.to);
        sql += ` AND g.happened_at < ($${params.length}::date + interval '1 day')`;
      }
      if (args?.kinds?.length) {
        params.push(args.kinds);
        sql += ` AND g.kind = ANY($${params.length}::text[])`;
      }
      sql += " ORDER BY g.happened_at ASC";
      const r = await query(sql, params);
      return r.rows.map((row) => ({
        id: String(row.id),
        space_id: String(row.space_id),
        note_id: row.note_id == null ? null : String(row.note_id),
        kind: row.kind as GrowthKind,
        happened_at: typeof row.happened_at === "string" ? row.happened_at : new Date(String(row.happened_at)).toISOString(),
        payload: (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>,
      }));
    },
    async writeGrowthEvent(event: WriteGrowthEvent) {
      const kindRow = await query("SELECT kind FROM spaces WHERE id = $1", [spaceId]);
      const err = growthAccessError(kindRow.rows[0]?.kind);
      if (err) throw new Error(err.code);
      if (event.note_id) {
        const day = event.happened_at.slice(0, 10);
        const existing = await query(
          `SELECT id FROM growth_events
           WHERE space_id = $1 AND note_id = $2 AND kind = $3
             AND ((happened_at AT TIME ZONE 'utc')::date) = $4::date
           LIMIT 1`,
          [spaceId, event.note_id, event.kind, day],
        );
        if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
      }
      const ins = await query(
        `INSERT INTO growth_events (space_id, user_id, note_id, kind, happened_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
        [spaceId, userId, event.note_id ?? null, event.kind, event.happened_at, JSON.stringify(event.payload ?? {})],
      );
      return { id: ins.rows[0].id, created: true };
    },
    async writeReport(report) {
      const ins = await query(
        `INSERT INTO growth_reports (space_id, range_from, range_to, markdown)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [spaceId, report.range_from, report.range_to, report.markdown],
      );
      return { id: ins.rows[0].id };
    },
    async writeArtifact(artifact: WriteArtifact) {
      const noteId = artifact.note_id ?? null;
      const payload = JSON.stringify(artifact.payload ?? {});
      const existing = await query(
        `SELECT id FROM skill_artifacts
         WHERE space_id = $1 AND skill_id = $2 AND kind = $3 AND note_id IS NOT DISTINCT FROM $4
         LIMIT 1`,
        [spaceId, artifact.skill_id, artifact.kind, noteId],
      );
      if (existing.rows[0]) {
        await query(`UPDATE skill_artifacts SET payload = $2::jsonb WHERE id = $1`, [
          existing.rows[0].id,
          payload,
        ]);
        return { id: String(existing.rows[0].id), created: false };
      }
      const ins = await query(
        `INSERT INTO skill_artifacts (space_id, skill_id, note_id, kind, payload)
         VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
        [spaceId, artifact.skill_id, noteId, artifact.kind, payload],
      );
      return { id: String(ins.rows[0].id), created: true };
    },
    async queryArtifacts(opts) {
      const params: unknown[] = [spaceId];
      let sql = `SELECT id, space_id, skill_id, note_id, kind, payload, created_at
                 FROM skill_artifacts WHERE space_id = $1`;
      if (opts?.skill_id) {
        params.push(opts.skill_id);
        sql += ` AND skill_id = $${params.length}`;
      }
      if (opts?.kind) {
        params.push(opts.kind);
        sql += ` AND kind = $${params.length}`;
      }
      if (opts?.note_id) {
        params.push(opts.note_id);
        sql += ` AND note_id = $${params.length}`;
      }
      sql += " ORDER BY created_at DESC LIMIT 500";
      const r = await query(sql, params);
      return r.rows.map((row) => ({
        id: String(row.id),
        space_id: String(row.space_id),
        skill_id: String(row.skill_id),
        note_id: row.note_id == null ? null : String(row.note_id),
        kind: String(row.kind),
        payload: (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>,
        created_at: row.created_at == null ? undefined : String(row.created_at),
      }));
    },
    async queryLinks(opts) {
      const params: unknown[] = [spaceId];
      let sql = `SELECT l.from_note_id, l.to_note_id
                 FROM links l
                 WHERE l.from_note_id IN (SELECT id FROM notes WHERE space_id = $1 AND deleted_at IS NULL)
                    OR l.to_note_id IN (SELECT id FROM notes WHERE space_id = $1 AND deleted_at IS NULL)`;
      if (opts?.note_ids?.length) {
        params.push(opts.note_ids);
        sql += ` AND (l.from_note_id = ANY($${params.length}::uuid[]) OR l.to_note_id = ANY($${params.length}::uuid[]))`;
      }
      const r = await query(sql, params);
      return r.rows.map((row) => ({
        from_note_id: String(row.from_note_id),
        to_note_id: row.to_note_id == null ? null : String(row.to_note_id),
      }));
    },
  };
}
