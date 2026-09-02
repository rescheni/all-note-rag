ALTER TABLE assets ADD COLUMN IF NOT EXISTS extract_updated_at timestamptz;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS extract_attempts int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS assets_extract_status_idx
  ON assets (extract_status)
  WHERE extract_status IN ('pending', 'running', 'error');
