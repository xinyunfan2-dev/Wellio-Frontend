import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ActionRequest, ActionResult, LocalizedText, Proposal, Snapshot, Workout } from '../lib/contracts'
import { assertContextVersions, type MutationOutcome, type StoredReply, type WellioDatabase } from './database'
import { BackendError } from './errors'
import { buildRestSchedule, applyRestSchedule } from './schedule'
import { localized, validateWorkoutCandidate, workoutSchema } from './workout-validation'
import { deriveLoadConfirmations } from './load-confirmation'
import { invalidateWorkoutAdvice, transitionWorkout } from './workout-service'

export interface ProposeWorkoutInput {
  kind: 'propose_workout'; requestId: string; resetEpoch: number; runId: string; contextReadId: string;
  scope: 'workout' | 'schedule'; reason: LocalizedText; workout?: Workout;
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const base = { kind: z.literal('propose_workout'), requestId: id, resetEpoch: z.number().int().positive(), runId: id, contextReadId: id, reason: localized }
const schema = z.discriminatedUnion('scope', [
  z.strictObject({ ...base, scope: z.literal('workout'), workout: workoutSchema }),
  z.strictObject({ ...base, scope: z.literal('schedule') }),
])
export type ApplyRequest = Extract<ActionRequest, {kind: 'apply_proposal'}>
type DismissRequest = Extract<ActionRequest, {kind: 'dismiss_proposal'}>

function verifiedLoads(database: WellioDatabase, snapshot: Snapshot) {
  const seen = new Set<string>()
  return database.listUserInputs(snapshot.sessionId, snapshot.resetEpoch).flatMap(source => {
    const result = deriveLoadConfirmations(snapshot, source)
    return result.kind === 'confirmed' ? result.confirmations.filter(evidence => {
      const key = `${evidence.trainingSessionId}/${evidence.catalogId}/${evidence.equipmentId}/${evidence.basis}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }) : []
  })
}

function failure(requestId: string, error: BackendError, snapshot?: Snapshot, flags?: Partial<ActionResult>): MutationOutcome {
  return { httpStatus: error.httpStatus, result: { requestId, status: error.httpStatus === 200 ? 'needs_input' : error.httpStatus === 409 ? 'conflict' : 'failed', errorCode: error.code, ...(snapshot ? { snapshot } : {}), ...flags } }
}

/** Trusted server tool boundary, never an HTTP action accepting arbitrary candidates. */
export function proposeWorkout(database: WellioDatabase, sessionId: string, input: ProposeWorkoutInput): StoredReply {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  return database.mutate(sessionId, parsed.data, snapshot => {
    try {
      const context = database.getContextRead(sessionId, input.contextReadId, input.runId, input.resetEpoch)
      const proposal: Proposal = { id: randomUUID(), scope: input.scope, status: 'pending', reason: parsed.data.reason, expected: context.versions, contextReadId: context.id, readinessSnapshotId: context.readinessSnapshotId, runId: context.runId, resetEpoch: context.resetEpoch }
      if (parsed.data.scope === 'workout') proposal.workout = validateWorkoutCandidate(snapshot, parsed.data.workout, verifiedLoads(database, snapshot))
      else Object.assign(proposal, buildRestSchedule(snapshot))
      // One current candidate. Creating a newer one cannot leave an older Apply active.
      for (const previous of snapshot.proposals) if (previous.status === 'pending') previous.status = 'stale'
      snapshot.proposals.push(proposal)
      snapshot.revision += 1
      return { httpStatus: 200, result: { requestId: input.requestId, status: 'succeeded', proposalId: proposal.id, operationId: randomUUID() }, snapshot }
    } catch (error) {
      if (error instanceof BackendError) return failure(input.requestId, error, database.getSnapshot(sessionId))
      throw error
    }
  })
}

function findProposal(snapshot: Snapshot, proposalId: string): Proposal {
  const proposal = snapshot.proposals.find(proposal => proposal.id === proposalId)
  if (!proposal) throw new BackendError('NOT_FOUND', 404)
  return proposal
}

function validateProposalContext(database: WellioDatabase, snapshot: Snapshot, proposal: Proposal): void {
  if (proposal.status !== 'pending') throw new BackendError('STALE_PROPOSAL', 409)
  if (proposal.resetEpoch !== snapshot.resetEpoch || !proposal.runId) throw new BackendError('STALE_PROPOSAL', 409)
  const context = database.getContextRead(snapshot.sessionId, proposal.contextReadId, proposal.runId, proposal.resetEpoch)
  if (context.readinessSnapshotId !== proposal.readinessSnapshotId) throw new BackendError('CONTEXT_STALE', 409)
  assertContextVersions(snapshot, proposal.expected)
}

/** Commit only the Apply phase; also used to recover a crash before Start. */
export function applyProposalPhase(database: WellioDatabase, sessionId: string, request: ApplyRequest): StoredReply {
  return database.mutate(sessionId, request, snapshot => {
    try {
      if (request.source !== 'today' && request.source !== 'agent') throw new BackendError('APPLY_REQUIRES_USER_ACTION', 403)
      const proposal = findProposal(snapshot, request.proposalId)
      if (proposal.scope === 'schedule' && request.startAfterApply) throw new BackendError('REST_CANNOT_START', 400)
      if (proposal.status === 'applied') throw new BackendError('PROPOSAL_ALREADY_APPLIED', 409)
      validateProposalContext(database, snapshot, proposal)
      if (proposal.scope === 'schedule') applyRestSchedule(snapshot, proposal)
      else {
        if (!proposal.workout) throw new BackendError('INVALID_WORKOUT_PROPOSAL', 400)
        snapshot.workout = validateWorkoutCandidate(snapshot, proposal.workout, verifiedLoads(database, snapshot))
        const session = snapshot.plan.sessions.find(session => session.id === snapshot.workout!.trainingSessionId)!
        if (session.workoutId !== snapshot.workout.id) { session.workoutId = snapshot.workout.id; snapshot.plan.version += 1 }
        if (snapshot.conditions.gymId !== snapshot.workout.gymId) { snapshot.conditions.gymId = snapshot.workout.gymId; snapshot.conditions.version += 1 }
      }
      proposal.status = 'applied'
      database.consumeReadinessCheck(snapshot, proposal, 'applied')
      invalidateWorkoutAdvice(snapshot)
      snapshot.revision += 1
      const continuation = request.startAfterApply && snapshot.workout!.status === 'planned'
        ? { kind: 'start_workout' as const, workoutId: snapshot.workout!.id, expectedWorkoutVersion: snapshot.workout!.version } : undefined
      return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', operationId: randomUUID(), applyStatus: 'succeeded', startStatus: request.startAfterApply ? continuation ? 'not_started' : 'succeeded' : 'not_requested' }, snapshot, ...(continuation ? { continuation } : {}) }
    } catch (error) {
      if (error instanceof BackendError) return failure(request.requestId, error, database.getSnapshot(sessionId), { applyStatus: 'failed', startStatus: request.startAfterApply ? 'failed' : 'not_requested' })
      throw error
    }
  })
}

export function applyProposal(database: WellioDatabase, sessionId: string, request: ApplyRequest): StoredReply {
  const applied = applyProposalPhase(database, sessionId, request)
  if (!applied.continuation) return applied
  try {
    return database.resumeMutation(sessionId, request, (snapshot, continuation, previous) => {
      try {
        const transition = transitionWorkout(snapshot, { ...continuation, requestId: request.requestId, resetEpoch: request.resetEpoch, source: request.source })
        return { ...transition, result: { ...transition.result, operationId: previous.operationId, applyStatus: 'succeeded', startStatus: 'succeeded' } }
      } catch (error) {
        if (error instanceof BackendError) return { httpStatus: 200, result: { requestId: request.requestId, status: 'failed', errorCode: error.code, operationId: previous.operationId, applyStatus: 'succeeded', startStatus: 'failed', snapshot: database.getSnapshot(sessionId) } }
        throw error
      }
    })
  } catch (error) {
    if (error instanceof BackendError) throw error
    // Apply committed. A transient Start storage failure must not undo or re-apply it.
    const snapshot = database.getSnapshot(sessionId)
    return { httpStatus: 200, result: { requestId: request.requestId, resetEpoch: snapshot.resetEpoch, status: 'failed', errorCode: 'START_FAILED', operationId: applied.result.operationId, applyStatus: 'succeeded', startStatus: 'failed', snapshot } }
  }
}

export function dismissProposal(database: WellioDatabase, sessionId: string, request: DismissRequest): StoredReply {
  return database.mutate(sessionId, request, snapshot => {
    if (request.source !== 'today' && request.source !== 'agent') throw new BackendError('APPLY_REQUIRES_USER_ACTION', 403)
    const proposal = findProposal(snapshot, request.proposalId)
    if (proposal.status === 'dismissed') return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', snapshot } }
    validateProposalContext(database, snapshot, proposal)
    proposal.status = 'dismissed'
    database.consumeReadinessCheck(snapshot, proposal, 'dismissed')
    snapshot.revision += 1
    return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', operationId: randomUUID() }, snapshot }
  })
}
