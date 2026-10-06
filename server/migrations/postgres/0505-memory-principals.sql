-- Legacy memories retain their contents but are quarantined until an operator
-- assigns provenance. An unknown writer must never become shared agent memory.
ALTER TABLE relay.memories ADD COLUMN principal text;
CREATE INDEX memories_principal ON relay.memories(workspace_id,principal,agent_id,conversation_id,created_at DESC);
-- Restrictive policy also protects a rollback to code without scoped queries:
-- missing provenance/context fails closed rather than disclosing shared rows.
CREATE POLICY memories_writer ON relay.memories AS RESTRICTIVE USING(principal=nullif(current_setting('relay.principal',true),'')) WITH CHECK(principal=nullif(current_setting('relay.principal',true),''));
