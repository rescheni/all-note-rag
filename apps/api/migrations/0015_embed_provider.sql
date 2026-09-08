ALTER TABLE hub_settings
  ADD COLUMN IF NOT EXISTS embed_provider text NOT NULL DEFAULT 'api';

UPDATE hub_settings
SET embed_provider = 'local'
WHERE embed_provider = 'api'
  AND embedding_model LIKE 'Xenova/%';
