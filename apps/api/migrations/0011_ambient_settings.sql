-- Per-user UI preferences ride the existing hub_settings table (id = 'ambient:<user_id>').
ALTER TABLE hub_settings ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb;
