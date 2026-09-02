import type { MemberRole } from "./types.ts";

export const NOTE_ACL_VISIBILITIES = ["space", "owners", "members"] as const;
export type NoteAclVisibility = (typeof NOTE_ACL_VISIBILITIES)[number];

export const DEFAULT_NOTE_ACL_SNAPSHOT = {
  visibility: "space",
  visible_in_space: true,
  user_ids: [] as string[],
  roles: [] as MemberRole[],
} as const;

export type NoteAcl = {
  visibility: NoteAclVisibility;
  /** Listed member user ids when visibility is `members`. */
  user_ids: string[];
  /** Optional extra space roles that may read when visibility is `members`. */
  roles: MemberRole[];
  /** Legacy flag kept in the snapshot so old rows stay readable. */
  visible_in_space: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isNoteAclVisibility(value: string): value is NoteAclVisibility {
  return value === "space" || value === "owners" || value === "members";
}

function isMemberRole(value: string): value is MemberRole {
  return value === "owner" || value === "editor" || value === "viewer";
}

function uniqueIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const v = id.trim().toLowerCase();
    if (!UUID_RE.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function uniqueRoles(roles: string[]): MemberRole[] {
  const out: MemberRole[] = [];
  const seen = new Set<string>();
  for (const r of roles) {
    if (!isMemberRole(r) || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/** Parse stored `notes.acl_snapshot`. Missing / `{visible_in_space:true}` → space. */
export function parseNoteAcl(raw: unknown): NoteAcl {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const visRaw = typeof obj.visibility === "string" ? obj.visibility.trim() : "";
  let visibility: NoteAclVisibility;
  if (isNoteAclVisibility(visRaw)) {
    visibility = visRaw;
  } else if (obj.visible_in_space === false) {
    visibility = "owners";
  } else {
    visibility = "space";
  }
  const user_ids = uniqueIds(readStringArray(obj.user_ids));
  const roles = uniqueRoles(readStringArray(obj.roles));
  return {
    visibility,
    user_ids,
    roles,
    visible_in_space: visibility === "space",
  };
}

export function serializeNoteAcl(acl: NoteAcl): {
  visibility: NoteAclVisibility;
  visible_in_space: boolean;
  user_ids: string[];
  roles: MemberRole[];
} {
  return {
    visibility: acl.visibility,
    visible_in_space: acl.visibility === "space",
    user_ids: acl.visibility === "members" ? acl.user_ids : [],
    roles: acl.visibility === "members" ? acl.roles : [],
  };
}

export function defaultNoteAcl(): NoteAcl {
  return parseNoteAcl(DEFAULT_NOTE_ACL_SNAPSHOT);
}

/**
 * Space members still have to pass this after membership.
 * Owners always see the note so they can manage visibility.
 */
export function noteVisibleTo(acl: NoteAcl, userId: string, role: string): boolean {
  if (role === "owner") return true;
  if (acl.visibility === "space") return true;
  if (acl.visibility === "owners") return false;
  const uid = userId.trim().toLowerCase();
  if (uid && acl.user_ids.includes(uid)) return true;
  if (isMemberRole(role) && acl.roles.includes(role)) return true;
  return false;
}

export function noteVisibleToRaw(raw: unknown, userId: string, role: string): boolean {
  return noteVisibleTo(parseNoteAcl(raw), userId, role);
}

/** SQL predicate; params are uuid then role text. */
export function noteVisibleSql(aclExpr: string, userParam: number, roleParam: number): string {
  return `note_visible_to(${aclExpr}, $${userParam}::uuid, $${roleParam}::text)`;
}
