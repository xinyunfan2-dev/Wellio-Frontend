import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 4

// Append ordered migrations here; never silently recreate an existing database.
const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE server_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      reset_epoch INTEGER NOT NULL CHECK(reset_epoch > 0),
      revision INTEGER NOT NULL CHECK(revision > 0),
      schema_version INTEGER NOT NULL,
      seed_source TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE action_requests (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      request_epoch INTEGER NOT NULL,
      result_epoch INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      result_json TEXT NOT NULL CHECK(json_valid(result_json)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, request_id)
    ) STRICT;
  `,
}, {
  version: 2,
  sql: `
    ALTER TABLE action_requests ADD COLUMN continuation_json TEXT CHECK(continuation_json IS NULL OR json_valid(continuation_json));
    CREATE TABLE context_reads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      reset_epoch INTEGER NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      UNIQUE(session_id, run_id, request_id, reset_epoch)
    ) STRICT;
    UPDATE sessions SET schema_version = 2, snapshot_json = json_set(snapshot_json, '$.schemaVersion', 2);
    UPDATE action_requests SET result_json = json_set(result_json, '$.snapshot.schemaVersion', 2)
      WHERE json_type(result_json, '$.snapshot') = 'object';
  `,
}, {
  version: 3,
  sql: `
    CREATE TABLE user_inputs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, reset_epoch INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      UNIQUE(session_id, request_id, reset_epoch)
    ) STRICT;
    CREATE TABLE write_authorizations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      reset_epoch INTEGER NOT NULL, source_message_id TEXT NOT NULL REFERENCES user_inputs(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)), consumed_by_request_id TEXT,
      UNIQUE(session_id, reset_epoch, source_message_id)
    ) STRICT;
    CREATE TABLE meal_operations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      reset_epoch INTEGER NOT NULL, meal_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
    ) STRICT;
    CREATE INDEX meal_operations_session ON meal_operations(session_id, reset_epoch);
    CREATE TABLE meal_entities (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, reset_epoch INTEGER NOT NULL,
      meal_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), head_operation_id TEXT,
      PRIMARY KEY(session_id, reset_epoch, meal_id)
    ) STRICT;
    UPDATE sessions SET schema_version = 3, snapshot_json = json_set(snapshot_json, '$.schemaVersion', 3);
    UPDATE action_requests SET result_json = json_set(result_json, '$.snapshot.schemaVersion', 3)
      WHERE json_type(result_json, '$.snapshot') = 'object';
    UPDATE context_reads SET record_json = json_set(record_json, '$.snapshot.schemaVersion', 3);
  `,
}, {
  version: 4,
  sql: `
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, reset_epoch INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      UNIQUE(session_id, request_id)
    ) STRICT;
    CREATE TABLE readiness_checks (
      check_key TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      reset_epoch INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
    ) STRICT;
    UPDATE sessions SET schema_version = 4, snapshot_json = json_set(snapshot_json, '$.schemaVersion', 4);
    UPDATE action_requests SET result_json = json_set(result_json, '$.snapshot.schemaVersion', 4)
      WHERE json_type(result_json, '$.snapshot') = 'object';
    UPDATE context_reads SET record_json = json_set(record_json, '$.snapshot.schemaVersion', 4);
  `,
}]

export function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version)
    if (version > SCHEMA_VERSION) throw new Error('DATABASE_SCHEMA_TOO_NEW')
    for (const migration of migrations) {
      if (migration.version > version) {
        database.exec(migration.sql)
        database.exec(`PRAGMA user_version = ${migration.version}`)
      }
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
