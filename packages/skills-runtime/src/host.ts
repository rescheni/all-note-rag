import { growthAccessError } from "./access.ts";
import { growthEventDedupeKey } from "./extract.ts";
import type {
  GrowthKind,
  HostApi,
  HostGrowthEvent,
  HostNote,
  SqlQuery,
  WriteGrowthEvent,
} from "./types.ts";

export type MemoryHostState = {
  spaceId: string;
  userId: string;
  spaceKind: "personal" | "team";
  notes: HostNote[];
  events: HostGrowthEvent[];
  reports: Array<{ id: string; range_from: string; range_to: string; markdown: string }>;
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
  };
}
