ALTER TABLE relay.schedules ADD COLUMN version_id text REFERENCES relay.versions(id);
ALTER TABLE relay.schedules ADD COLUMN actor text;
ALTER TABLE relay.schedules ADD COLUMN request_id text;
CREATE INDEX runtime_schedule_due ON relay.schedules(workspace_id,enabled,next_at) WHERE actor IS NOT NULL;
