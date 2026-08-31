CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('personal', 'team')),
  name text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE space_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, user_id)
);

CREATE TABLE secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('obsidian', 'siyuan', 'notion', 'feishu')),
  name text NOT NULL,
  config jsonb NOT NULL,
  secrets_ref text,
  cursor jsonb,
  mode text,
  status text NOT NULL DEFAULT 'active',
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  path text NOT NULL,
  title text NOT NULL,
  markdown text,
  frontmatter jsonb,
  hash text NOT NULL,
  acl_snapshot jsonb,
  deleted_at timestamptz,
  source_updated_at timestamptz,
  storage text NOT NULL DEFAULT 'db',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, source_id)
);

CREATE INDEX notes_space_live_idx ON notes (space_id) WHERE deleted_at IS NULL;

CREATE TABLE blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  source_block_id text NOT NULL,
  type text NOT NULL,
  text text,
  order_key text NOT NULL,
  parent_id uuid REFERENCES blocks(id) ON DELETE SET NULL,
  depth int NOT NULL DEFAULT 0,
  UNIQUE (note_id, source_block_id)
);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source_path text NOT NULL,
  content_type text,
  s3_key text NOT NULL,
  hash text,
  bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
  to_source_id text,
  kind text NOT NULL CHECK (kind IN ('ref', 'embed', 'url', 'mention')),
  raw text NOT NULL,
  from_block_id uuid REFERENCES blocks(id) ON DELETE SET NULL
);

CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  block_id uuid REFERENCES blocks(id) ON DELETE SET NULL,
  heading_path text,
  text text NOT NULL,
  token_count int NOT NULL DEFAULT 0,
  embedding vector(1536),
  fts tsvector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chunks_fts_idx ON chunks USING gin (fts);
CREATE INDEX chunks_space_idx ON chunks (space_id);

CREATE TABLE topic_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  topic text NOT NULL,
  weight real NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE growth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('goal', 'habit', 'mood', 'review', 'focus')),
  happened_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION growth_personal_only() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM spaces s WHERE s.id = NEW.space_id AND s.kind = 'personal'
  ) THEN
    RAISE EXCEPTION 'GrowthEvent only allowed on personal spaces';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER growth_events_personal_only
  BEFORE INSERT OR UPDATE ON growth_events
  FOR EACH ROW EXECUTE FUNCTION growth_personal_only();

CREATE TABLE sync_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  upserts int NOT NULL DEFAULT 0,
  deletes int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  cursor_before jsonb,
  cursor_after jsonb
);

CREATE TABLE sync_note_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  source_id text,
  note_id uuid,
  level text NOT NULL DEFAULT 'error',
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sync_run_conn_idx ON sync_run (connection_id, started_at DESC);
CREATE INDEX sync_note_log_conn_idx ON sync_note_log (connection_id, created_at DESC);
