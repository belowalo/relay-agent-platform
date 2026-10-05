-- Branch before referencing row fields: PL/pgSQL expression planning can resolve both
-- sides of AND even for a different trigger table's record shape.
CREATE OR REPLACE FUNCTION relay.runtime_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='runs' THEN
  IF NEW.graph IS DISTINCT FROM OLD.graph OR NEW.input IS DISTINCT FROM OLD.input
   OR NEW.actor IS DISTINCT FROM OLD.actor OR NEW.limits IS DISTINCT FROM OLD.limits
   OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
   OR NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.mode IS DISTINCT FROM OLD.mode
   OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.child_key IS DISTINCT FROM OLD.child_key
   OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN
   RAISE EXCEPTION 'Run snapshot is immutable';
  END IF;
 ELSIF TG_TABLE_NAME='versions' THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Published revision is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
