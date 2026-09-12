import { randomUUID } from 'node:crypto'
import type { ActionRequest, Meal, Snapshot } from '../lib/contracts'
import type { StoredReply, WellioDatabase } from './database'
import { BackendError } from './errors'
import { mutateMealLogSchema, type MutateMealLogInput } from './meal-validation'
import type { MealEntity, MealOperation, MutationConstraint } from './mutation-types'
import { canonicalJson, parseAction } from './validation'
import { invalidateWorkoutAdvice } from './workout-service'
import { calculateDailyTotals, calculateMealTotals } from './read-services'

export { mutateMealLogSchema, type MutateMealLogInput } from './meal-validation'

function constraintFor(request: MutateMealLogInput): MutationConstraint {
  if (request.action === 'add') return { scope: 'meal_add' }
  const target = { mealId: request.mealId, ...(request.mealItemId ? { mealItemId: request.mealItemId } : {}) }
  if (request.action === 'delete') return { scope: 'meal_delete', ...target }
  return { scope: 'meal_update', mealId: request.mealId, mealItemId: request.mealItemId, changes: request.changes }
}

function mealBusinessValue(meal: Meal | null): unknown {
  if (!meal) return null
  const { version: _version, operationId: _operationId, ...business } = meal
  return business
}

function changed(snapshot: Snapshot): void {
  snapshot.mealRevision += 1
  snapshot.revision += 1
  invalidateWorkoutAdvice(snapshot)
}

function nutrition(snapshot: Snapshot, mealId: string) {
  const meal = snapshot.meals.find(meal => meal.id === mealId)
  return { meal: meal ? calculateMealTotals(meal) : null, day: calculateDailyTotals(snapshot) }
}

/** Server-only mutation tool. Its authorization is injected by the trusted dispatcher. */
export function mutateMealLog(database: WellioDatabase, sessionId: string, input: unknown): StoredReply {
  const parsed = mutateMealLogSchema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  const request = parsed.data
  return database.mutate(sessionId, request, snapshot => {
    const authorization = database.assertAuthorization(sessionId, request, constraintFor(request))
    if (snapshot.mealRevision !== request.expectedMealRevision) throw new BackendError('VERSION_CONFLICT', 409)
    const beforeIndex = request.action === 'add' ? snapshot.meals.length : snapshot.meals.findIndex(meal => meal.id === request.mealId)
    if (beforeIndex < 0) throw new BackendError('NOT_FOUND', 404)
    const before = request.action === 'add' ? null : structuredClone(snapshot.meals[beforeIndex])
    if (request.action !== 'add' && before!.version !== request.expectedMealVersion) throw new BackendError('VERSION_CONFLICT', 409)
    const mealId = before?.id ?? randomUUID()
    const entity = database.getMealEntity(sessionId, snapshot.resetEpoch, mealId)
      ?? { mealId, version: before?.version ?? 0, headOperationId: before?.operationId ?? null }
    if (before && (before.version !== entity.version || (before.operationId ?? null) !== entity.headOperationId)) throw new BackendError('VERSION_CONFLICT', 409)
    let after: Meal | null
    if (request.action === 'add') {
      after = { ...request.meal, id: mealId, version: 1, items: request.meal.items.map(item => ({ ...item, id: randomUUID() })) }
    } else if (request.action === 'update') {
      after = structuredClone(before!)
      const item = after.items.find(item => item.id === request.mealItemId)
      if (!item) throw new BackendError('NOT_FOUND', 404)
      if ('consumedFraction' in request.changes) item.consumedFraction = request.changes.consumedFraction
      else Object.assign(item, request.changes.baseline)
    } else if (request.mealItemId) {
      if (!before!.items.some(item => item.id === request.mealItemId)) throw new BackendError('NOT_FOUND', 404)
      after = { ...structuredClone(before!), items: before!.items.filter(item => item.id !== request.mealItemId) }
      if (!after.items.length) after = null
    } else after = null

    database.consumeAuthorization(sessionId, request.authorizationId, request.requestId)
    if (canonicalJson(mealBusinessValue(before)) === canonicalJson(mealBusinessValue(after))) return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', snapshot, nutrition: nutrition(snapshot, mealId) } }
    const operationId = randomUUID()
    const nextEntity: MealEntity = { mealId, version: entity.version + 1, headOperationId: operationId }
    if (after) { after.version = nextEntity.version; after.operationId = operationId }
    const operation: MealOperation = { id: operationId, sessionId, resetEpoch: snapshot.resetEpoch, mealId, action: request.action, sourceMessageId: authorization.sourceMessageId, requestId: request.requestId, before, after, beforeIndex, afterVersion: nextEntity.version, parentOperationId: entity.headOperationId, status: 'applied' }
    database.storeMealOperation(operation)
    database.saveMealEntity(sessionId, snapshot.resetEpoch, nextEntity)
    snapshot.meals.splice(beforeIndex, before ? 1 : 0, ...(after ? [after] : []))
    changed(snapshot)
    return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', operationId, nutrition: nutrition(snapshot, mealId) }, snapshot }
  })
}

/** Existing authenticated UI action, scoped to one persisted operation. */
export function undoMeal(database: WellioDatabase, sessionId: string, input: Extract<ActionRequest, { kind: 'undo_meal' }>): StoredReply {
  const parsed = parseAction(input)
  if (parsed.kind !== 'undo_meal') throw new BackendError('INVALID_INPUT', 400)
  if (parsed.source !== 'today' && parsed.source !== 'agent') throw new BackendError('MEAL_REQUIRES_USER_ACTION', 403)
  return database.mutate(sessionId, parsed, snapshot => {
    const operation = database.getMealOperation(sessionId, snapshot.resetEpoch, parsed.operationId)
    if (!operation) throw new BackendError('NOT_FOUND', 404)
    if (operation.status === 'undone') return { httpStatus: 200, result: { requestId: parsed.requestId, status: 'succeeded', operationId: operation.id, snapshot, nutrition: nutrition(snapshot, operation.mealId) } }
    const entity = database.getMealEntity(sessionId, snapshot.resetEpoch, operation.mealId)
    const index = snapshot.meals.findIndex(meal => meal.id === operation.mealId)
    const current = index < 0 ? null : snapshot.meals[index]
    if (!entity || entity.headOperationId !== operation.id || (current && (current.version !== entity.version || current.operationId !== entity.headOperationId))
      || canonicalJson(mealBusinessValue(current)) !== canonicalJson(mealBusinessValue(operation.after))) throw new BackendError('UNDO_CONFLICT', 409)
    const restored = operation.before ? structuredClone(operation.before) : null
    const nextEntity: MealEntity = { mealId: operation.mealId, version: entity.version + 1, headOperationId: operation.parentOperationId }
    if (restored) {
      restored.version = nextEntity.version
      if (nextEntity.headOperationId) restored.operationId = nextEntity.headOperationId
      else delete restored.operationId
    }
    if (index >= 0) snapshot.meals.splice(index, 1, ...(restored ? [restored] : []))
    else if (restored) snapshot.meals.splice(Math.min(operation.beforeIndex, snapshot.meals.length), 0, restored)
    database.saveMealEntity(sessionId, snapshot.resetEpoch, nextEntity)
    database.markMealOperationUndone(operation, parsed.requestId)
    changed(snapshot)
    return { httpStatus: 200, result: { requestId: parsed.requestId, status: 'succeeded', operationId: operation.id, nutrition: nutrition(snapshot, operation.mealId) }, snapshot }
  })
}
