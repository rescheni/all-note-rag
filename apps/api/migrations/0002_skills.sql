CREATE TABLE skills (
  id text PRIMARY KEY,
  version text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  hooks text[] NOT NULL DEFAULT ARRAY[]::text[],
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  path text
);

CREATE TABLE space_skills (
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, skill_id),
  UNIQUE (space_id, skill_id)
);

CREATE TABLE growth_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  range_from date NOT NULL,
  range_to date NOT NULL,
  markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX growth_reports_space_idx ON growth_reports (space_id, created_at DESC);
CREATE INDEX growth_events_space_time_idx ON growth_events (space_id, happened_at DESC);
CREATE INDEX space_skills_skill_idx ON space_skills (skill_id);
