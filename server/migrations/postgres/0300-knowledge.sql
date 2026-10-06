-- Apply after runtime's workspaces/collections migration. Requires pgvector >= 0.8.
CREATE UNIQUE INDEX knowledge_collection_tenant_key ON relay.collections(workspace_id,id);
CREATE TABLE relay.knowledge_sources (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES relay.workspaces(id),
 collection_id text NOT NULL REFERENCES relay.collections(id), external_id text NOT NULL,
 version integer NOT NULL, indexed_version integer, fingerprint text NOT NULL,
 access jsonb NOT NULL, metadata jsonb NOT NULL, name text NOT NULL,
 deleted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id, collection_id, external_id), UNIQUE(workspace_id,id), UNIQUE(workspace_id,collection_id,id),
 FOREIGN KEY(workspace_id,collection_id) REFERENCES relay.collections(workspace_id,id)
);
CREATE TABLE relay.knowledge_versions (
 workspace_id text NOT NULL, source_id text NOT NULL, version integer NOT NULL,
 input jsonb NOT NULL, extraction jsonb, content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,source_id,version),
 FOREIGN KEY(workspace_id,source_id) REFERENCES relay.knowledge_sources(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE relay.knowledge_jobs (
 id uuid PRIMARY KEY, workspace_id text NOT NULL, source_id text NOT NULL, version integer NOT NULL,
 context jsonb NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed','cancelled')),
 progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100), phase text NOT NULL DEFAULT 'queued',
 owner_id text, generation integer NOT NULL DEFAULT 0, expires_at bigint, error jsonb, diagnostics jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,source_id,version) REFERENCES relay.knowledge_versions(workspace_id,source_id,version) ON DELETE CASCADE
);
CREATE TABLE relay.knowledge_chunks (
 id text PRIMARY KEY, workspace_id text NOT NULL, collection_id text NOT NULL,
 source_id text NOT NULL, version integer NOT NULL, ordinal integer NOT NULL,
 content text NOT NULL, location jsonb NOT NULL,
 search tsvector GENERATED ALWAYS AS (to_tsvector('english',content)) STORED,
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,source_id,version) REFERENCES relay.knowledge_versions(workspace_id,source_id,version) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,collection_id,source_id) REFERENCES relay.knowledge_sources(workspace_id,collection_id,id) ON DELETE CASCADE
);
CREATE TABLE relay.knowledge_vectors (
 workspace_id text NOT NULL, chunk_id text PRIMARY KEY, model text NOT NULL, embedding vector(384) NOT NULL,
 FOREIGN KEY(workspace_id,chunk_id) REFERENCES relay.knowledge_chunks(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE relay.knowledge_blob_gc (
 workspace_id text NOT NULL, key text NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','deleted')), PRIMARY KEY(workspace_id,key)
);
CREATE INDEX knowledge_source_collection ON relay.knowledge_sources(workspace_id,collection_id) WHERE NOT deleted;
CREATE INDEX knowledge_jobs_recovery ON relay.knowledge_jobs(workspace_id,state,expires_at);
CREATE INDEX knowledge_chunks_scope ON relay.knowledge_chunks(workspace_id,collection_id,source_id,version);
CREATE INDEX knowledge_chunks_keyword ON relay.knowledge_chunks USING gin(search);
CREATE INDEX knowledge_vectors_ann ON relay.knowledge_vectors USING hnsw(embedding vector_cosine_ops);
CREATE INDEX knowledge_vectors_model ON relay.knowledge_vectors(workspace_id,model);
CREATE INDEX knowledge_metadata ON relay.knowledge_sources USING gin(metadata);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['knowledge_sources','knowledge_versions','knowledge_jobs','knowledge_chunks','knowledge_vectors','knowledge_blob_gc'] LOOP
  EXECUTE format('ALTER TABLE relay.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE relay.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON relay.%I USING (workspace_id = nullif(current_setting(''relay.workspace_id'',true),'''')) WITH CHECK (workspace_id = nullif(current_setting(''relay.workspace_id'',true),''''))',t);
 END LOOP;
END $$;
