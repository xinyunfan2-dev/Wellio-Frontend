import { randomUUID } from 'node:crypto'
import type { ActionRequest } from '../lib/contracts'
import type { StoredReply, WellioDatabase } from './database'
import { createSeed } from './seed'
import { recordWorkoutProgress, type ProgressRequest } from './workout-service'
import { applyProposal, dismissProposal } from './proposals'
import { undoMeal } from './meal-service'

export function executeAction(database: WellioDatabase, sessionId: string, request: ActionRequest): StoredReply {
  if (['start_workout', 'complete_exercise', 'undo_exercise', 'finish_workout'].includes(request.kind)) return recordWorkoutProgress(database, sessionId, request as ProgressRequest)
  if (request.kind === 'apply_proposal') return applyProposal(database, sessionId, request)
  if (request.kind === 'dismiss_proposal') return dismissProposal(database, sessionId, request)
  if (request.kind === 'undo_meal') return undoMeal(database, sessionId, request)
  return database.mutate(sessionId, request, current => {
    if (request.kind === 'set_locale') {
      current.locale = request.locale
      current.revision += 1
      return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', operationId: randomUUID() }, snapshot: current }
    }
    if (request.kind === 'reset_demo') {
      const next = createSeed(sessionId, request.scenario, current.locale)
      next.resetEpoch = current.resetEpoch + 1
      next.revision = current.revision + 1
      return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', operationId: randomUUID() }, snapshot: next }
    }
    const needsProvider = request.kind === 'check_readiness' || request.kind === 'request_proposal'
    return {
      httpStatus: needsProvider ? 503 : 501,
      result: { requestId: request.requestId, status: 'failed', errorCode: needsProvider ? 'PROVIDER_NOT_CONFIGURED' : 'ACTION_NOT_AVAILABLE' },
    }
  })
}
