import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActionResult, Meal, Snapshot } from '../../src/lib/contracts'
import { createFixture } from '../../src/lib/fixtures'
import { executeAction } from '../../src/server/actions'
import { createBackend } from '../../src/server/app'
import { authorizeUserMutation } from '../../src/server/authorization'
import { updateConditions } from '../../src/server/conditions-service'
import { contextVersions, WellioDatabase, type ContextRead } from '../../src/server/database'
import { mutateMealLog, type MutateMealLogInput } from '../../src/server/meal-service'
import { SCHEMA_VERSION } from '../../src/server/migrations'
import type { AuthorizationRecord, MealOperation, UserInputRecord } from '../../src/server/mutation-types'
import type { AgentRun, CheckRecord } from '../../src/server/agent-types'

// Frozen Stage 3 disk schema, independent of the running application's migrations.
const V3_SCHEMA_SQL = `
  CREATE TABLE server_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, reset_epoch INTEGER NOT NULL CHECK(reset_epoch > 0),
    revision INTEGER NOT NULL CHECK(revision > 0), schema_version INTEGER NOT NULL,
    seed_source TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE action_requests (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
    request_epoch INTEGER NOT NULL, result_epoch INTEGER NOT NULL, kind TEXT NOT NULL,
    payload_hash TEXT NOT NULL, http_status INTEGER NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    created_at INTEGER NOT NULL, continuation_json TEXT CHECK(continuation_json IS NULL OR json_valid(continuation_json)),
    PRIMARY KEY(session_id, request_id)
  ) STRICT;
  CREATE TABLE context_reads (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL, request_id TEXT NOT NULL, reset_epoch INTEGER NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(session_id, run_id, request_id, reset_epoch)
  ) STRICT;
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
  PRAGMA user_version = 3;
`

// Stage 3 canonical JSON: independently reconstruct persisted nested payload hashes.
function legacyCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(legacyCanonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${legacyCanonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

describe('Stage 3 disk database upgrade to the current schema', () => {
  const sessionId = 'dc442bbd-75c5-45be-aae8-39055a3a5b14'
  const signingKey = Buffer.from('94'.repeat(32), 'hex')
  const preservedTables = ['user_inputs', 'write_authorizations', 'meal_operations', 'meal_entities'] as const
  let directory: string
  let databasePath: string
  let database: WellioDatabase | undefined
  let legacy: Snapshot
  let context: ContextRead
  let originalMeal: Meal
  let halfMeal: Meal
  let sources: UserInputRecord[]
  let grants: AuthorizationRecord[]
  let operations: MealOperation[]
  let requests: MutateMealLogInput[]
  let receipts: ActionResult[]
  let originalRows: Record<string, Record<string, unknown>[]>
  let cookie: string
  let createdAt: number
  let expiresAt: number

  function inspect<T>(run: (connection: DatabaseSync) => T): T {
    const connection = new DatabaseSync(databasePath)
    try { return run(connection) } finally { connection.close() }
  }

  function open(): WellioDatabase { database = new WellioDatabase(databasePath); return database }
  function restart(): WellioDatabase { database?.close(); database = undefined; return open() }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-v3-upgrade-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    createdAt = Date.now() - 60_000
    expiresAt = Date.now() + 3_600_000
    const base = createFixture('normal')
    Object.assign(base, { schemaVersion: 3, sessionId, conversationId: 'persisted-v3-conversation', resetEpoch: 5, revision: 14, locale: 'zh-CN' })
    base.capabilities.persistence = 'server'
    base.history.weight.push({ date: '2026-09-12', kg: 70.6 })
    originalMeal = structuredClone(base.meals[1])
    halfMeal = { ...structuredClone(originalMeal), version: 2, operationId: 'v3-half-operation' }
    halfMeal.items[0].consumedFraction = 0.5
    sources = [
      { id: 'v3-half-source', sessionId, requestId: 'v3-half-message', resetEpoch: 5, conversationId: base.conversationId, content: 'I ate half of this item.', createdAt: new Date(createdAt).toISOString(), targetMealId: originalMeal.id, targetMealItemId: originalMeal.items[0].id, versions: { meal: 1, conditions: 1 } },
      { id: 'v3-delete-source', sessionId, requestId: 'v3-delete-message', resetEpoch: 5, conversationId: base.conversationId, content: 'Delete this meal.', createdAt: new Date(createdAt + 1).toISOString(), targetMealId: originalMeal.id, versions: { meal: 2, conditions: 1 } },
      { id: 'v3-budget-source', sessionId, requestId: 'v3-budget-message', resetEpoch: 5, conversationId: base.conversationId, content: 'Set dinner budget to HK$70.', createdAt: new Date(createdAt + 2).toISOString(), versions: { meal: 3, conditions: 1 } },
    ]
    const append = (snapshot: Snapshot, source: UserInputRecord) => snapshot.messages.push({ id: source.id, role: 'user', source: 'user', content: source.content, createdAt: source.createdAt, status: 'complete', steps: [] })
    const afterHalf = structuredClone(base)
    append(afterHalf, sources[0]); afterHalf.meals[1] = halfMeal; afterHalf.mealRevision = 2; afterHalf.revision = 16
    const afterDelete = structuredClone(afterHalf)
    append(afterDelete, sources[1]); afterDelete.meals.splice(1, 1); afterDelete.mealRevision = 3; afterDelete.revision = 18
    legacy = structuredClone(afterDelete)
    append(legacy, sources[2]); legacy.revision = 19
    grants = [
      { id: 'v3-half-grant', sessionId, sourceMessageId: sources[0].id, resetEpoch: 5, runId: 'v3-half-run', scope: 'meal_update', constraint: { scope: 'meal_update', mealId: originalMeal.id, mealItemId: originalMeal.items[0].id, changes: { consumedFraction: 0.5 } }, expectedMealRevision: 1, expectedMealVersion: 1, createdAt: sources[0].createdAt },
      { id: 'v3-delete-grant', sessionId, sourceMessageId: sources[1].id, resetEpoch: 5, runId: 'v3-delete-run', scope: 'meal_delete', constraint: { scope: 'meal_delete', mealId: originalMeal.id }, expectedMealRevision: 2, expectedMealVersion: 2, createdAt: sources[1].createdAt },
      { id: 'v3-budget-grant', sessionId, sourceMessageId: sources[2].id, resetEpoch: 5, runId: 'v3-budget-run', scope: 'conditions_update', constraint: { scope: 'conditions_update', changes: { dinnerBudget: 70 } }, expectedConditionsVersion: 1, createdAt: sources[2].createdAt },
    ]
    requests = [
      { kind: 'mutate_meal_log', action: 'update', requestId: 'v3-half-request', resetEpoch: 5, runId: grants[0].runId, authorizationId: grants[0].id, expectedMealRevision: 1, expectedMealVersion: 1, mealId: originalMeal.id, mealItemId: originalMeal.items[0].id, changes: { consumedFraction: 0.5 } },
      { kind: 'mutate_meal_log', action: 'delete', requestId: 'v3-delete-request', resetEpoch: 5, runId: grants[1].runId, authorizationId: grants[1].id, expectedMealRevision: 2, expectedMealVersion: 2, mealId: originalMeal.id },
    ]
    operations = [
      { id: 'v3-half-operation', sessionId, resetEpoch: 5, mealId: originalMeal.id, action: 'update', sourceMessageId: sources[0].id, requestId: requests[0].requestId, before: originalMeal, after: halfMeal, beforeIndex: 1, afterVersion: 2, parentOperationId: null, status: 'applied' },
      { id: 'v3-delete-operation', sessionId, resetEpoch: 5, mealId: originalMeal.id, action: 'delete', sourceMessageId: sources[1].id, requestId: requests[1].requestId, before: halfMeal, after: null, beforeIndex: 1, afterVersion: 3, parentOperationId: 'v3-half-operation', status: 'applied' },
    ]
    receipts = [afterHalf, afterDelete].map((snapshot, index) => ({ requestId: requests[index].requestId, resetEpoch: 5, status: 'succeeded', operationId: operations[index].id, snapshot }))
    context = { id: 'v3-context', sessionId, runId: 'v3-context-run', requestId: 'v3-context-request', resetEpoch: 5, dayKey: legacy.dayKey, versions: contextVersions(legacy), readinessSnapshotId: legacy.readiness.id, createdAt: new Date(createdAt).toISOString(), snapshot: legacy }
    // Construct the original signed browser cookie without opening the current backend.
    const payload = `v1.${sessionId}.${Math.floor(expiresAt / 1000)}`
    cookie = `wellio_session=${payload}.${createHmac('sha256', signingKey).update(payload).digest('base64url')}`
    inspect(connection => {
      connection.exec(V3_SCHEMA_SQL)
      connection.prepare('INSERT INTO server_metadata(key, value) VALUES (?, ?)').run('session_signing_key_v1', signingKey.toString('hex'))
      connection.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sessionId, 5, 19, 3, 'demo_fixture_v1', JSON.stringify(legacy), createdAt, expiresAt)
      for (const source of sources) connection.prepare('INSERT INTO user_inputs VALUES (?, ?, ?, ?, ?)').run(source.id, sessionId, source.requestId, 5, JSON.stringify(source))
      grants.forEach((grant, index) => connection.prepare('INSERT INTO write_authorizations VALUES (?, ?, ?, ?, ?, ?, ?)').run(grant.id, sessionId, 5, grant.sourceMessageId, grant.runId, JSON.stringify(grant), index < 2 ? requests[index].requestId : null))
      for (const operation of operations) connection.prepare('INSERT INTO meal_operations VALUES (?, ?, ?, ?, ?)').run(operation.id, sessionId, 5, originalMeal.id, JSON.stringify(operation))
      connection.prepare('INSERT INTO meal_entities VALUES (?, ?, ?, ?, ?)').run(sessionId, 5, originalMeal.id, 3, operations[1].id)
      requests.forEach((request, index) => connection.prepare('INSERT INTO action_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(sessionId, request.requestId, 5, 5, request.kind, createHash('sha256').update(legacyCanonical(request)).digest('hex'), 200, JSON.stringify(receipts[index]), createdAt, null))
      connection.prepare('INSERT INTO context_reads VALUES (?, ?, ?, ?, ?, ?)').run(context.id, sessionId, context.runId, context.requestId, 5, JSON.stringify(context))
      expect(connection.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
      for (const table of ['agent_runs', 'readiness_checks']) expect(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined()
      originalRows = Object.fromEntries([...preservedTables, 'action_requests'].map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    })
  })

  afterEach(() => { database?.close(); database = undefined; rmSync(directory, { recursive: true, force: true }) })

  it('retains source messages, grants, meal tombstones, receipts and cookie through restart', async () => {
    let db = open()
    const expected = { ...legacy, schemaVersion: SCHEMA_VERSION }
    for (let pass = 0; pass < 2; pass += 1) {
      if (pass) db = restart()
      expect(db.signingKey).toEqual(signingKey)
      expect(db.getSnapshot(sessionId)).toEqual(expected)
      expect(db.getContextRead(sessionId, context.id, context.runId, 5)).toEqual({ ...context, snapshot: expected })
      inspect(connection => {
        expect(connection.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION)
        for (const table of preservedTables) expect(connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(originalRows[table])
        expect(connection.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)).toMatchObject({ reset_epoch: 5, revision: 19, schema_version: SCHEMA_VERSION, created_at: createdAt, expires_at: expiresAt })
        connection.prepare('SELECT * FROM action_requests ORDER BY rowid').all().forEach((row, index) => {
          const { result_json: beforeJson, ...before } = originalRows.action_requests[index]
          const { result_json: afterJson, ...after } = row
          expect(after).toEqual(before)
          const result = JSON.parse(String(beforeJson)) as ActionResult
          result.snapshot!.schemaVersion = SCHEMA_VERSION
          expect(JSON.parse(String(afterJson))).toEqual(result)
        })
      })
      requests.forEach((request, index) => expect(mutateMealLog(db, sessionId, request).result).toEqual({ ...receipts[index], snapshot: { ...receipts[index].snapshot!, schemaVersion: SCHEMA_VERSION } }))
      expect(db.getSnapshot(sessionId)).toEqual(expected)
    }
    db.close(); database = undefined
    const backend = createBackend({ databasePath, cookieSecure: false })
    try {
      const response = await backend.handleRequest(new Request('http://localhost/api/state', { headers: { cookie } }))
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(await response.json()).toEqual(expected)
    } finally { backend.close() }
    db = open()
    expect(authorizeUserMutation(db, sessionId, { sourceMessageId: sources[2].id, resetEpoch: 5, runId: grants[2].runId })).toEqual(grants[2])
    updateConditions(db, sessionId, { kind: 'update_conditions', requestId: 'use-v3-budget-grant', resetEpoch: 5, runId: grants[2].runId, authorizationId: grants[2].id, expectedConditionsVersion: 1, changes: { dinnerBudget: 70 } })
    expect(db.getSnapshot(sessionId).conditions.dinnerBudget).toBe(70)
    const restoredHalf = executeAction(db, sessionId, { kind: 'undo_meal', requestId: 'undo-v3-delete', resetEpoch: 5, operationId: operations[1].id, source: 'agent' })
    expect(restoredHalf.result.snapshot?.meals[1]).toEqual({ ...halfMeal, version: 4 })
    const restoredOriginal = executeAction(db, sessionId, { kind: 'undo_meal', requestId: 'undo-v3-half', resetEpoch: 5, operationId: operations[0].id, source: 'agent' })
    expect(restoredOriginal.result.snapshot?.meals[1]).toEqual({ ...originalMeal, version: 5 })
    expect(restoredOriginal.result.snapshot?.history).toEqual(legacy.history)
  })

  it('supports new lifecycle tables and clears this session’s full ledger on reset', () => {
    let db = open()
    // These completed row fixtures verify migrated table persistence, not SDK execution.
    function insertLifecycleRows(targetSessionId: string, suffix: string) {
      const snapshot = db.getSnapshot(targetSessionId)
      const run: AgentRun = { id: `v4-run-${suffix}`, sessionId: targetSessionId, requestId: `v4-request-${suffix}`, resetEpoch: snapshot.resetEpoch, payloadHash: '0'.repeat(64), request: { requestId: `v4-request-${suffix}`, resetEpoch: snapshot.resetEpoch, conversationId: snapshot.conversationId, message: '', locale: snapshot.locale, attachmentIds: [], source: 'app_open' }, source: 'app_open', messageId: `v4-message-${suffix}`, status: 'completed', leaseExpiresAt: Date.now() - 1, searchUsed: false, toolIds: [], checkKey: `v4-check-${suffix}`, checkAttemptId: `v4-attempt-${suffix}` }
      const check: CheckRecord = { key: run.checkKey!, sessionId: targetSessionId, resetEpoch: snapshot.resetEpoch, status: 'completed', runId: run.id, attemptId: run.checkAttemptId, messageId: run.messageId }
      db.runtimeTransaction(targetSessionId, () => { db.saveAgentRun(run); db.saveReadinessCheck(check); return { value: undefined, changed: false } })
      return { run, check }
    }
    const rows = insertLifecycleRows(sessionId, 'migrated')
    const other = db.createSession(Date.now() + 60_000)
    const otherRows = insertLifecycleRows(other.sessionId, 'other')
    db = restart()
    expect(db.getAgentRun(sessionId, rows.run.id)).toEqual(rows.run)
    expect(db.findAgentRun(sessionId, rows.run.requestId)).toEqual(rows.run)
    expect(db.getReadinessCheck(sessionId, rows.check.key)).toEqual(rows.check)
    const resetRequest = { kind: 'reset_demo' as const, requestId: 'reset-upgraded-v3', resetEpoch: 5, scenario: 'normal' as const, source: 'profile' as const }
    const reset = executeAction(db, sessionId, resetRequest)
    expect(reset.result.snapshot).toMatchObject({ schemaVersion: SCHEMA_VERSION, sessionId, resetEpoch: 6, locale: 'zh-CN' })
    inspect(connection => {
      for (const table of [...preservedTables, 'context_reads', 'agent_runs', 'readiness_checks']) expect(connection.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(sessionId)?.count).toBe(0)
      expect(connection.prepare('SELECT COUNT(*) AS count FROM action_requests WHERE session_id = ?').get(sessionId)?.count).toBe(requests.length + 1)
      expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    })
    expect(db.getAgentRun(other.sessionId, otherRows.run.id)).toEqual(otherRows.run)
    expect(db.getReadinessCheck(other.sessionId, otherRows.check.key)).toEqual(otherRows.check)
    expect(executeAction(db, sessionId, resetRequest)).toEqual(reset)
    expect(() => authorizeUserMutation(db, sessionId, { sourceMessageId: sources[2].id, resetEpoch: 6, runId: grants[2].runId })).toThrow('AUTHORIZATION_INVALID')
    expect(() => executeAction(db, sessionId, { kind: 'undo_meal', requestId: 'cannot-undo-v3-after-reset', resetEpoch: 6, operationId: operations[1].id, source: 'agent' })).toThrow('NOT_FOUND')
    db = restart()
    expect(db.getSnapshot(sessionId)).toEqual(reset.result.snapshot)
    expect(db.listAgentRuns(sessionId)).toEqual([])
    expect(db.getReadinessCheck(sessionId, rows.check.key)).toBeUndefined()
    expect(db.getAgentRun(other.sessionId, otherRows.run.id)).toEqual(otherRows.run)
  })
})
