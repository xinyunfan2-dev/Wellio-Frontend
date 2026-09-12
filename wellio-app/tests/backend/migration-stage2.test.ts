import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActionRequest, ActionResult, Snapshot } from '../../src/lib/contracts'
import { createFixture } from '../../src/lib/fixtures'
import { createBackend } from '../../src/server/app'
import { WellioDatabase } from '../../src/server/database'
import { SCHEMA_VERSION } from '../../src/server/migrations'
import { SessionCookies } from '../../src/server/session'

// Frozen Stage 1 disk format: deliberately independent from the active migrations.
const V1_SCHEMA_SQL = `
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
  PRAGMA user_version = 1;
`

type Closable = { close(): void }
type Backend = ReturnType<typeof createBackend>

describe('Stage 1 disk database upgrade to the current schema', () => {
  const signingKey = Buffer.from('42'.repeat(32), 'hex')
  const sessionId = '6ef908b1-6829-430a-ad63-3f85034320ea'
  const opened = new Set<Closable>()
  let directory: string
  let databasePath: string
  let cookie: string
  let legacy: Snapshot
  let priorSnapshot: Snapshot
  let priorRequest: ActionRequest
  let failedRequest: ActionRequest
  let priorResult: ActionResult
  let failedResult: ActionResult
  let expiresAt: number
  let createdAt: number
  let legacyRequestRows: Record<string, unknown>[]

  function track<T extends Closable>(instance: T): T {
    opened.add(instance)
    return instance
  }

  function close(instance: Closable): void {
    instance.close()
    opened.delete(instance)
  }

  function inspect<T>(run: (connection: DatabaseSync) => T): T {
    const connection = new DatabaseSync(databasePath)
    try { return run(connection) } finally { connection.close() }
  }

  async function state(backend: Backend): Promise<Snapshot> {
    const response = await backend.handleRequest(new Request('http://localhost/api/state', { headers: { cookie } }))
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-wellio-schema-version')).toBe(String(SCHEMA_VERSION))
    return await response.json() as Snapshot
  }

  async function replay(backend: Backend, request: ActionRequest, httpStatus: number): Promise<ActionResult> {
    const response = await backend.handleRequest(new Request('http://localhost/api/actions', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(request),
    }))
    expect(response.status).toBe(httpStatus)
    expect(response.headers.get('set-cookie')).toBeNull()
    return await response.json() as ActionResult
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-v1-upgrade-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    createdAt = Date.now() - 60_000
    expiresAt = Date.now() + 3_600_000
    legacy = createFixture('low_recovery')
    Object.assign(legacy, { schemaVersion: 1, sessionId, conversationId: 'persisted-v1-conversation', resetEpoch: 4, revision: 12, locale: 'zh-CN' })
    legacy.capabilities.persistence = 'server'
    // Distinguish this persisted history from a freshly generated fixture.
    legacy.history.weight.push({ date: '2026-09-12', kg: 70.6 })
    priorSnapshot = structuredClone(legacy)
    priorSnapshot.locale = 'en'
    priorSnapshot.revision = 11
    priorRequest = { kind: 'set_locale', locale: 'en', requestId: 'legacy-language-action', resetEpoch: 4, source: 'profile' }
    failedRequest = { kind: 'undo_meal', operationId: 'legacy-missing-operation', requestId: 'legacy-failed-action', resetEpoch: 4, source: 'agent' }
    priorResult = { requestId: priorRequest.requestId, resetEpoch: 4, status: 'succeeded', operationId: 'persisted-v1-operation', snapshot: priorSnapshot }
    failedResult = { requestId: failedRequest.requestId, resetEpoch: 4, status: 'failed', errorCode: 'ACTION_NOT_AVAILABLE' }
    cookie = new SessionCookies(signingKey).issue(sessionId, expiresAt, false).split(';')[0]

    inspect(connection => {
      connection.exec(V1_SCHEMA_SQL)
      connection.prepare('INSERT INTO server_metadata(key, value) VALUES (?, ?)').run('session_signing_key_v1', signingKey.toString('hex'))
      connection.prepare(`INSERT INTO sessions(id, reset_epoch, revision, schema_version, seed_source, snapshot_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, 4, 12, 1, 'demo_fixture_v1', JSON.stringify(legacy), createdAt, expiresAt)
      const insert = connection.prepare(`INSERT INTO action_requests(session_id, request_id, request_epoch, result_epoch, kind, payload_hash, http_status, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const [request, result, status] of [[priorRequest, priorResult, 200], [failedRequest, failedResult, 501]] as const) {
        // V1 canonical payload hash, computed from these flat envelopes independently.
        const canonical = JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
        insert.run(sessionId, request.requestId, request.resetEpoch, 4, request.kind, createHash('sha256').update(canonical).digest('hex'), status, JSON.stringify(result), createdAt)
      }
      expect(connection.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
      expect(connection.prepare('PRAGMA table_info(action_requests)').all().map(row => row.name)).not.toContain('continuation_json')
      expect(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_reads'").get()).toBeUndefined()
      legacyRequestRows = connection.prepare('SELECT * FROM action_requests ORDER BY request_id').all()
    })
  })

  afterEach(() => {
    for (const instance of opened) instance.close()
    opened.clear()
    rmSync(directory, { recursive: true, force: true })
  })

  it('preserves the existing cookie, state and exact request receipts through migration and another restart', async () => {
    let backend = track(createBackend({ databasePath, cookieSecure: false }))
    const upgraded = { ...legacy, schemaVersion: SCHEMA_VERSION }
    const upgradedPriorResult = { ...priorResult, snapshot: { ...priorSnapshot, schemaVersion: SCHEMA_VERSION } }
    expect(await state(backend)).toEqual(upgraded)

    inspect(connection => {
      expect(connection.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
      expect(connection.prepare('SELECT value FROM server_metadata WHERE key = ?').get('session_signing_key_v1')?.value).toBe(signingKey.toString('hex'))
      expect(connection.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(1)
      const row = connection.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)!
      expect(row).toMatchObject({ id: sessionId, schema_version: SCHEMA_VERSION, reset_epoch: 4, revision: 12, seed_source: 'demo_fixture_v1', created_at: createdAt, expires_at: expiresAt })
      expect(JSON.parse(String(row.snapshot_json))).toEqual(upgraded)
      const rows = connection.prepare('SELECT * FROM action_requests ORDER BY request_id').all()
      expect(rows).toHaveLength(legacyRequestRows.length)
      rows.forEach((row, index) => {
        const { result_json: oldResult, ...oldMetadata } = legacyRequestRows[index]
        const { result_json: newResult, continuation_json, ...metadata } = row
        expect(metadata).toEqual(oldMetadata)
        expect(continuation_json).toBeNull()
        const expected = JSON.parse(String(oldResult)) as ActionResult
        if (expected.snapshot) expected.snapshot.schemaVersion = SCHEMA_VERSION
        expect(JSON.parse(String(newResult))).toEqual(expected)
      })
    })

    expect(await replay(backend, priorRequest, 200)).toEqual(upgradedPriorResult)
    expect(await replay(backend, failedRequest, 501)).toEqual(failedResult)
    // Replaying revision 11 must not roll the current language/revision back from 12.
    expect(await state(backend)).toEqual(upgraded)
    close(backend)
    backend = track(createBackend({ databasePath, cookieSecure: false }))
    expect(await state(backend)).toEqual(upgraded)
    expect(await replay(backend, priorRequest, 200)).toEqual(upgradedPriorResult)
    expect(await replay(backend, failedRequest, 501)).toEqual(failedResult)
    expect(await state(backend)).toEqual(upgraded)
  })

  it('persists context reads and continuation checkpoints using the newly migrated schema', () => {
    let database = track(new WellioDatabase(databasePath))
    expect(database.signingKey).toEqual(signingKey)
    const contextInput = { runId: 'post-upgrade-run', requestId: 'post-upgrade-context', resetEpoch: legacy.resetEpoch }
    const context = database.captureContext(sessionId, contextInput)
    expect(context.snapshot).toEqual({ ...legacy, schemaVersion: SCHEMA_VERSION })
    expect(database.captureContext(sessionId, contextInput)).toEqual(context)
    const request = { kind: 'migration-continuation-probe', requestId: 'post-upgrade-checkpoint', resetEpoch: legacy.resetEpoch }
    const continuation = { kind: 'start_workout' as const, workoutId: legacy.workout!.id, expectedWorkoutVersion: legacy.workout!.version }
    const checkpoint = database.mutate(sessionId, request, () => ({
      httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded' }, continuation,
    }))
    expect(checkpoint.continuation).toEqual(continuation)
    inspect(connection => {
      const row = connection.prepare('SELECT * FROM context_reads WHERE id = ?').get(context.id)!
      expect(row).toMatchObject({ session_id: sessionId, run_id: contextInput.runId, request_id: contextInput.requestId, reset_epoch: legacy.resetEpoch })
      expect(JSON.parse(String(row.record_json))).toEqual(context)
      expect(JSON.parse(String(connection.prepare('SELECT continuation_json FROM action_requests WHERE request_id = ?').get(request.requestId)?.continuation_json))).toEqual(continuation)
      expect(connection.prepare('SELECT COUNT(*) AS count FROM context_reads').get()?.count).toBe(1)
    })

    close(database)
    database = track(new WellioDatabase(databasePath))
    expect(database.getContextRead(sessionId, context.id, contextInput.runId, legacy.resetEpoch)).toEqual(context)
    expect(database.mutate(sessionId, request, () => { throw new Error('checkpoint must replay without executing again') })).toEqual(checkpoint)
    const completed = database.resumeMutation(sessionId, request, (_snapshot, savedContinuation, result) => {
      expect(savedContinuation).toEqual(continuation)
      return { httpStatus: 200, result: { ...result, operationId: 'post-upgrade-continuation-complete' } }
    })
    expect(completed).not.toHaveProperty('continuation')
    expect(database.resumeMutation(sessionId, request, () => { throw new Error('completed continuation must not execute twice') })).toEqual(completed)
    expect(database.getSnapshot(sessionId)).toEqual({ ...legacy, schemaVersion: SCHEMA_VERSION })
    inspect(connection => {
      const row = connection.prepare('SELECT continuation_json, result_json FROM action_requests WHERE request_id = ?').get(request.requestId)!
      expect(row.continuation_json).toBeNull()
      expect(JSON.parse(String(row.result_json))).toEqual(completed.result)
    })
  })
})
