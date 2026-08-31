import {
  createPgHostApi,
  isSkillEnabled,
  runOfficialHook,
  type HostNote,
} from "@note-hub/skills-runtime";
import { query } from "./db.ts";

export type UpsertedNote = {
  noteId: string;
  path: string;
  title: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  hash: string;
};

export async function runPostSyncGrowth(spaceId: string, notes: UpsertedNote[]): Promise<void> {
  if (!notes.length) return;
  const space = await query<{ kind: string; owner_user_id: string }>(
    "SELECT kind, owner_user_id FROM spaces WHERE id = $1",
    [spaceId],
  );
  const row = space.rows[0];
  if (!row || row.kind !== "personal") return;
  const enabled = await isSkillEnabled(query, spaceId, "growth-weekly");
  if (!enabled) return;
  const host = createPgHostApi({ query, spaceId, userId: row.owner_user_id });
  const payloadNotes: HostNote[] = notes.map((n) => ({
    id: n.noteId,
    path: n.path,
    title: n.title,
    markdown: n.markdown,
    frontmatter: n.frontmatter,
    hash: n.hash,
    updated_at: new Date().toISOString(),
  }));
  await runOfficialHook("growth-weekly", {
    space_id: spaceId,
    hook: "post-sync",
    payload: { notes: payloadNotes },
    host,
  });
}
