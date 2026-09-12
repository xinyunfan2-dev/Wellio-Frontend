import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { ActionResult, ContextVersions, Proposal, Snapshot } from '../lib/contracts'
import { BackendError } from './errors'
import { migrate, SCHEMA_VERSION } from './migrations'
import { createSeed, SEED_SOURCE } from './seed'
import { canonicalJson } from './validation'
import type { AuthorizationRecord, MealEntity, MealOperation, MutationConstraint, UserInputRecord } from './mutation-types'
import type { AgentRun, CheckRecord } from './agent-types'

export interface MutationRequest { kind: string; requestId: string; resetEpoch: number }
export interface StartContinuation { kind: 'start_workout'; workoutId: string; expectedWorkoutVersion: number }
export interface ContextRead { id: string; sessionId: string; runId: string; requestId: string; resetEpoch: number; dayKey: string; versions: ContextVersions; readinessSnapshotId: string; createdAt: string; snapshot: Snapshot }
export interface StoredReply { httpStatus: number; result: ActionResult; continuation?: StartContinuation }
export interface MutationOutcome extends StoredReply { snapshot?: Snapshot }
type SessionRow = { snapshot_json: string; reset_epoch: number; revision: number; expires_at: number; schema_version: number }
type RequestRow = { payload_hash: string; kind: string; request_epoch: number; result_epoch: number; http_status: number; result_json: string; continuation_json: string | null }

export function contextVersions(snapshot: Snapshot): ContextVersions {
  return { meal: snapshot.mealRevision, plan: snapshot.plan.version, workout: snapshot.workout?.version ?? 0, conditions: snapshot.conditions.version, readiness: snapshot.readiness.version }
}

export function assertContextVersions(snapshot: Snapshot, expected: Partial<ContextVersions>): void {
  const current = contextVersions(snapshot)
  for (const key of Object.keys(expected) as (keyof ContextVersions)[]) {
    if (expected[key] !== current[key]) throw new BackendError('VERSION_CONFLICT', 409)
  }
}

export class WellioDatabase {
  private database: DatabaseSync
  private inTransaction = false
  private agentTool?: { runId: string; toolCallId: string; now: number }
  readonly signingKey: Buffer

  constructor(databasePath: string) {
    if (!databasePath || databasePath === ':memory:' || databasePath.startsWith('file:')) throw new Error('PERSISTENT_DATABASE_PATH_REQUIRED')
    const path = resolve(databasePath)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    closeSync(openSync(path, 'a', 0o600))
    chmodSync(path, 0o600)
    this.database = new DatabaseSync(path)
    try {
      this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
      migrate(this.database)
      this.database.prepare('INSERT OR IGNORE INTO server_metadata(key, value) VALUES (?, ?)').run('session_signing_key_v1', randomBytes(32).toString('hex'))
      const key = this.database.prepare('SELECT value FROM server_metadata WHERE key = ?').get('session_signing_key_v1')?.value
      if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw new Error('INVALID_SESSION_SIGNING_KEY')
      this.signingKey = Buffer.from(key, 'hex')
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  close(): void { this.database.close() }

  /** Synchronous transaction: provider/network work must finish before entering. */
  private transaction<T>(run: () => T): T {
    if (this.inTransaction) throw new Error('NESTED_TRANSACTION_NOT_ALLOWED')
    this.database.exec('BEGIN IMMEDIATE')
    this.inTransaction = true
    try {
      const result = run()
      if (result instanceof Promise) throw new Error('ASYNC_TRANSACTION_NOT_ALLOWED')
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  createSession(expiresAt: number): Snapshot {
    const snapshot = createSeed(randomUUID())
    this.database.prepare(`INSERT INTO sessions(id, reset_epoch, revision, schema_version, seed_source, snapshot_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(snapshot.sessionId, snapshot.resetEpoch, snapshot.revision, SCHEMA_VERSION, SEED_SOURCE, JSON.stringify(snapshot), Date.now(), expiresAt)
    return snapshot
  }

  getSnapshot(sessionId: string): Snapshot {
    const row = this.database.prepare('SELECT snapshot_json, reset_epoch, revision, expires_at, schema_version FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined
    if (!row || row.expires_at <= Date.now()) throw new BackendError('INVALID_SESSION', 401)
    if (row.schema_version !== SCHEMA_VERSION) throw new Error('SNAPSHOT_SCHEMA_UNSUPPORTED')
    const snapshot = JSON.parse(row.snapshot_json) as Snapshot
    if (snapshot.schemaVersion !== row.schema_version || snapshot.sessionId !== sessionId || snapshot.resetEpoch !== row.reset_epoch || snapshot.revision !== row.revision) throw new Error('CORRUPT_SESSION_STATE')
    return snapshot
  }

  /** Shared mutation boundary for later workout/meal services and authenticated tools. */
  mutate(sessionId: string, request: MutationRequest, execute: (snapshot: Snapshot) => MutationOutcome): StoredReply {
    return this.transaction(() => {
      const current = this.getSnapshot(sessionId)
      const hash = createHash('sha256').update(canonicalJson(request)).digest('hex')
      const previous = this.database.prepare('SELECT * FROM action_requests WHERE session_id = ? AND request_id = ?').get(sessionId, request.requestId) as RequestRow | undefined
      // Only the most recent successful reset may replay across its own epoch boundary.
      const resetReplay = previous?.kind === 'reset_demo' && previous.http_status === 200 && previous.result_epoch === current.resetEpoch && previous.request_epoch === request.resetEpoch
      if (request.resetEpoch !== current.resetEpoch && !resetReplay) throw new BackendError('STALE_EPOCH', 409)
      if (previous) {
        if (previous.payload_hash !== hash) throw new BackendError('IDEMPOTENCY_CONFLICT', 409)
        return this.reply(previous)
      }
      const reserved = this.findAgentRun(sessionId, request.requestId)
      if (reserved?.source === 'ui_proposal' && canonicalJson(reserved.actionRequest) !== canonicalJson(request)) throw new BackendError('IDEMPOTENCY_CONFLICT', 409)
      const outcome = execute(structuredClone(current))
      if (outcome instanceof Promise) throw new Error('ASYNC_MUTATION_NOT_ALLOWED')
      this.bindAgentMutation(current, request, outcome)
      this.saveSnapshot(current, request, outcome.snapshot)
      const result = this.result(current, request, outcome)
      this.database.prepare(`INSERT INTO action_requests(session_id, request_id, request_epoch, result_epoch, kind, payload_hash, http_status, result_json, created_at, continuation_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, request.requestId, request.resetEpoch, outcome.snapshot?.resetEpoch ?? current.resetEpoch, request.kind, hash, outcome.httpStatus, JSON.stringify(result), Date.now(), outcome.continuation ? JSON.stringify(outcome.continuation) : null)
      if (request.kind === 'reset_demo' && outcome.snapshot) {
        for (const table of ['context_reads', 'write_authorizations', 'meal_operations', 'meal_entities', 'agent_runs', 'readiness_checks', 'user_inputs']) {
          this.database.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
        }
      }
      return { httpStatus: outcome.httpStatus, result, ...(outcome.continuation ? { continuation: outcome.continuation } : {}) }
    })
  }

  /** Read an Action receipt before starting expensive or stateful asynchronous work. */
  getMutationReply(sessionId: string, request: MutationRequest): StoredReply | undefined {
    const current = this.getSnapshot(sessionId)
    const previous = this.database.prepare('SELECT * FROM action_requests WHERE session_id = ? AND request_id = ?').get(sessionId, request.requestId) as RequestRow | undefined
    const resetReplay = previous?.kind === 'reset_demo' && previous.http_status === 200 && previous.result_epoch === current.resetEpoch && previous.request_epoch === request.resetEpoch
    if (request.resetEpoch !== current.resetEpoch && !resetReplay) throw new BackendError('STALE_EPOCH', 409)
    if (!previous) return undefined
    const hash = createHash('sha256').update(canonicalJson(request)).digest('hex')
    if (previous.payload_hash !== hash) throw new BackendError('IDEMPOTENCY_CONFLICT', 409)
    return this.reply(previous)
  }

  /** Complete an already committed Apply checkpoint. No candidate is applied here. */
  resumeMutation(sessionId: string, request: MutationRequest, execute: (snapshot: Snapshot, continuation: StartContinuation, result: ActionResult) => MutationOutcome): StoredReply {
    return this.transaction(() => {
      const current = this.getSnapshot(sessionId)
      if (current.resetEpoch !== request.resetEpoch) throw new BackendError('STALE_EPOCH', 409)
      const previous = this.database.prepare('SELECT * FROM action_requests WHERE session_id = ? AND request_id = ?').get(sessionId, request.requestId) as RequestRow | undefined
      if (!previous) throw new BackendError('NOT_FOUND', 404)
      const hash = createHash('sha256').update(canonicalJson(request)).digest('hex')
      if (previous.payload_hash !== hash) throw new BackendError('IDEMPOTENCY_CONFLICT', 409)
      const reply = this.reply(previous)
      if (!reply.continuation) return reply
      const outcome = execute(structuredClone(current), reply.continuation, reply.result)
      if (outcome instanceof Promise) throw new Error('ASYNC_MUTATION_NOT_ALLOWED')
      this.saveSnapshot(current, request, outcome.snapshot)
      const result = this.result(current, request, outcome)
      this.database.prepare('UPDATE action_requests SET result_json = ?, http_status = ?, result_epoch = ?, continuation_json = NULL WHERE session_id = ? AND request_id = ?')
        .run(JSON.stringify(result), outcome.httpStatus, current.resetEpoch, sessionId, request.requestId)
      return { httpStatus: outcome.httpStatus, result }
    })
  }

  captureContext(sessionId: string, input: { runId: string; requestId: string; resetEpoch: number }): ContextRead {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.runId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || !Number.isSafeInteger(input.resetEpoch)) throw new BackendError('INVALID_INPUT', 400)
    return this.transaction(() => {
      const snapshot = this.getSnapshot(sessionId)
      if (snapshot.resetEpoch !== input.resetEpoch) throw new BackendError('STALE_EPOCH', 409)
      const previous = this.database.prepare('SELECT record_json FROM context_reads WHERE session_id = ? AND run_id = ? AND request_id = ? AND reset_epoch = ?')
        .get(sessionId, input.runId, input.requestId, input.resetEpoch)
      if (previous) return JSON.parse(String(previous.record_json)) as ContextRead
      const record: ContextRead = { id: randomUUID(), sessionId, runId: input.runId, requestId: input.requestId, resetEpoch: snapshot.resetEpoch, dayKey: snapshot.dayKey, versions: contextVersions(snapshot), readinessSnapshotId: snapshot.readiness.id, createdAt: new Date().toISOString(), snapshot }
      this.database.prepare('INSERT INTO context_reads(id, session_id, run_id, request_id, reset_epoch, record_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(record.id, sessionId, input.runId, input.requestId, input.resetEpoch, JSON.stringify(record))
      return record
    })
  }

  getContextRead(sessionId: string, contextReadId: string, runId: string, resetEpoch: number): ContextRead {
    const current = this.getSnapshot(sessionId)
    if (current.resetEpoch !== resetEpoch) throw new BackendError('STALE_EPOCH', 409)
    const row = this.database.prepare('SELECT record_json FROM context_reads WHERE id = ? AND session_id = ? AND run_id = ? AND reset_epoch = ?').get(contextReadId, sessionId, runId, resetEpoch)
    if (!row) throw new BackendError('CONTEXT_READ_INVALID', 409)
    const record = JSON.parse(String(row.record_json)) as ContextRead
    if (record.dayKey !== current.dayKey || record.readinessSnapshotId !== current.readiness.id) throw new BackendError('CONTEXT_STALE', 409)
    assertContextVersions(current, record.versions)
    return record
  }

  /** Internal row writers must share the snapshot/receipt transaction. Never expose as tools. */
  private requireTransaction(): void {
    if (!this.inTransaction) throw new Error('MUTATION_TRANSACTION_REQUIRED')
  }

  /** Internal synchronous lifecycle transaction; no networking or arbitrary HTTP access. */
  runtimeTransaction<T>(sessionId: string, execute: (snapshot: Snapshot) => { value: T; changed: boolean }): T {
    return this.transaction(() => {
      const current = this.getSnapshot(sessionId)
      const snapshot = structuredClone(current)
      const result = execute(snapshot)
      if (result instanceof Promise) throw new Error('ASYNC_TRANSACTION_NOT_ALLOWED')
      if (result.changed) {
        snapshot.revision = current.revision + 1
        this.saveSnapshot(current, { kind: 'runtime_state', requestId: 'runtime-state', resetEpoch: current.resetEpoch }, snapshot)
      }
      return result.value
    })
  }

  getAgentRun(sessionId: string, runId: string): AgentRun | undefined {
    const row = this.database.prepare('SELECT record_json FROM agent_runs WHERE id = ? AND session_id = ?').get(runId, sessionId)
    return row ? JSON.parse(String(row.record_json)) as AgentRun : undefined
  }

  findAgentRun(sessionId: string, requestId: string): AgentRun | undefined {
    const row = this.database.prepare('SELECT record_json FROM agent_runs WHERE session_id = ? AND request_id = ?').get(sessionId, requestId)
    return row ? JSON.parse(String(row.record_json)) as AgentRun : undefined
  }

  listAgentRuns(sessionId: string): AgentRun[] {
    return this.database.prepare('SELECT record_json FROM agent_runs WHERE session_id = ?').all(sessionId).map(row => JSON.parse(String(row.record_json)) as AgentRun)
  }

  saveAgentRun(run: AgentRun): void {
    this.requireTransaction()
    this.database.prepare(`INSERT INTO agent_runs(id, session_id, request_id, reset_epoch, record_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json`).run(run.id, run.sessionId, run.requestId, run.resetEpoch, JSON.stringify(run))
  }

  getReadinessCheck(sessionId: string, key: string): CheckRecord | undefined {
    const row = this.database.prepare('SELECT record_json FROM readiness_checks WHERE check_key = ? AND session_id = ?').get(key, sessionId)
    return row ? JSON.parse(String(row.record_json)) as CheckRecord : undefined
  }

  saveReadinessCheck(check: CheckRecord): void {
    this.requireTransaction()
    this.database.prepare(`INSERT INTO readiness_checks(check_key, session_id, reset_epoch, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(check_key) DO UPDATE SET record_json = excluded.record_json`).run(check.key, check.sessionId, check.resetEpoch, JSON.stringify(check))
  }

  getUserInput(sessionId: string, epoch: number, id: string): UserInputRecord | undefined {
    const row = this.database.prepare('SELECT record_json FROM user_inputs WHERE id = ? AND session_id = ? AND reset_epoch = ?').get(id, sessionId, epoch)
    return row ? JSON.parse(String(row.record_json)) as UserInputRecord : undefined
  }

  listUserInputs(sessionId: string, epoch: number): UserInputRecord[] {
    return this.database.prepare('SELECT record_json FROM user_inputs WHERE session_id = ? AND reset_epoch = ? ORDER BY rowid DESC LIMIT 100').all(sessionId, epoch).map(row => JSON.parse(String(row.record_json)) as UserInputRecord)
  }

  withAgentTool<T>(context: { runId: string; toolCallId: string; now: number }, execute: () => T): T {
    const previous = this.agentTool
    this.agentTool = context
    try {
      const result = execute()
      if (result instanceof Promise) throw new Error('ASYNC_MUTATION_NOT_ALLOWED')
      return result
    } finally { this.agentTool = previous }
  }

  private bindAgentMutation(current: Snapshot, request: MutationRequest, outcome: MutationOutcome): void {
    if (!this.agentTool) return
    const run = this.getAgentRun(current.sessionId, this.agentTool.runId)
    if (!run || run.status !== 'pending' || run.resetEpoch !== current.resetEpoch || run.leaseExpiresAt <= this.agentTool.now) throw new BackendError('RUN_NOT_ACTIVE', 409)
    if (['undo_meal', 'start_workout', 'complete_exercise', 'undo_exercise', 'finish_workout'].includes(request.kind) && outcome.result.status === 'succeeded') {
      if (run.intentConsumedBy && run.intentConsumedBy !== this.agentTool.toolCallId) throw new BackendError('AUTHORIZATION_CONSUMED', 409)
      run.intentConsumedBy = this.agentTool.toolCallId
      this.saveAgentRun(run)
    }
    const snapshot = outcome.snapshot ?? structuredClone(current)
    if (!outcome.snapshot) snapshot.revision += 1
    const message = snapshot.messages.find(message => message.id === run.messageId)
    if (!message) throw new BackendError('RUN_NOT_ACTIVE', 409)
    const step = message.steps.find(step => step.toolCallId === this.agentTool!.toolCallId)
    if (step) {
      step.status = outcome.result.status === 'succeeded' ? 'succeeded' : outcome.result.status === 'needs_input' ? 'awaiting_user' : 'failed'
      if (outcome.result.errorCode) step.errorCode = outcome.result.errorCode
    }
    if (outcome.result.status === 'succeeded' && outcome.result.operationId && ['mutate_meal_log', 'undo_meal'].includes(request.kind)) {
      const operation = this.getMealOperation(current.sessionId, current.resetEpoch, outcome.result.operationId)
      if (operation) { message.operationId = operation.id; message.mealId = operation.mealId }
    }
    if (outcome.result.status === 'succeeded' && outcome.result.proposalId) {
      const proposal = snapshot.proposals.find(proposal => proposal.id === outcome.result.proposalId)
      if (proposal) {
        message.proposalId = proposal.id
        proposal.messageId = message.id
        run.proposalId = proposal.id
        if (run.checkKey && run.checkAttemptId) {
          proposal.checkKey = run.checkKey; proposal.checkAttemptId = run.checkAttemptId
          const check = this.getReadinessCheck(current.sessionId, run.checkKey)
          if (check?.attemptId === run.checkAttemptId) {
            check.proposalId = proposal.id
            this.saveReadinessCheck(check)
            if (snapshot.readinessCheck?.key === check.key) snapshot.readinessCheck.proposalId = proposal.id
          }
        }
        this.saveAgentRun(run)
      }
    }
    outcome.snapshot = snapshot
  }

  consumeReadinessCheck(snapshot: Snapshot, proposal: Proposal, status: 'applied' | 'dismissed'): void {
    this.requireTransaction()
    if (!proposal.checkKey || !proposal.checkAttemptId) return
    const check = this.getReadinessCheck(snapshot.sessionId, proposal.checkKey)
    if (!check || check.resetEpoch !== snapshot.resetEpoch || check.attemptId !== proposal.checkAttemptId || check.proposalId !== proposal.id) return
    check.status = status
    this.saveReadinessCheck(check)
    if (snapshot.readinessCheck?.key === check.key) snapshot.readinessCheck = { ...snapshot.readinessCheck, status }
  }

  storeUserInput(record: UserInputRecord): void {
    this.requireTransaction()
    this.database.prepare('INSERT INTO user_inputs(id, session_id, request_id, reset_epoch, record_json) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, record.sessionId, record.requestId, record.resetEpoch, JSON.stringify(record))
  }

  issueAuthorization(sessionId: string, input: { sourceMessageId: string; resetEpoch: number; runId: string }, derive: (snapshot: Snapshot, source: UserInputRecord) => MutationConstraint): AuthorizationRecord {
    return this.transaction(() => {
      const snapshot = this.getSnapshot(sessionId)
      if (snapshot.resetEpoch !== input.resetEpoch) throw new BackendError('STALE_EPOCH', 409)
      const sourceRow = this.database.prepare('SELECT record_json FROM user_inputs WHERE id = ? AND session_id = ? AND reset_epoch = ?').get(input.sourceMessageId, sessionId, input.resetEpoch)
      if (!sourceRow) throw new BackendError('AUTHORIZATION_INVALID', 403)
      const source = JSON.parse(String(sourceRow.record_json)) as UserInputRecord
      if (source.conversationId !== snapshot.conversationId) throw new BackendError('AUTHORIZATION_INVALID', 403)
      this.assertSourceVersions(source)
      const previous = this.database.prepare('SELECT record_json FROM write_authorizations WHERE session_id = ? AND reset_epoch = ? AND source_message_id = ?').get(sessionId, input.resetEpoch, input.sourceMessageId)
      if (previous) {
        const record = JSON.parse(String(previous.record_json)) as AuthorizationRecord
        this.assertAuthorizationSource(record, source)
        if (record.runId !== input.runId) throw new BackendError('AUTHORIZATION_RUN_MISMATCH', 403)
        return record
      }
      const constraint = derive(snapshot, source)
      // A delayed old message cannot acquire today's versions or silently retarget a new same-name food.
      if (constraint.scope === 'conditions_update' ? source.versions.conditions !== snapshot.conditions.version : source.versions.meal !== snapshot.mealRevision) throw new BackendError('VERSION_CONFLICT', 409)
      const record: AuthorizationRecord = {
        id: randomUUID(), sessionId, sourceMessageId: source.id, resetEpoch: input.resetEpoch, runId: input.runId,
        scope: constraint.scope, constraint, createdAt: new Date().toISOString(),
        ...(constraint.scope === 'conditions_update' ? { expectedConditionsVersion: snapshot.conditions.version } : {
          expectedMealRevision: snapshot.mealRevision,
          ...(constraint.scope !== 'meal_add' ? { expectedMealVersion: snapshot.meals.find(meal => meal.id === constraint.mealId)!.version } : {}),
        }),
      }
      this.database.prepare('INSERT INTO write_authorizations(id, session_id, reset_epoch, source_message_id, run_id, record_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(record.id, sessionId, record.resetEpoch, record.sourceMessageId, record.runId, JSON.stringify(record))
      return record
    })
  }

  assertAuthorization(sessionId: string, request: MutationRequest & { authorizationId: string; runId: string; expectedMealRevision?: number; expectedMealVersion?: number; expectedConditionsVersion?: number }, constraint: MutationConstraint): AuthorizationRecord {
    this.requireTransaction()
    const row = this.database.prepare(`SELECT a.record_json, a.consumed_by_request_id, u.record_json AS source_json FROM write_authorizations a
      JOIN user_inputs u ON u.id = a.source_message_id AND u.session_id = a.session_id AND u.reset_epoch = a.reset_epoch
      WHERE a.id = ? AND a.session_id = ? AND a.reset_epoch = ? AND a.run_id = ?`)
      .get(request.authorizationId, sessionId, request.resetEpoch, request.runId)
    if (!row) throw new BackendError('AUTHORIZATION_INVALID', 403)
    if (row.consumed_by_request_id !== null) throw new BackendError('AUTHORIZATION_CONSUMED', 409)
    const record = JSON.parse(String(row.record_json)) as AuthorizationRecord
    this.assertAuthorizationSource(record, JSON.parse(String(row.source_json)) as UserInputRecord)
    if (canonicalJson(record.constraint) !== canonicalJson(constraint)
      || record.expectedMealRevision !== request.expectedMealRevision
      || record.expectedMealVersion !== request.expectedMealVersion
      || record.expectedConditionsVersion !== request.expectedConditionsVersion) throw new BackendError('AUTHORIZATION_MISMATCH', 403)
    return record
  }

  private assertSourceVersions(source: UserInputRecord): void {
    if (!source.versions || !Number.isSafeInteger(source.versions.meal) || source.versions.meal < 1
      || !Number.isSafeInteger(source.versions.conditions) || source.versions.conditions < 1) throw new BackendError('AUTHORIZATION_INVALID', 403)
  }

  private assertAuthorizationSource(record: AuthorizationRecord, source: UserInputRecord): void {
    this.assertSourceVersions(source)
    if (record.sourceMessageId !== source.id || record.sessionId !== source.sessionId || record.resetEpoch !== source.resetEpoch
      || (record.scope === 'conditions_update' ? record.expectedConditionsVersion !== source.versions.conditions : record.expectedMealRevision !== source.versions.meal)) throw new BackendError('AUTHORIZATION_INVALID', 403)
  }

  consumeAuthorization(sessionId: string, authorizationId: string, requestId: string): void {
    this.requireTransaction()
    const changed = this.database.prepare('UPDATE write_authorizations SET consumed_by_request_id = ? WHERE id = ? AND session_id = ? AND consumed_by_request_id IS NULL').run(requestId, authorizationId, sessionId)
    if (changed.changes !== 1) throw new BackendError('AUTHORIZATION_CONSUMED', 409)
  }

  getMealEntity(sessionId: string, resetEpoch: number, mealId: string): MealEntity | undefined {
    this.requireTransaction()
    const row = this.database.prepare('SELECT version, head_operation_id FROM meal_entities WHERE session_id = ? AND reset_epoch = ? AND meal_id = ?').get(sessionId, resetEpoch, mealId)
    return row ? { mealId, version: Number(row.version), headOperationId: row.head_operation_id === null ? null : String(row.head_operation_id) } : undefined
  }

  saveMealEntity(sessionId: string, resetEpoch: number, entity: MealEntity): void {
    this.requireTransaction()
    this.database.prepare(`INSERT INTO meal_entities(session_id, reset_epoch, meal_id, version, head_operation_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, reset_epoch, meal_id) DO UPDATE SET version = excluded.version, head_operation_id = excluded.head_operation_id`)
      .run(sessionId, resetEpoch, entity.mealId, entity.version, entity.headOperationId)
  }

  getMealOperation(sessionId: string, resetEpoch: number, operationId: string): MealOperation | undefined {
    this.requireTransaction()
    const row = this.database.prepare('SELECT record_json FROM meal_operations WHERE id = ? AND session_id = ? AND reset_epoch = ?').get(operationId, sessionId, resetEpoch)
    return row ? JSON.parse(String(row.record_json)) as MealOperation : undefined
  }

  storeMealOperation(record: MealOperation): void {
    this.requireTransaction()
    this.database.prepare('INSERT INTO meal_operations(id, session_id, reset_epoch, meal_id, record_json) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, record.sessionId, record.resetEpoch, record.mealId, JSON.stringify(record))
  }

  markMealOperationUndone(record: MealOperation, requestId: string): void {
    this.requireTransaction()
    const changed = this.database.prepare('UPDATE meal_operations SET record_json = ? WHERE id = ? AND session_id = ? AND reset_epoch = ?')
      .run(JSON.stringify({ ...record, status: 'undone', undoneByRequestId: requestId }), record.id, record.sessionId, record.resetEpoch)
    if (changed.changes !== 1) throw new BackendError('UNDO_CONFLICT', 409)
  }

  private reply(previous: RequestRow): StoredReply {
    return { httpStatus: previous.http_status, result: JSON.parse(previous.result_json) as ActionResult,
      ...(previous.continuation_json ? { continuation: JSON.parse(previous.continuation_json) as StartContinuation } : {}) }
  }

  private result(current: Snapshot, request: MutationRequest, outcome: MutationOutcome): ActionResult {
    return { ...outcome.result, requestId: request.requestId, resetEpoch: outcome.snapshot?.resetEpoch ?? current.resetEpoch, ...(outcome.snapshot ? { snapshot: outcome.snapshot } : {}) }
  }

  private saveSnapshot(current: Snapshot, request: MutationRequest, next?: Snapshot): void {
    if (!next) return
    const expectedEpoch = current.resetEpoch + (request.kind === 'reset_demo' ? 1 : 0)
    if (next.schemaVersion !== SCHEMA_VERSION || next.sessionId !== current.sessionId || next.resetEpoch !== expectedEpoch || next.revision !== current.revision + 1) throw new Error('INVALID_MUTATION_VERSION')
    const saved = this.database.prepare('UPDATE sessions SET reset_epoch = ?, revision = ?, snapshot_json = ? WHERE id = ? AND reset_epoch = ? AND revision = ?')
      .run(next.resetEpoch, next.revision, JSON.stringify(next), current.sessionId, current.resetEpoch, current.revision)
    if (saved.changes !== 1) throw new BackendError('VERSION_CONFLICT', 409)
  }
}
