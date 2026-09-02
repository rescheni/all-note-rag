import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTE_ACL_SNAPSHOT,
  defaultNoteAcl,
  noteVisibleSql,
  noteVisibleTo,
  parseNoteAcl,
  serializeNoteAcl,
} from "../src/acl.ts";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const member = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("parseNoteAcl", () => {
  it("defaults missing and legacy visible_in_space to space", () => {
    expect(parseNoteAcl(null).visibility).toBe("space");
    expect(parseNoteAcl(undefined).visibility).toBe("space");
    expect(parseNoteAcl({}).visibility).toBe("space");
    expect(parseNoteAcl({ visible_in_space: true }).visibility).toBe("space");
    expect(parseNoteAcl({ visible_in_space: true }).visible_in_space).toBe(true);
    expect(defaultNoteAcl().visibility).toBe("space");
    expect(DEFAULT_NOTE_ACL_SNAPSHOT.visible_in_space).toBe(true);
  });

  it("legacy visible_in_space false is owners-only", () => {
    expect(parseNoteAcl({ visible_in_space: false }).visibility).toBe("owners");
    expect(parseNoteAcl({ visible_in_space: false }).visible_in_space).toBe(false);
  });

  it("reads members list and drops bad ids", () => {
    const acl = parseNoteAcl({
      visibility: "members",
      user_ids: [member, "not-a-uuid", member.toUpperCase(), 1],
      roles: ["editor", "nope", "editor"],
    });
    expect(acl.visibility).toBe("members");
    expect(acl.user_ids).toEqual([member]);
    expect(acl.roles).toEqual(["editor"]);
    expect(acl.visible_in_space).toBe(false);
  });
});

describe("noteVisibleTo", () => {
  it("space: any member, including viewer", () => {
    const acl = parseNoteAcl({ visible_in_space: true });
    expect(noteVisibleTo(acl, member, "viewer")).toBe(true);
    expect(noteVisibleTo(acl, owner, "owner")).toBe(true);
  });

  it("owners: only owner role", () => {
    const acl = parseNoteAcl({ visibility: "owners" });
    expect(noteVisibleTo(acl, owner, "owner")).toBe(true);
    expect(noteVisibleTo(acl, member, "editor")).toBe(false);
    expect(noteVisibleTo(acl, member, "viewer")).toBe(false);
  });

  it("members: listed users plus owners; roles optional", () => {
    const acl = parseNoteAcl({
      visibility: "members",
      user_ids: [member],
      roles: ["editor"],
    });
    expect(noteVisibleTo(acl, owner, "owner")).toBe(true);
    expect(noteVisibleTo(acl, member, "viewer")).toBe(true);
    expect(noteVisibleTo(acl, other, "editor")).toBe(true);
    expect(noteVisibleTo(acl, other, "viewer")).toBe(false);
  });
});

describe("serializeNoteAcl", () => {
  it("keeps visible_in_space in lockstep with visibility", () => {
    expect(serializeNoteAcl(parseNoteAcl({ visibility: "space" }))).toEqual({
      visibility: "space",
      visible_in_space: true,
      user_ids: [],
      roles: [],
    });
    const listed = serializeNoteAcl(
      parseNoteAcl({ visibility: "members", user_ids: [member], roles: ["viewer"] }),
    );
    expect(listed.visible_in_space).toBe(false);
    expect(listed.user_ids).toEqual([member]);
    expect(listed.roles).toEqual(["viewer"]);
  });

  it("builds a SQL predicate", () => {
    expect(noteVisibleSql("n.acl_snapshot", 4, 5)).toBe(
      "note_visible_to(n.acl_snapshot, $4::uuid, $5::text)",
    );
  });
});
