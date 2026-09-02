import type { ContactsSyncSnapshot } from "./types.ts";

export type FeishuContactUser = {
  open_id: string;
  email: string | null;
  name: string | null;
};

export type FeishuContactMatch = {
  userId: string;
  email: string;
  open_id: string;
};

export type FeishuContactPlan = {
  toAdd: FeishuContactMatch[];
  pulled: number;
  matched: number;
  skipped: number;
  already_member: number;
};

export function normalizeContactEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes("@") || email.startsWith("@") || email.endsWith("@")) return null;
  return email;
}

function asDict(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isInactiveContact(status: Record<string, unknown> | null): boolean {
  if (!status) return false;
  return Boolean(status.is_resigned || status.is_exited || status.is_unjoin);
}

/** Parse one Feishu contact/user payload. Inactive / missing open_id → null. */
export function parseFeishuContactItem(raw: unknown): FeishuContactUser | null {
  const item = asDict(raw);
  if (!item) return null;
  if (isInactiveContact(asDict(item.status))) return null;
  const open_id = String(item.open_id ?? item.user_id ?? "").trim();
  if (!open_id) return null;
  const email =
    normalizeContactEmail(item.email) ?? normalizeContactEmail(item.enterprise_email);
  const nameRaw = item.name ?? item.en_name ?? item.nickname;
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : null;
  return { open_id, email, name };
}

/**
 * Map Feishu directory users onto hub users.
 * - Match by lowercased email only (open_id is recorded but not stored; no hub column).
 * - No auto-create. Unknown / missing emails are skipped.
 * - Personal spaces never gain extra members.
 * - Existing members (any role, including owner) are left untouched.
 */
export function planFeishuContactMembers(opts: {
  contacts: FeishuContactUser[];
  usersByEmail: Map<string, string>;
  existingMemberIds: Set<string>;
  spaceKind: string;
}): FeishuContactPlan {
  const seenOpen = new Set<string>();
  const seenUsers = new Set<string>();
  const toAdd: FeishuContactMatch[] = [];
  let pulled = 0;
  let matched = 0;
  let skipped = 0;
  let already_member = 0;
  const team = opts.spaceKind === "team";

  for (const person of opts.contacts) {
    if (!person.open_id || seenOpen.has(person.open_id)) continue;
    seenOpen.add(person.open_id);
    pulled++;
    if (!person.email) {
      skipped++;
      continue;
    }
    const userId = opts.usersByEmail.get(person.email);
    if (!userId) {
      skipped++;
      continue;
    }
    if (seenUsers.has(userId)) continue;
    seenUsers.add(userId);
    matched++;
    if (opts.existingMemberIds.has(userId)) {
      already_member++;
      continue;
    }
    if (!team) {
      skipped++;
      continue;
    }
    toAdd.push({ userId, email: person.email, open_id: person.open_id });
  }

  return { toAdd, pulled, matched, skipped, already_member };
}

export function contactsSyncSnapshot(
  plan: FeishuContactPlan,
  added: number,
  extra?: { error?: string },
): ContactsSyncSnapshot {
  const snap: ContactsSyncSnapshot = {
    last_at: new Date().toISOString(),
    pulled: plan.pulled,
    matched: plan.matched,
    added,
    skipped: plan.skipped,
    already_member: plan.already_member,
  };
  if (extra?.error) snap.error = extra.error;
  return snap;
}
