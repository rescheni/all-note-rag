-- Persistent Ask (问答) chat threads + messages per space/user.

CREATE TABLE ask_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ask_threads_space_user_updated_idx
  ON ask_threads (space_id, user_id, updated_at DESC);

CREATE TABLE ask_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  citations jsonb,
  mode text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ask_messages_thread_created_idx
  ON ask_messages (thread_id, created_at);
