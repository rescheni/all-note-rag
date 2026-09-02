-- Document-level ACL on notes.acl_snapshot.
-- Existing rows stay space-visible so personal spaces do not go empty.
-- Does not delete notes or assets.

CREATE OR REPLACE FUNCTION note_visible_to(acl jsonb, uid uuid, role text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  vis text;
  ids jsonb;
  roles jsonb;
BEGIN
  IF uid IS NULL THEN
    RETURN false;
  END IF;
  -- Space owners always see the note so they can manage visibility.
  IF role = 'owner' THEN
    RETURN true;
  END IF;
  IF acl IS NULL OR acl = 'null'::jsonb OR acl = '{}'::jsonb THEN
    RETURN true;
  END IF;
  vis := acl->>'visibility';
  IF vis IS NULL OR vis = '' THEN
    IF COALESCE((acl->>'visible_in_space')::boolean, true) THEN
      vis := 'space';
    ELSE
      vis := 'owners';
    END IF;
  END IF;
  IF vis = 'space' THEN
    RETURN true;
  END IF;
  IF vis = 'owners' THEN
    RETURN false;
  END IF;
  IF vis = 'members' THEN
    ids := COALESCE(acl->'user_ids', '[]'::jsonb);
    IF jsonb_typeof(ids) = 'array' AND ids ? uid::text THEN
      RETURN true;
    END IF;
    roles := COALESCE(acl->'roles', '[]'::jsonb);
    IF role IS NOT NULL AND jsonb_typeof(roles) = 'array' AND roles ? role THEN
      RETURN true;
    END IF;
  END IF;
  RETURN false;
END;
$$;

COMMENT ON FUNCTION note_visible_to(jsonb, uuid, text) IS
  'Per-note ACL: space (all members), owners, or listed members. Owners always pass.';

UPDATE notes
SET acl_snapshot = jsonb_build_object(
  'visibility', 'space',
  'visible_in_space', true,
  'user_ids', '[]'::jsonb,
  'roles', '[]'::jsonb
)
WHERE acl_snapshot IS NULL
   OR (
     (acl_snapshot->>'visibility') IS NULL
     AND COALESCE((acl_snapshot->>'visible_in_space')::boolean, true)
   );
