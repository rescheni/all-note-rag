import type { AdapterContext, ContactsSyncSnapshot } from "@note-hub/core";
import { contactsSyncSnapshot, planFeishuContactMembers } from "@note-hub/core";
import { FeishuAdapter } from "./feishu.ts";

export async function runFeishuContactsSync(opts: {
  ctx: AdapterContext;
  fetchFn?: typeof fetch;
  spaceKind: string;
  existingMemberIds: Set<string>;
  findUsersByEmails: (emails: string[]) => Promise<{ id: string; email: string }[]>;
  insertViewerIfAbsent: (userId: string) => Promise<boolean>;
}): Promise<ContactsSyncSnapshot> {
  const adapter = new FeishuAdapter(opts.fetchFn);
  const contacts = await adapter.listContacts(opts.ctx);
  const emails = [...new Set(contacts.map((c) => c.email).filter((e): e is string => Boolean(e)))];
  const users = emails.length ? await opts.findUsersByEmails(emails) : [];
  const usersByEmail = new Map(users.map((u) => [u.email.trim().toLowerCase(), u.id]));
  const plan = planFeishuContactMembers({
    contacts,
    usersByEmail,
    existingMemberIds: opts.existingMemberIds,
    spaceKind: opts.spaceKind,
  });
  let added = 0;
  for (const row of plan.toAdd) {
    if (await opts.insertViewerIfAbsent(row.userId)) added++;
  }
  return contactsSyncSnapshot(plan, added);
}
