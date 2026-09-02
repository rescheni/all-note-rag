import { describe, expect, it } from "vitest";
import {
  parseFeishuContactItem,
  planFeishuContactMembers,
  normalizeContactEmail,
} from "../src/feishu-contacts.ts";

describe("parseFeishuContactItem", () => {
  it("reads email / enterprise_email / open_id and skips resigned", () => {
    expect(parseFeishuContactItem({ open_id: "ou_1", email: "A@Ex.com", name: "甲" })).toEqual({
      open_id: "ou_1",
      email: "a@ex.com",
      name: "甲",
    });
    expect(
      parseFeishuContactItem({ user_id: "ou_2", enterprise_email: "b@ex.com" }),
    ).toEqual({ open_id: "ou_2", email: "b@ex.com", name: null });
    expect(parseFeishuContactItem({ open_id: "ou_3", email: "c@ex.com", status: { is_resigned: true } })).toBeNull();
    expect(parseFeishuContactItem({ email: "no-id@ex.com" })).toBeNull();
  });
});

describe("planFeishuContactMembers", () => {
  const owner = "u-owner";
  const viewer = "u-match";
  const usersByEmail = new Map([
    ["owner@ex.com", owner],
    ["match@ex.com", viewer],
  ]);

  it("matches email → add viewer; unknown and no-email skipped; owner stays existing", () => {
    const plan = planFeishuContactMembers({
      contacts: [
        { open_id: "ou_owner", email: "owner@ex.com", name: "主" },
        { open_id: "ou_match", email: "match@ex.com", name: "配" },
        { open_id: "ou_unknown", email: "ghost@ex.com", name: "无" },
        { open_id: "ou_none", email: null, name: "空" },
      ],
      usersByEmail,
      existingMemberIds: new Set([owner]),
      spaceKind: "team",
    });
    expect(plan.pulled).toBe(4);
    expect(plan.matched).toBe(2);
    expect(plan.already_member).toBe(1);
    expect(plan.skipped).toBe(2);
    expect(plan.toAdd).toEqual([{ userId: viewer, email: "match@ex.com", open_id: "ou_match" }]);
  });

  it("second plan is idempotent when match is already a member", () => {
    const plan = planFeishuContactMembers({
      contacts: [{ open_id: "ou_match", email: "match@ex.com", name: "配" }],
      usersByEmail,
      existingMemberIds: new Set([owner, viewer]),
      spaceKind: "team",
    });
    expect(plan.toAdd).toEqual([]);
    expect(plan.already_member).toBe(1);
    expect(plan.matched).toBe(1);
  });

  it("does not add extra members on a personal space", () => {
    const plan = planFeishuContactMembers({
      contacts: [{ open_id: "ou_match", email: "match@ex.com", name: "配" }],
      usersByEmail,
      existingMemberIds: new Set([owner]),
      spaceKind: "personal",
    });
    expect(plan.toAdd).toEqual([]);
    expect(plan.matched).toBe(1);
    expect(plan.skipped).toBe(1);
  });
});

describe("normalizeContactEmail", () => {
  it("rejects junk", () => {
    expect(normalizeContactEmail("  x@Y.COM ")).toBe("x@y.com");
    expect(normalizeContactEmail("@x.com")).toBeNull();
    expect(normalizeContactEmail("nope")).toBeNull();
  });
});
