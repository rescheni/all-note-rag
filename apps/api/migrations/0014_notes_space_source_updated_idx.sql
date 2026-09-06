-- Activity heatmap: filter notes by space + source_updated_at without seq-scan tax.
CREATE INDEX IF NOT EXISTS notes_space_source_updated_live_idx
  ON notes (space_id, source_updated_at)
  WHERE deleted_at IS NULL;
