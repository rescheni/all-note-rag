-- Persist source-native note links, including unresolved/dangling targets.
CREATE TABLE note_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  source_note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
  raw_target text NOT NULL,
  raw_link text NOT NULL,
  label text NOT NULL,
  link_kind text NOT NULL CHECK (link_kind IN ('wiki','block_ref','page_mention','doc_mention','note_path')),
  source_offset integer NOT NULL DEFAULT 0,
  heading text,
  native_target_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX note_links_source_idx ON note_links (source_note_id);
CREATE INDEX note_links_target_idx ON note_links (target_note_id) WHERE target_note_id IS NOT NULL;
CREATE INDEX note_links_scope_idx ON note_links (space_id, connection_id);
CREATE UNIQUE INDEX note_links_occurrence_idx ON note_links (source_note_id, source_offset, raw_link);
