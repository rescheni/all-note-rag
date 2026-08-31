CREATE TABLE skill_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  note_id uuid REFERENCES notes(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX skill_artifacts_skill_note_kind_uidx
  ON skill_artifacts (skill_id, note_id, kind)
  WHERE note_id IS NOT NULL;

CREATE UNIQUE INDEX skill_artifacts_space_skill_kind_null_note_uidx
  ON skill_artifacts (space_id, skill_id, kind)
  WHERE note_id IS NULL;

CREATE INDEX skill_artifacts_space_skill_idx ON skill_artifacts (space_id, skill_id);
