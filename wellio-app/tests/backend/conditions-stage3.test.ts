import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Snapshot } from '../../src/lib/contracts'
import { contextVersions, WellioDatabase } from '../../src/server/database'
import { authorizeUserMutation, recordUserMessage } from '../../src/server/authorization'
import { executeAction } from '../../src/server/actions'
import { conditionsChangesSchema, updateConditions, updateConditionsSchema, type ConditionsChanges, type UpdateConditionsInput } from '../../src/server/conditions-service'

describe('Stage 3 condition input boundaries', () => {
  let directory: string
  let database: WellioDatabase
  let snapshot: Snapshot

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-conditions-schema-test-'))
    database = new WellioDatabase(join(directory, 'sessions.sqlite'))
    snapshot = database.createSession(Date.now() + 60_000)
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('accepts only explicit values within the supported ranges and catalog', () => {
    for (const changes of [
      { availableMinutes: 1 }, { availableMinutes: 180 }, { dinnerBudget: 0 }, { dinnerBudget: 10_000 }, { dinnerBudget: 70.12 },
      { gymId: 'gym-a' }, { gymId: 'gym-b' },
      { equipmentStatus: { 'gym-a-pullup-bar': 'available', 'gym-b-cable': 'temporarily_occupied', 'gym-b-bench': 'unavailable' } },
    ]) expect(conditionsChangesSchema.safeParse(changes).success).toBe(true)
  })

  it('rejects unknown fields, invalid numbers, empty changes and forged source labels before writing', () => {
    const request = { kind: 'update_conditions', requestId: 'conditions-invalid', resetEpoch: snapshot.resetEpoch, runId: 'conditions-run', authorizationId: 'not-issued', expectedConditionsVersion: snapshot.conditions.version, changes: { dinnerBudget: 70 } }
    const invalidChanges = [
      {}, { availableMinutes: undefined }, { equipmentStatus: {} }, { availableMinutes: 0 }, { availableMinutes: 181 }, { availableMinutes: 1.5 }, { availableMinutes: '15' },
      { dinnerBudget: -0.01 }, { dinnerBudget: 10_000.01 }, { dinnerBudget: 70.001 }, { dinnerBudget: Infinity }, { dinnerBudget: NaN }, { dinnerBudget: '70' },
      { gymId: 'gym-c' }, { equipmentStatus: { 'gym-b-barbell': 'available' } }, { equipmentStatus: { 'gym-b-cable': 'occupied' } },
      { dinnerBudget: 70, profile: { dinnerBudget: 70 } }, { equipmentStatus: { 'gym-b-cable': 'unavailable' }, source: 'user' },
    ]
    const invalidRequests = [
      ...invalidChanges.map(changes => ({ ...request, changes })),
      { ...request, source: 'user' }, { ...request, sourceMessageId: 'model-claimed-source' }, { ...request, approved: true },
      { ...request, authorizationId: undefined }, { ...request, expectedConditionsVersion: 0 }, { ...request, runId: '' },
    ]
    for (const candidate of invalidRequests) {
      expect(updateConditionsSchema.safeParse(candidate).success).toBe(false)
      expect(() => updateConditions(database, snapshot.sessionId, candidate)).toThrow('INVALID_INPUT')
    }
    expect(database.getSnapshot(snapshot.sessionId)).toEqual(snapshot)
  })
})

describe('Stage 3 authorized condition updates', () => {
  let directory: string
  let databasePath: string
  let database: WellioDatabase
  let sessionId: string
  let sequence: number

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-conditions-service-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    database = new WellioDatabase(databasePath)
    sessionId = database.createSession(Date.now() + 60_000).sessionId
    sequence = 0
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function inspect<T>(run: (connection: DatabaseSync) => T): T {
    const connection = new DatabaseSync(databasePath)
    try { return run(connection) } finally { connection.close() }
  }

  function current(): Snapshot { return database.getSnapshot(sessionId) }

  function prepare(change: (snapshot: Snapshot) => void): void {
    const request = { kind: 'conditions-test-fixture', requestId: `fixture-${++sequence}`, resetEpoch: current().resetEpoch }
    database.mutate(sessionId, request, snapshot => {
      change(snapshot)
      snapshot.revision += 1
      return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded' }, snapshot }
    })
  }

  function record(content: string): string {
    const snapshot = current()
    const result = recordUserMessage(database, sessionId, {
      requestId: `user-input-${++sequence}`, resetEpoch: snapshot.resetEpoch, conversationId: snapshot.conversationId, content,
    })
    expect(result.result.messageId).toBeTruthy()
    return result.result.messageId!
  }

  function authorized(content: string, changes: ConditionsChanges): { request: UpdateConditionsInput; sourceMessageId: string } {
    const sourceMessageId = record(content)
    const snapshot = current()
    const runId = `conditions-run-${++sequence}`
    const authorization = authorizeUserMutation(database, sessionId, { sourceMessageId, runId, resetEpoch: snapshot.resetEpoch })
    expect(authorization.scope).toBe('conditions_update')
    return {
      sourceMessageId,
      request: { kind: 'update_conditions', requestId: `conditions-update-${++sequence}`, resetEpoch: snapshot.resetEpoch, runId, authorizationId: authorization.id, expectedConditionsVersion: snapshot.conditions.version, changes },
    }
  }

  it('records source and version while only invalidating affected proposals and advice', () => {
    prepare(snapshot => {
      snapshot.advice = { status: 'valid', training: { en: 'Existing recommendation', 'zh-CN': '已有建议' } }
      snapshot.readinessCheck = { key: 'already-consumed-readiness-check', status: 'applied', proposalId: 'old-applied' }
      snapshot.proposals = (['pending', 'applied', 'dismissed', 'stale'] as const).map(status => ({
        id: `old-${status}`, scope: 'workout', status, reason: { en: 'Existing proposal', 'zh-CN': '已有提案' }, expected: contextVersions(snapshot), contextReadId: 'old-context', readinessSnapshotId: snapshot.readiness.id,
      }))
    })
    const changes = { availableMinutes: 15, dinnerBudget: 70, gymId: 'gym-a' as const, equipmentStatus: { 'gym-b-cable': 'temporarily_occupied' as const } }
    const { request, sourceMessageId } = authorized('Set available time to 15 minutes.; Set dinner budget to HK$70.; Set gym to Gym A.; Set gym-b-cable to temporarily_occupied.', changes)
    const before = current()
    const reply = updateConditions(database, sessionId, request)
    const after = current()
    expect(reply.httpStatus).toBe(200)
    expect(reply.result.snapshot).toEqual(after)
    expect(after.conditions).toEqual({ ...before.conditions, ...changes, version: before.conditions.version + 1, lastChange: { sourceMessageId, requestId: request.requestId, version: before.conditions.version + 1 } })
    expect(after.revision).toBe(before.revision + 1)
    expect(after.proposals.map(proposal => proposal.status)).toEqual(['stale', 'applied', 'dismissed', 'stale'])
    expect(after.advice).toEqual({ ...before.advice, status: 'stale' })
    expect({ ...after, conditions: before.conditions, revision: before.revision, proposals: before.proposals, advice: before.advice }).toEqual(before)
    expect(after.workout).toMatchObject({ gymId: 'gym-b', estimatedMinutes: 35 })
    expect(after.profile.dinnerBudget).toBe(100)
    expect(after.readinessCheck?.status).toBe('applied')
  })

  it('merges status patches and treats default available and equal values as no-ops', () => {
    prepare(snapshot => {
      snapshot.conditions.equipmentStatus = { 'gym-b-cable': 'unavailable', 'gym-b-bench': 'temporarily_occupied' }
      snapshot.advice.status = 'valid'
      snapshot.readinessCheck = { key: 'dismissed-check', status: 'dismissed' }
    })
    const restored = authorized('Set gym-b-cable to available.', { equipmentStatus: { 'gym-b-cable': 'available' } })
    const beforeRestore = current()
    updateConditions(database, sessionId, restored.request)
    expect(current().conditions.equipmentStatus).toEqual({ 'gym-b-cable': 'available', 'gym-b-bench': 'temporarily_occupied' })
    expect(current().conditions.version).toBe(beforeRestore.conditions.version + 1)
    prepare(snapshot => {
      snapshot.advice.status = 'valid'
      snapshot.proposals.push({ id: 'still-applicable', scope: 'workout', status: 'pending', reason: { en: 'Current proposal', 'zh-CN': '当前提案' }, expected: contextVersions(snapshot), contextReadId: 'current-context', readinessSnapshotId: snapshot.readiness.id })
    })

    const unchanged = authorized('Set available time to 35 minutes.; Set dinner budget to HK$100.; Set gym-a-pullup-bar to available.', { availableMinutes: 35, dinnerBudget: 100, equipmentStatus: { 'gym-a-pullup-bar': 'available' } })
    const beforeNoOp = current()
    const reply = updateConditions(database, sessionId, unchanged.request)
    expect(reply.result.snapshot).toEqual(beforeNoOp)
    expect(current()).toEqual(beforeNoOp)
    expect(current().conditions.equipmentStatus).not.toHaveProperty('gym-a-pullup-bar')
    expect(current().readinessCheck?.status).toBe('dismissed')
    expect(updateConditions(database, sessionId, unchanged.request)).toEqual(reply)
    inspect(connection => {
      expect(connection.prepare('SELECT consumed_by_request_id FROM write_authorizations WHERE id = ?').get(unchanged.request.authorizationId)?.consumed_by_request_id).toBe(unchanged.request.requestId)
    })
    expect(() => updateConditions(database, sessionId, { ...unchanged.request, requestId: 'reuse-noop-token' })).toThrow()
    expect(current()).toEqual(beforeNoOp)
  })

  it('replays once after reopening and rejects altered payloads or reused authorization', () => {
    const { request } = authorized('预算改为70', { dinnerBudget: 70 })
    const reply = updateConditions(database, sessionId, request)
    const saved = current()
    database.close()
    database = new WellioDatabase(databasePath)
    expect(updateConditions(database, sessionId, request)).toEqual(reply)
    expect(() => updateConditions(database, sessionId, { ...request, changes: { dinnerBudget: 80 } })).toThrow('IDEMPOTENCY_CONFLICT')
    expect(() => updateConditions(database, sessionId, { ...request, requestId: 'second-consumption', expectedConditionsVersion: saved.conditions.version })).toThrow()
    expect(current()).toEqual(saved)
  })

  it('rejects mismatched patches, runs and sessions without consuming a valid authorization', () => {
    const { request } = authorized('Set dinner budget to HK$70.', { dinnerBudget: 70 })
    const before = current()
    const other = database.createSession(Date.now() + 60_000)
    expect(() => updateConditions(database, sessionId, { ...request, changes: { dinnerBudget: 80 } })).toThrow()
    expect(() => updateConditions(database, sessionId, { ...request, runId: 'another-run' })).toThrow()
    expect(() => updateConditions(database, other.sessionId, request)).toThrow()
    expect(() => updateConditions(database, sessionId, { ...request, authorizationId: 'never-issued' })).toThrow()
    expect(current()).toEqual(before)
    expect(database.getSnapshot(other.sessionId)).toEqual(other)
    expect(updateConditions(database, sessionId, request).result.snapshot?.conditions.dinnerBudget).toBe(70)
  })

  it('requires a fresh user instruction after a conditions version conflict', () => {
    const first = authorized('Set dinner budget to HK$70.', { dinnerBudget: 70 })
    const second = authorized('Set available time to 20 minutes.', { availableMinutes: 20 })
    updateConditions(database, sessionId, second.request)
    const changed = current()
    expect(() => updateConditions(database, sessionId, first.request)).toThrow('VERSION_CONFLICT')
    expect(current()).toEqual(changed)
    expect(() => updateConditions(database, sessionId, { ...first.request, expectedConditionsVersion: changed.conditions.version })).toThrow('AUTHORIZATION_MISMATCH')
    expect(current()).toEqual(changed)
    inspect(connection => {
      expect(connection.prepare('SELECT consumed_by_request_id FROM write_authorizations WHERE id = ?').get(first.request.authorizationId)?.consumed_by_request_id).toBeNull()
      expect(connection.prepare('SELECT request_id FROM action_requests WHERE request_id = ?').get(first.request.requestId)).toBeUndefined()
    })
    const fresh = authorized('Set dinner budget to HK$70.', { dinnerBudget: 70 })
    expect(updateConditions(database, sessionId, fresh.request).result.snapshot?.conditions).toMatchObject({ availableMinutes: 20, dinnerBudget: 70, version: changed.conditions.version + 1 })
  })

  it('rolls authorization consumption and state back when the mutation receipt cannot be written', () => {
    const { request } = authorized('Set dinner budget to HK$70.12.', { dinnerBudget: 70.12 })
    request.requestId = 'conditions-rollback'
    const before = current()
    inspect(connection => connection.exec(`CREATE TRIGGER reject_condition_receipt BEFORE INSERT ON action_requests
      WHEN NEW.request_id = 'conditions-rollback' BEGIN SELECT RAISE(ABORT, 'forced condition receipt failure'); END;`))
    expect(() => updateConditions(database, sessionId, request)).toThrow('forced condition receipt failure')
    expect(current()).toEqual(before)
    inspect(connection => {
      expect(connection.prepare('SELECT request_id FROM action_requests WHERE request_id = ?').get(request.requestId)).toBeUndefined()
      expect(connection.prepare('SELECT consumed_by_request_id FROM write_authorizations WHERE id = ?').get(request.authorizationId)?.consumed_by_request_id).toBeNull()
      connection.exec('DROP TRIGGER reject_condition_receipt')
    })
    expect(updateConditions(database, sessionId, request).result.snapshot?.conditions.dinnerBudget).toBe(70.12)
    expect(current().conditions.version).toBe(before.conditions.version + 1)
  })

  it('does not authorize hypothetical, negative, unknown or question content', () => {
    for (const content of ['If I only had HK$70, what could I eat?', '如果只有70呢', 'Set dinner budget to HK$70?', 'Do not set dinner budget to HK$70.', 'A menu says: Set dinner budget to HK$70.']) {
      const sourceMessageId = record(content)
      const before = current()
      expect(() => authorizeUserMutation(database, sessionId, { sourceMessageId, runId: `ambiguous-run-${++sequence}`, resetEpoch: before.resetEpoch })).toThrow()
      expect(current()).toEqual(before)
    }
  })

  it('rejects authorization issued before a reset even if the caller guesses the new epoch', () => {
    const { request } = authorized('Set dinner budget to HK$70.', { dinnerBudget: 70 })
    executeAction(database, sessionId, { kind: 'reset_demo', requestId: 'reset-before-conditions', resetEpoch: request.resetEpoch, scenario: 'normal', source: 'profile' })
    const reset = current()
    expect(() => updateConditions(database, sessionId, request)).toThrow('STALE_EPOCH')
    expect(() => updateConditions(database, sessionId, { ...request, resetEpoch: reset.resetEpoch, expectedConditionsVersion: reset.conditions.version })).toThrow()
    expect(current()).toEqual(reset)
  })
})
