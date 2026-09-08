-- Search history (per user + space) and Ask AI-failure metadata on messages.

CREATE TABLE IF NOT EXISTS search_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  query text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS search_history_user_space_created_idx
  ON search_history (user_id, space_id, created_at DESC);

ALTER TABLE ask_messages
  ADD COLUMN IF NOT EXISTS ai_failed boolean NOT NULL DEFAULT false;

ALTER TABLE ask_messages
  ADD COLUMN IF NOT EXISTS ai_error text;
