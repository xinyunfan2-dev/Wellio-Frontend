import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActionRequest, ActionResult, Snapshot } from '../../src/lib/contracts'
import { createFixture } from '../../src/lib/fixtures'
import { executeAction } from '../../src/server/actions'
import { authorizeUserMutation, recordUserMessage } from '../../src/server/authorization'
import { updateConditions } from '../../src/server/conditions-service'
import { contextVersions, WellioDatabase, type ContextRead, type StartContinuation } from '../../src/server/database'
import { mutateMealLog } from '../../src/server/meal-service'
import { SCHEMA_VERSION } from '../../src/server/migrations'
import { SessionCookies } from '../../src/server/session'

// Frozen Stage 2 disk format. Do not build the old database with current migrations.
const V2_SCHEMA_SQL = `
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
    continuation_json TEXT CHECK(continuation_json IS NULL OR json_valid(continuation_json)),
    PRIMARY KEY(session_id, request_id)
  ) STRICT;
  CREATE TABLE context_reads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    reset_epoch INTEGER NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    UNIQUE(session_id, run_id, request_id, reset_epoch)
  ) STRICT;
  PRAGMA user_version = 2;
`

const clearedTables = ['context_reads', 'user_inputs', 'write_authorizations', 'meal_operations', 'meal_entities'] as const

describe('Stage 2 disk database upgrade to the current schema', () => {
  const sessionId = '3d7dd02c-f950-47b8-8385-20513a533e55'
  const signingKey = Buffer.from('73'.repeat(32), 'hex')
  let directory: string
  let databasePath: string
  let database: WellioDatabase | undefined
  let legacy: Snapshot
  let context: ContextRead
  let oldContext: ContextRead
  let applyRequest: ActionRequest
  let localeRequest: ActionRequest
  let applyResult: ActionResult
  let localeResult: ActionResult
  let continuation: StartContinuation
  let cookie: string
  let createdAt: number
  let expiresAt: number
  let actionRows: Record<string, unknown>[]

  function inspect<T>(run: (connection: DatabaseSync) => T): T {
    const connection = new DatabaseSync(databasePath)
    try { return run(connection) } finally { connection.close() }
  }

  function open(): WellioDatabase {
    database = new WellioDatabase(databasePath)
    return database
  }

  function restart(): WellioDatabase {
    database?.close()
    database = undefined
    return open()
  }

  function counts(targetSessionId: string): Record<string, number> {
    return inspect(connection => Object.fromEntries(clearedTables.map(table => [table, Number(connection.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(targetSessionId)?.count)])))
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-v2-upgrade-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    createdAt = Date.now() - 120_000
    expiresAt = Date.now() + 3_600_000
    legacy = createFixture('normal')
    Object.assign(legacy, { schemaVersion: 2, sessionId, conversationId: 'persisted-v2-conversation', resetEpoch: 3, revision: 8, locale: 'zh-CN' })
    legacy.capabilities.persistence = 'server'
    legacy.history.weight.push({ date: '2026-09-12', kg: 70.6 })
    legacy.workout!.version = 2
    legacy.workout!.source = 'agent_proposal'
    legacy.proposals = [{ id: 'legacy-applied-proposal', scope: 'workout', status: 'applied', reason: { en: 'Saved Stage 2 proposal', 'zh-CN': '已保存的阶段二提案' }, expected: { ...contextVersions(legacy), workout: 1 }, contextReadId: 'legacy-pre-apply-context', readinessSnapshotId: legacy.readiness.id, workout: structuredClone(legacy.workout!), runId: 'legacy-proposal-run', resetEpoch: 3 }]
    context = { id: 'legacy-current-context', sessionId, runId: 'legacy-current-run', requestId: 'legacy-current-read', resetEpoch: 3, dayKey: legacy.dayKey, versions: contextVersions(legacy), readinessSnapshotId: legacy.readiness.id, createdAt: new Date(createdAt).toISOString(), snapshot: structuredClone(legacy) }
    oldContext = structuredClone(context)
    Object.assign(oldContext, { id: 'legacy-pre-apply-context', runId: 'legacy-proposal-run', requestId: 'legacy-pre-apply-read' })
    oldContext.snapshot.revision = 7
    oldContext.snapshot.workout!.version = 1
    oldContext.snapshot.proposals[0].status = 'pending'
    oldContext.versions.workout = 1
    applyRequest = { kind: 'apply_proposal', requestId: 'legacy-apply-and-start', resetEpoch: 3, proposalId: 'legacy-applied-proposal', startAfterApply: true, source: 'agent' }
    continuation = { kind: 'start_workout', workoutId: legacy.workout!.id, expectedWorkoutVersion: 2 }
    applyResult = { requestId: applyRequest.requestId, resetEpoch: 3, status: 'succeeded', operationId: 'legacy-apply-operation', applyStatus: 'succeeded', startStatus: 'not_started', snapshot: structuredClone(legacy) }
    localeRequest = { kind: 'set_locale', requestId: 'legacy-locale-action', resetEpoch: 3, locale: 'en', source: 'profile' }
    localeResult = { requestId: localeRequest.requestId, resetEpoch: 3, status: 'succeeded', operationId: 'legacy-locale-operation', snapshot: { ...structuredClone(legacy), revision: 6, locale: 'en' } }
    cookie = new SessionCookies(signingKey).issue(sessionId, expiresAt, false).split(';')[0]

    inspect(connection => {
      connection.exec(V2_SCHEMA_SQL)
      connection.prepare('INSERT INTO server_metadata(key, value) VALUES (?, ?)').run('session_signing_key_v1', signingKey.toString('hex'))
      connection.prepare(`INSERT INTO sessions(id, reset_epoch, revision, schema_version, seed_source, snapshot_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, 3, 8, 2, 'demo_fixture_v1', JSON.stringify(legacy), createdAt, expiresAt)
      const insertRequest = connection.prepare(`INSERT INTO action_requests(session_id, request_id, request_epoch, result_epoch, kind, payload_hash, http_status, result_json, created_at, continuation_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const [request, result, pending] of [[applyRequest, applyResult, continuation], [localeRequest, localeResult, null]] as const) {
        const canonical = JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
        insertRequest.run(sessionId, request.requestId, 3, 3, request.kind, createHash('sha256').update(canonical).digest('hex'), 200, JSON.stringify(result), createdAt, pending ? JSON.stringify(pending) : null)
      }
      for (const record of [context, oldContext]) connection.prepare('INSERT INTO context_reads(id, session_id, run_id, request_id, reset_epoch, record_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(record.id, sessionId, record.runId, record.requestId, record.resetEpoch, JSON.stringify(record))
      expect(connection.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
      for (const table of clearedTables.filter(name => name !== 'context_reads')) expect(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined()
      actionRows = connection.prepare('SELECT * FROM action_requests ORDER BY request_id').all()
    })
  })

  afterEach(() => {
    database?.close()
    database = undefined
    rmSync(directory, { recursive: true, force: true })
  })

  it('preserves existing context snapshots and Apply checkpoints across migration and two restarts', () => {
    let db = open()
    const expected = { ...legacy, schemaVersion: SCHEMA_VERSION }
    const expectedContext = { ...context, snapshot: { ...context.snapshot, schemaVersion: SCHEMA_VERSION } }
    const expectedApply = { ...applyResult, snapshot: { ...applyResult.snapshot!, schemaVersion: SCHEMA_VERSION } }
    for (let reopen = 0; reopen <= 2; reopen += 1) {
      if (reopen > 0) db = restart()
      expect(db.signingKey).toEqual(signingKey)
      expect(new SessionCookies(db.signingKey).read(new Request('http://localhost/api/state', { headers: { cookie } }))).toBe(sessionId)
      expect(db.getSnapshot(sessionId)).toEqual(expected)
      expect(db.getContextRead(sessionId, context.id, context.runId, context.resetEpoch)).toEqual(expectedContext)
      expect(db.captureContext(sessionId, { runId: context.runId, requestId: context.requestId, resetEpoch: context.resetEpoch })).toEqual(expectedContext)
      expect(db.mutate(sessionId, applyRequest, () => { throw new Error('Apply must not execute twice after migration') })).toEqual({ httpStatus: 200, result: expectedApply, continuation })
      inspect(connection => {
        expect(connection.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
        expect(connection.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)).toMatchObject({ schema_version: SCHEMA_VERSION, reset_epoch: 3, revision: 8, created_at: createdAt, expires_at: expiresAt })
        const migrated = connection.prepare('SELECT * FROM action_requests ORDER BY request_id').all()
        expect(migrated).toHaveLength(actionRows.length)
        migrated.forEach((row, index) => {
          const { result_json: beforeJson, ...before } = actionRows[index]
          const { result_json: afterJson, ...after } = row
          expect(after).toEqual(before)
          const result = JSON.parse(String(beforeJson)) as ActionResult
          result.snapshot!.schemaVersion = SCHEMA_VERSION
          expect(JSON.parse(String(afterJson))).toEqual(result)
        })
        const contexts = connection.prepare('SELECT record_json FROM context_reads ORDER BY id').all().map(row => JSON.parse(String(row.record_json)) as ContextRead)
        expect(contexts).toEqual([context, oldContext].sort((a, b) => a.id.localeCompare(b.id)).map(record => ({ ...record, snapshot: { ...record.snapshot, schemaVersion: SCHEMA_VERSION } })))
      })
    }
    const resumed = executeAction(db, sessionId, applyRequest)
    expect(resumed.result).toMatchObject({ status: 'succeeded', operationId: 'legacy-apply-operation', applyStatus: 'succeeded', startStatus: 'succeeded' })
    expect(resumed.result.snapshot?.workout).toMatchObject({ id: legacy.workout!.id, status: 'in_progress', version: 3 })
    expect(resumed.result.snapshot?.revision).toBe(legacy.revision + 1)
    expect(resumed.result.snapshot?.history).toEqual(legacy.history)
    expect(executeAction(db, sessionId, applyRequest)).toEqual(resumed)
    expect(executeAction(db, sessionId, localeRequest).result).toEqual({ ...localeResult, snapshot: { ...localeResult.snapshot!, schemaVersion: SCHEMA_VERSION } })
    expect(db.getSnapshot(sessionId)).toEqual(resumed.result.snapshot)
    inspect(connection => {
      expect(connection.prepare('SELECT continuation_json FROM action_requests WHERE request_id = ?').get(applyRequest.requestId)?.continuation_json).toBeNull()
      expect(connection.prepare('SELECT COUNT(*) AS count FROM action_requests').get()?.count).toBe(2)
    })
  })

  it('uses the new authority and meal tables, then resets only this session’s rows', () => {
    let db = open()
    function writeNewData(targetSessionId: string, prefix: string) {
      const before = db.getSnapshot(targetSessionId)
      const budgetMessage = recordUserMessage(db, targetSessionId, { requestId: `${prefix}-budget-message`, resetEpoch: before.resetEpoch, conversationId: before.conversationId, content: 'Set dinner budget to HK$70.' }).result.messageId!
      const budgetGrant = authorizeUserMutation(db, targetSessionId, { sourceMessageId: budgetMessage, resetEpoch: before.resetEpoch, runId: `${prefix}-budget-run` })
      updateConditions(db, targetSessionId, { kind: 'update_conditions', requestId: `${prefix}-budget-update`, resetEpoch: before.resetEpoch, runId: budgetGrant.runId, authorizationId: budgetGrant.id, expectedConditionsVersion: before.conditions.version, changes: { dinnerBudget: 70 } })
      const meal = db.getSnapshot(targetSessionId).meals.find(item => item.period === 'lunch')!
      const messageId = recordUserMessage(db, targetSessionId, { requestId: `${prefix}-meal-message`, resetEpoch: before.resetEpoch, conversationId: before.conversationId, content: 'I ate half of this item.', targetMealId: meal.id, targetMealItemId: meal.items[0].id }).result.messageId!
      const grant = authorizeUserMutation(db, targetSessionId, { sourceMessageId: messageId, resetEpoch: before.resetEpoch, runId: `${prefix}-meal-run` })
      const request = { kind: 'mutate_meal_log' as const, action: 'update' as const, requestId: `${prefix}-meal-update`, resetEpoch: before.resetEpoch, runId: grant.runId, authorizationId: grant.id, expectedMealRevision: before.mealRevision, expectedMealVersion: meal.version, mealId: meal.id, mealItemId: meal.items[0].id, changes: { consumedFraction: 0.5 } }
      const reply = mutateMealLog(db, targetSessionId, request)
      db.captureContext(targetSessionId, { runId: `${prefix}-fresh-context-run`, requestId: `${prefix}-fresh-context-request`, resetEpoch: before.resetEpoch })
      return { request, reply, messageId, grant }
    }
    const written = writeNewData(sessionId, 'upgraded')
    const source = db.getSnapshot(sessionId)
    const unusedMessageId = recordUserMessage(db, sessionId, { requestId: 'unused-authority-message', resetEpoch: source.resetEpoch, conversationId: source.conversationId, content: 'Set available time to 25 minutes.' }).result.messageId!
    const unusedGrant = authorizeUserMutation(db, sessionId, { sourceMessageId: unusedMessageId, resetEpoch: source.resetEpoch, runId: 'unused-authority-run' })
    const other = db.createSession(Date.now() + 60_000)
    writeNewData(other.sessionId, 'other')
    const beforeRestart = db.getSnapshot(sessionId)
    expect(beforeRestart.conditions.dinnerBudget).toBe(70)
    expect(beforeRestart.meals.find(meal => meal.id === written.request.mealId)?.items[0].consumedFraction).toBe(0.5)
    expect(counts(sessionId)).toEqual({ context_reads: 3, user_inputs: 3, write_authorizations: 3, meal_operations: 1, meal_entities: 1 })
    const otherCounts = counts(other.sessionId)
    const otherSnapshot = db.getSnapshot(other.sessionId)
    inspect(connection => {
      const authorization = connection.prepare('SELECT consumed_by_request_id FROM write_authorizations WHERE id = ?').get(written.grant.id)
      expect(authorization?.consumed_by_request_id).toBe(written.request.requestId)
      expect(connection.prepare('SELECT consumed_by_request_id FROM write_authorizations WHERE id = ?').get(unusedGrant.id)?.consumed_by_request_id).toBeNull()
      const operation = JSON.parse(String(connection.prepare('SELECT record_json FROM meal_operations WHERE id = ?').get(written.reply.result.operationId!)?.record_json))
      expect(operation).toMatchObject({ sessionId, sourceMessageId: written.messageId, requestId: written.request.requestId, status: 'applied', action: 'update' })
    })
    db = restart()
    expect(db.getSnapshot(sessionId)).toEqual(beforeRestart)
    expect(mutateMealLog(db, sessionId, written.request)).toEqual(written.reply)
    expect(counts(sessionId).meal_operations).toBe(1)

    const resetRequest = { kind: 'reset_demo' as const, requestId: 'reset-migrated-session', resetEpoch: beforeRestart.resetEpoch, scenario: 'normal' as const, source: 'profile' as const }
    const reset = executeAction(db, sessionId, resetRequest)
    expect(reset.result.snapshot).toMatchObject({ schemaVersion: SCHEMA_VERSION, sessionId, resetEpoch: beforeRestart.resetEpoch + 1, locale: 'zh-CN' })
    expect(counts(sessionId)).toEqual({ context_reads: 0, user_inputs: 0, write_authorizations: 0, meal_operations: 0, meal_entities: 0 })
    expect(counts(other.sessionId)).toEqual(otherCounts)
    expect(db.getSnapshot(other.sessionId)).toEqual(otherSnapshot)
    expect(executeAction(db, sessionId, resetRequest)).toEqual(reset)
    expect(() => mutateMealLog(db, sessionId, written.request)).toThrow('STALE_EPOCH')
    expect(() => mutateMealLog(db, sessionId, { ...written.request, resetEpoch: reset.result.snapshot!.resetEpoch })).toThrow('IDEMPOTENCY_CONFLICT')
    expect(() => mutateMealLog(db, sessionId, { ...written.request, requestId: 'new-request-with-old-authority', resetEpoch: reset.result.snapshot!.resetEpoch })).toThrow('AUTHORIZATION_INVALID')
    expect(() => authorizeUserMutation(db, sessionId, { sourceMessageId: unusedMessageId, resetEpoch: reset.result.snapshot!.resetEpoch, runId: unusedGrant.runId })).toThrow('AUTHORIZATION_INVALID')
    expect(() => executeAction(db, sessionId, { kind: 'undo_meal', requestId: 'undo-pre-reset-operation', resetEpoch: reset.result.snapshot!.resetEpoch, operationId: written.reply.result.operationId!, source: 'agent' })).toThrow('NOT_FOUND')
    inspect(connection => {
      for (const requestId of [applyRequest.requestId, localeRequest.requestId, written.request.requestId, resetRequest.requestId]) expect(connection.prepare('SELECT request_id FROM action_requests WHERE session_id = ? AND request_id = ?').get(sessionId, requestId)?.request_id).toBe(requestId)
      expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    })
    db = restart()
    expect(db.signingKey).toEqual(signingKey)
    expect(db.getSnapshot(sessionId)).toEqual(reset.result.snapshot)
    expect(counts(sessionId)).toEqual({ context_reads: 0, user_inputs: 0, write_authorizations: 0, meal_operations: 0, meal_entities: 0 })
    expect(counts(other.sessionId)).toEqual(otherCounts)
  })
})
