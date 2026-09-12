import { createHash, randomUUID } from 'node:crypto'
import type { Advice, ChatRequest, Message, ReadinessCheck, Snapshot, ToolStep } from '../lib/contracts'
import { type WellioDatabase, contextVersions } from './database'
import type { AgentRun, CheckRecord, RuntimeCapabilities } from './agent-types'
import type { UserInputRecord } from './mutation-types'
import { BackendError } from './errors'
import { canonicalJson } from './validation'

export function readinessKey(snapshot: Snapshot): string {
  return createHash('sha256').update(canonicalJson([snapshot.sessionId, snapshot.resetEpoch, snapshot.dayKey, snapshot.readiness.id, snapshot.readiness.version])).digest('hex')
}
function publicCheck(check: CheckRecord): ReadinessCheck {
  return { key: check.key, status: check.status, ...(check.messageId ? { messageId: check.messageId } : {}), ...(check.proposalId ? { proposalId: check.proposalId } : {}), ...(check.errorCode ? { errorCode: check.errorCode } : {}) }
}
function validReadiness(snapshot: Snapshot): boolean { return snapshot.readiness.quality === 'valid' && snapshot.readiness.dayKey === snapshot.dayKey && snapshot.readiness.score !== null }

function stopRecord(db: WellioDatabase, snapshot: Snapshot, run: AgentRun, status: 'failed' | 'stopped', code: string): void {
  run.status = status; run.errorCode = code
  db.saveAgentRun(run)
  const message = snapshot.messages.find(message => message.id === run.messageId)
  if (message) {
    message.status = status; message.errorCode = code; delete message.phase
    for (const step of message.steps) if (step.status === 'started') { step.status = 'failed'; step.errorCode = code }
  }
  if (run.checkKey) {
    const check = db.getReadinessCheck(snapshot.sessionId, run.checkKey)
    if (check && check.attemptId === run.checkAttemptId && check.status === 'pending') {
      check.status = status; check.errorCode = code
      db.saveReadinessCheck(check)
      if (snapshot.readinessCheck?.key === check.key) snapshot.readinessCheck = publicCheck(check)
    }
  }
  if (snapshot.advice.messageId === run.messageId && snapshot.advice.status === 'pending') snapshot.advice = { ...snapshot.advice, status: 'failed', errorCode: code }
}

export function synchronizeRuntime(db: WellioDatabase, sessionId: string, capabilities: RuntimeCapabilities, now = Date.now()): Snapshot {
  return db.runtimeTransaction(sessionId, snapshot => {
    const before = canonicalJson(snapshot)
    for (const run of db.listAgentRuns(sessionId)) if (run.resetEpoch === snapshot.resetEpoch && run.status === 'pending' && run.leaseExpiresAt <= now) stopRecord(db, snapshot, run, 'failed', 'RUN_LEASE_EXPIRED')
    snapshot.capabilities = { ...capabilities, persistence: 'server' }
    const key = readinessKey(snapshot)
    let check = db.getReadinessCheck(sessionId, key)
    // Preserve the earlier no-provider API shape; configured runtimes expose the check ledger.
    if (check || capabilities.agent) {
      const available = capabilities.agent && validReadiness(snapshot)
      if (!check) check = { sessionId, resetEpoch: snapshot.resetEpoch, key, status: available ? 'idle' : 'unavailable', ...(!available ? { errorCode: 'READINESS_UNAVAILABLE' } : {}) }
      else if (check.status === 'unavailable' && available) { check.status = 'idle'; delete check.errorCode }
      else if (check.status === 'idle' && !available) { check.status = 'unavailable'; check.errorCode = capabilities.agent ? 'READINESS_UNAVAILABLE' : 'PROVIDER_NOT_CONFIGURED' }
      db.saveReadinessCheck(check)
      snapshot.readinessCheck = publicCheck(check)
    }
    return { value: snapshot, changed: before !== canonicalJson(snapshot) }
  })
}

export type Claim = { type: 'run'; run: AgentRun } | { type: 'replay'; run: AgentRun } | { type: 'check'; outcome: 'reused' | 'in_progress' | 'not_needed' | 'not_available'; snapshot: Snapshot }

export function claimRun(db: WellioDatabase, sessionId: string, request: ChatRequest, timeoutMs: number, now: number, source: AgentRun['source'] = request.source, requestedGymId?: 'gym-a' | 'gym-b', actionRequest?: AgentRun['actionRequest']): Claim {
  return db.runtimeTransaction<Claim>(sessionId, snapshot => {
    if (snapshot.resetEpoch !== request.resetEpoch) throw new BackendError('STALE_EPOCH', 409)
    if (snapshot.conversationId !== request.conversationId) throw new BackendError('CONVERSATION_MISMATCH', 409)
    // UI identity is the original Action; locale is response context, not a new request.
    if (actionRequest) db.getMutationReply(sessionId, actionRequest)
    const hash = createHash('sha256').update(canonicalJson(actionRequest ?? { ...request, actualSource: source, ...(requestedGymId ? { requestedGymId } : {}) })).digest('hex')
    const prior = db.findAgentRun(sessionId, request.requestId)
    if (prior) {
      if (prior.payloadHash !== hash) throw new BackendError('IDEMPOTENCY_CONFLICT', 409)
      return { value: { type: 'replay', run: prior }, changed: false }
    }
    let check: CheckRecord | undefined
    if (source === 'app_open') {
      check = db.getReadinessCheck(sessionId, readinessKey(snapshot))
      const outcome = !snapshot.capabilities.agent || !validReadiness(snapshot) || !check || check.status === 'unavailable' ? 'not_available'
        : check.status === 'pending' ? 'in_progress'
          : ['completed', 'applied', 'dismissed'].includes(check.status) ? 'reused'
            : ['failed', 'stopped'].includes(check.status) && request.checkMode !== 'retry' ? 'not_needed' : undefined
      if (outcome) return { value: { type: 'check', outcome, snapshot }, changed: false }
    }
    for (const other of db.listAgentRuns(sessionId)) {
      if (other.resetEpoch !== snapshot.resetEpoch || other.status !== 'pending') continue
      if (source !== 'app_open' && other.source === 'app_open') stopRecord(db, snapshot, other, 'stopped', 'USER_PRIORITY')
      else if (source === 'app_open') return { value: { type: 'check', outcome: 'not_needed', snapshot }, changed: false }
      else throw new BackendError('RUN_IN_PROGRESS', 409)
    }
    const run: AgentRun = { id: randomUUID(), sessionId, requestId: request.requestId, resetEpoch: request.resetEpoch, payloadHash: hash, request, source, messageId: randomUUID(), status: 'pending', leaseExpiresAt: now + timeoutMs + 2_000, searchUsed: false, toolIds: [] }
    if (actionRequest) run.actionRequest = actionRequest
    if (requestedGymId) run.requestedGymId = requestedGymId
    if (source === 'user') {
      if (request.targetMealId && !snapshot.meals.some(meal => meal.id === request.targetMealId)) throw new BackendError('NOT_FOUND', 404)
      if (request.targetWorkoutId && snapshot.workout?.id !== request.targetWorkoutId) throw new BackendError('NOT_FOUND', 404)
      if (request.targetExerciseId && !snapshot.workout?.exercises.some(exercise => exercise.id === request.targetExerciseId)) throw new BackendError('NOT_FOUND', 404)
      if (request.targetMealItemId && !snapshot.meals.some(meal => (!request.targetMealId || request.targetMealId === meal.id) && meal.items.some(item => item.id === request.targetMealItemId))) throw new BackendError('NOT_FOUND', 404)
      const input: UserInputRecord = { id: randomUUID(), sessionId, requestId: `chat-input-${run.id}`, resetEpoch: snapshot.resetEpoch, conversationId: snapshot.conversationId, content: request.message, createdAt: new Date(now).toISOString(), versions: { meal: snapshot.mealRevision, conditions: snapshot.conditions.version, workout: snapshot.workout?.version ?? 0, plan: snapshot.plan.version }, attachmentIds: request.attachmentIds, ...(request.purpose ? { purpose: request.purpose } : {}) }
      for (const key of ['targetMealId', 'targetMealItemId', 'targetWorkoutId', 'targetExerciseId', 'targetOperationId'] as const) if (request[key]) input[key] = request[key]
      if (snapshot.workout) input.workoutContext = { workoutId: snapshot.workout.id, trainingSessionId: snapshot.workout.trainingSessionId, gymId: snapshot.conditions.gymId }
      db.storeUserInput(input)
      run.sourceMessageId = input.id
      snapshot.messages.push({ id: input.id, role: 'user', source: 'user', content: input.content, createdAt: input.createdAt, status: 'complete', steps: [], ...(input.targetMealId ? { mealId: input.targetMealId } : {}), ...(request.attachmentIds[0] ? { attachmentUrl: `/api/attachments/${request.attachmentIds[0]}` } : {}) })
    }
    const message: Message = { id: run.messageId, role: 'assistant', source: source === 'app_open' ? 'app_open' : 'agent', content: '', createdAt: new Date(now).toISOString(), status: 'streaming', steps: [] }
    snapshot.messages.push(message)
    if (check) {
      check.status = 'pending'; check.runId = run.id; check.attemptId = randomUUID(); check.messageId = message.id; check.leaseExpiresAt = run.leaseExpiresAt
      delete check.errorCode; delete check.proposalId
      run.checkKey = check.key; run.checkAttemptId = check.attemptId
      snapshot.readinessCheck = publicCheck(check)
      snapshot.advice = { status: 'pending', messageId: message.id }
      db.saveReadinessCheck(check)
    }
    db.saveAgentRun(run)
    return { value: { type: 'run', run }, changed: true }
  })
}

export function assertRun(db: WellioDatabase, run: AgentRun, now = Date.now()): AgentRun {
  const snapshot = db.getSnapshot(run.sessionId)
  if (snapshot.resetEpoch !== run.resetEpoch) throw new BackendError('STALE_EPOCH', 409)
  const current = db.getAgentRun(run.sessionId, run.id)
  if (!current || current.status !== 'pending' || current.leaseExpiresAt <= now) throw new BackendError('RUN_NOT_ACTIVE', 409)
  return current
}

export function updateRun(db: WellioDatabase, run: AgentRun, now: number, update: (snapshot: Snapshot, current: AgentRun, message: Message) => void): Snapshot {
  return db.runtimeTransaction(run.sessionId, snapshot => {
    const current = assertRun(db, run, now)
    const message = snapshot.messages.find(message => message.id === current.messageId)
    if (!message) throw new BackendError('RUN_NOT_ACTIVE', 409)
    update(snapshot, current, message)
    db.saveAgentRun(current)
    return { value: snapshot, changed: true }
  })
}

export function saveToolStep(db: WellioDatabase, run: AgentRun, step: ToolStep, now: number): Snapshot {
  return updateRun(db, run, now, (_snapshot, current, message) => {
    const old = message.steps.findIndex(value => value.toolCallId === step.toolCallId)
    if (old < 0) message.steps.push(step)
    else message.steps[old] = step
    if (!current.toolIds.includes(step.toolCallId)) current.toolIds.push(step.toolCallId)
    if (current.toolIds.length > 48) throw new BackendError('TOOL_LIMIT_EXCEEDED', 429)
  })
}

export function finishRun(db: WellioDatabase, run: AgentRun, output: { markdown: string; trainingSummary: string; nutritionSummary: string }, now: number): Snapshot {
  return updateRun(db, run, now, (snapshot, current, message) => {
    if (!current.lastContextReadId) throw new BackendError('CONTEXT_READ_REQUIRED', 409)
    const context = db.getContextRead(run.sessionId, current.lastContextReadId, run.id, run.resetEpoch)
    message.content = output.markdown; message.status = 'complete'; delete message.phase
    current.status = 'completed'
    const localized = (value: string) => ({ en: value, 'zh-CN': value })
    const advice: Advice = { status: 'valid', training: localized(output.trainingSummary), nutrition: localized(output.nutritionSummary), messageId: message.id, contextReadId: context.id, versions: contextVersions(snapshot) }
    snapshot.advice = advice
    if (current.checkKey) {
      const check = db.getReadinessCheck(run.sessionId, current.checkKey)
      if (check && check.attemptId === current.checkAttemptId && check.status === 'pending') {
        check.status = 'completed'; db.saveReadinessCheck(check)
        if (snapshot.readinessCheck?.key === check.key) snapshot.readinessCheck = publicCheck(check)
      }
    }
  })
}

export function failRun(db: WellioDatabase, run: AgentRun, status: 'failed' | 'stopped', code: string): Snapshot | undefined {
  return db.runtimeTransaction(run.sessionId, snapshot => {
    if (snapshot.resetEpoch !== run.resetEpoch) return { value: undefined, changed: false }
    const current = db.getAgentRun(run.sessionId, run.id)
    if (!current || current.status !== 'pending') return { value: snapshot, changed: false }
    stopRecord(db, snapshot, current, status, code)
    return { value: snapshot, changed: true }
  })
}
