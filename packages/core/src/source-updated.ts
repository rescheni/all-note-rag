/** Parse SiYuan `updated` like `20250414073505` as Asia/Shanghai local wall time. */

function unixToDate(n: number): Date | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * SiYuan stores `updated` as `YYYYMMDDHHmmss` in Asia/Shanghai (no DST).
 * Also accepts unix seconds/millis and ISO-ish date strings.
 */
export function parseSiyuanUpdated(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number") return unixToDate(raw);
  const s = String(raw).trim();
  if (!s) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (compact) {
    const y = Number(compact[1]);
    const mo = Number(compact[2]);
    const d = Number(compact[3]);
    const h = Number(compact[4]);
    const mi = Number(compact[5]);
    const se = Number(compact[6]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    // Shanghai is UTC+8 year-round; Date.UTC rolls negative hours to the previous day.
    const out = new Date(Date.UTC(y, mo - 1, d, h - 8, mi, se));
    return Number.isNaN(out.getTime()) ? null : out;
  }
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 1e9) return unixToDate(asNum);
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return new Date(parsed);
  return null;
}

function parseSyDocumentUpdated(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const props = (parsed.Properties ?? parsed.properties ?? {}) as Record<string, unknown>;
    return parseSiyuanUpdated(props.updated) ?? parseSiyuanUpdated(parsed.updated);
  } catch {
    return null;
  }
}

function payloadRawText(raw: string | Uint8Array | undefined): string {
  if (typeof raw === "string") return raw;
  if (raw) return new TextDecoder().decode(raw);
  return "";
}

function frontmatterDate(frontmatter: Record<string, unknown> | undefined): Date | null {
  if (!frontmatter) return null;
  return parseSiyuanUpdated(frontmatter.updated) ?? parseSiyuanUpdated(frontmatter.date);
}

export function resolveNoteSourceUpdatedAt(opts: {
  source: string;
  payload: { raw?: string | Uint8Array; source_updated_at?: string; etag?: string };
  frontmatter?: Record<string, unknown>;
  now?: Date;
}): Date {
  const now = opts.now ?? new Date();
  if (opts.source === "siyuan") {
    const fromDoc = parseSyDocumentUpdated(payloadRawText(opts.payload.raw));
    if (fromDoc) return fromDoc;
    const fromPayload = parseSiyuanUpdated(opts.payload.source_updated_at);
    if (fromPayload) return fromPayload;
    const fromEtag = parseSiyuanUpdated(opts.payload.etag);
    if (fromEtag) return fromEtag;
    return now;
  }
  const fromFm = frontmatterDate(opts.frontmatter);
  if (fromFm) return fromFm;
  const fromPayload = parseSiyuanUpdated(opts.payload.source_updated_at);
  if (fromPayload) return fromPayload;
  const fromEtag = parseSiyuanUpdated(opts.payload.etag);
  if (fromEtag) return fromEtag;
  return now;
}
