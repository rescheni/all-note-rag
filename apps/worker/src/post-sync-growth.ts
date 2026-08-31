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

function toHostNotes(notes: UpsertedNote[]): HostNote[] {
  return notes.map((n) => ({
    id: n.noteId,
    path: n.path,
    title: n.title,
    markdown: n.markdown,
    frontmatter: n.frontmatter,
    hash: n.hash,
    updated_at: new Date().toISOString(),
  }));
}

export async function runPostSyncGrowth(spaceId: string, notes: UpsertedNote[]): Promise<void> {
  if (!notes.length) return;
  const space = await query<{ kind: string; owner_user_id: string }>(
    "SELECT kind, owner_user_id FROM spaces WHERE id = $1",
    [spaceId],
  );
  const row = space.rows[0];
  if (!row) return;
  const host = createPgHostApi({ query, spaceId, userId: row.owner_user_id });
  const payloadNotes = toHostNotes(notes);

  if (row.kind === "personal") {
    try {
      const enabled = await isSkillEnabled(query, spaceId, "growth-weekly");
      if (enabled) {
        await runOfficialHook("growth-weekly", {
          space_id: spaceId,
          hook: "post-sync",
          payload: { notes: payloadNotes },
          host,
        });
      }
    } catch (e) {
      console.error(JSON.stringify({ level: "error", message: "post-sync growth-weekly failed", error: String(e) }));
    }
  }

  try {
    const enabled = await isSkillEnabled(query, spaceId, "meeting-extract");
    if (enabled) {
      for (const note of payloadNotes) {
        try {
          await runOfficialHook("meeting-extract", {
            space_id: spaceId,
            hook: "post-sync",
            payload: { notes: [note] },
            host,
          });
        } catch (e) {
          console.error(
            JSON.stringify({
              level: "error",
              message: "post-sync meeting-extract failed",
              note_id: note.id,
              error: String(e),
            }),
          );
        }
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "post-sync meeting-extract batch failed", error: String(e) }));
  }
}
