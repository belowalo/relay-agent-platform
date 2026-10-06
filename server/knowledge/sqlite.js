import { DatabaseSync } from 'node:sqlite';
import { createKnowledgeRepository } from './repository.js';
import { context } from './contracts.js';
import { jobSchema } from '../foundation/contracts.js';

// Disposable/local development adapter, deliberately separate from Relay's private legacy DB.
export function createSqliteKnowledge(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS knowledge_sources(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,collection_id TEXT NOT NULL,external_id TEXT NOT NULL,version INTEGER NOT NULL,indexed_version INTEGER,fingerprint TEXT NOT NULL,access TEXT NOT NULL,metadata TEXT NOT NULL,name TEXT NOT NULL,deleted INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(workspace_id,collection_id,external_id),UNIQUE(workspace_id,id));
    CREATE TABLE IF NOT EXISTS knowledge_versions(workspace_id TEXT NOT NULL,source_id TEXT NOT NULL,version INTEGER NOT NULL,input TEXT NOT NULL,extraction TEXT,content_hash TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(workspace_id,source_id,version),FOREIGN KEY(workspace_id,source_id) REFERENCES knowledge_sources(workspace_id,id));
    CREATE TABLE IF NOT EXISTS knowledge_jobs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,source_id TEXT NOT NULL,version INTEGER NOT NULL,context TEXT NOT NULL,state TEXT DEFAULT 'queued',progress INTEGER DEFAULT 0,phase TEXT DEFAULT 'queued',owner_id TEXT,generation INTEGER DEFAULT 0,expires_at INTEGER,error TEXT,diagnostics TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(workspace_id,source_id,version) REFERENCES knowledge_versions(workspace_id,source_id,version));
    CREATE TABLE IF NOT EXISTS knowledge_chunks(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,collection_id TEXT NOT NULL,source_id TEXT NOT NULL,version INTEGER NOT NULL,ordinal INTEGER NOT NULL,content TEXT NOT NULL,location TEXT NOT NULL,UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,source_id,version) REFERENCES knowledge_versions(workspace_id,source_id,version));
    CREATE TABLE IF NOT EXISTS knowledge_vectors(workspace_id TEXT NOT NULL,chunk_id TEXT PRIMARY KEY,model TEXT NOT NULL,embedding TEXT NOT NULL,FOREIGN KEY(workspace_id,chunk_id) REFERENCES knowledge_chunks(workspace_id,id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS knowledge_blob_gc(workspace_id TEXT NOT NULL,key TEXT NOT NULL,state TEXT DEFAULT 'queued',PRIMARY KEY(workspace_id,key));
    CREATE TABLE IF NOT EXISTS knowledge_outbox(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,job TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5(content,chunk_id UNINDEXED);
    CREATE TRIGGER IF NOT EXISTS knowledge_chunk_insert AFTER INSERT ON knowledge_chunks BEGIN INSERT INTO knowledge_search(content,chunk_id) VALUES(new.content,new.id); END;
    CREATE TRIGGER IF NOT EXISTS knowledge_chunk_delete AFTER DELETE ON knowledge_chunks BEGIN DELETE FROM knowledge_search WHERE chunk_id=old.id; END;
    CREATE INDEX IF NOT EXISTS knowledge_scope ON knowledge_chunks(workspace_id,collection_id,source_id);`);
  let queue = Promise.resolve();
  const database = {
    transaction(ctx, callback) {
      ctx = context(ctx);
      const run = queue.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        const invoke = (text, values, method) => {
          const stmt = db.prepare(text);
          const args = text.includes('?1')
            ? [Object.fromEntries(values.map((v, i) => ['?' + (i + 1), v]))]
            : values;
          return stmt[method](...args);
        };
        const session = {
          context: ctx,
          one: async (t, v = []) => invoke(t, v, 'get') || null,
          all: async (t, v = []) => invoke(t, v, 'all'),
          query: async (t, v = []) => {
            const r = invoke(t, v, 'run');
            return { rowCount: Number(r.changes), rows: [] };
          },
        };
        try {
          const result = await callback(session);
          db.exec('COMMIT');
          return result;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      });
      queue = run.catch(() => {});
      return run;
    },
    async close() {
      await queue;
      db.close();
    },
  };
  const repository = createKnowledgeRepository(database, {
    dialect: 'sqlite',
    enqueue: async (session, job) => {
      job = jobSchema.parse(job);
      if (job.workspaceId !== session.context.workspaceId)
        throw new Error('Outbox tenant mismatch');
      await session.query('INSERT INTO knowledge_outbox(id,workspace_id,job) VALUES(?,?,?)', [
        job.id,
        job.workspaceId,
        JSON.stringify(job),
      ]);
    },
  });
  return { ...repository, close: database.close };
}
