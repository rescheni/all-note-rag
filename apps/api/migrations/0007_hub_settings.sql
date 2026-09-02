CREATE TABLE IF NOT EXISTS hub_settings (
  id text PRIMARY KEY,
  base_url text NOT NULL DEFAULT '',
  embedding_model text NOT NULL DEFAULT '',
  chat_model text NOT NULL DEFAULT '',
  secrets_ref uuid REFERENCES secrets(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
