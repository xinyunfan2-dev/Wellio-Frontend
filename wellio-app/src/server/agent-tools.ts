import { createHash } from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'
import type { ChatEvent, OperationType, ToolStep } from '../lib/contracts'
import type { AgentRun } from './agent-types'
import type { MenuConfiguration } from './agent-config'
import type { WellioDatabase } from './database'
import { assertRun, saveToolStep, updateRun } from './agent-state'
import { authorizeUserMutation } from './authorization'
import { getGymEquipment } from './equipment'
import { BackendError } from './errors'
import { mutateMealLog, undoMeal } from './meal-service'
import { mealChangesSchema, mealItemInputSchema } from './meal-validation'
import { menuSearchInputSchema, searchRestaurantMenu } from './menu-search'
import { proposeWorkout } from './proposals'
import { getDayContext, queryHistory } from './read-services'
import { recordWorkoutProgress } from './workout-service'
import { localized, workoutSchema } from './workout-validation'
import { canonicalJson } from './validation'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const dates = { from: z.iso.date(), to: z.iso.date() }
const mealSchema = z.strictObject({ period: z.enum(['breakfast', 'lunch', 'dinner', 'snack']), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), items: z.array(mealItemInputSchema).min(1).max(30) })
const mealToolSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), meal: mealSchema }),
  z.strictObject({ action: z.literal('update'), mealId: id, mealItemId: id, changes: mealChangesSchema }),
  z.strictObject({ action: z.literal('delete'), mealId: id, mealItemId: id.optional() }),
])
const progressSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start_workout'), workoutId: id }),
  z.strictObject({ kind: z.literal('complete_exercise'), workoutId: id, exerciseId: id }),
  z.strictObject({ kind: z.literal('undo_exercise'), workoutId: id, exerciseId: id }),
  z.strictObject({ kind: z.literal('finish_workout'), workoutId: id, actualMinutes: z.number().int().min(1).max(1440), confirmIncomplete: z.boolean() }),
])

export function toolRequestId(runId: string, toolCallId: string): string { return `tool-${createHash('sha256').update(`${runId}\0${toolCallId}`).digest('hex')}` }

export function createAgentTools(options: { db: WellioDatabase; run: AgentRun; now: () => number; signal: AbortSignal; menuSearch: MenuConfiguration; emit: (event: ChatEvent) => void }) {
  const { db, run, now, signal, emit } = options
  const envelope = { requestId: run.requestId, resetEpoch: run.resetEpoch }
  const requireContext = () => {
    const current = assertRun(db, run, now())
    if (!current.lastContextReadId) throw new BackendError('CONTEXT_READ_REQUIRED', 409)
    return db.getContextRead(run.sessionId, current.lastContextReadId, run.id, run.resetEpoch)
  }
  const userIntent = () => {
    if (run.source !== 'user' || !run.sourceMessageId) throw new BackendError('USER_INTENT_REQUIRED', 403)
    const source = db.getUserInput(run.sessionId, run.resetEpoch, run.sourceMessageId)
    if (!source) throw new BackendError('AUTHORIZATION_INVALID', 403)
    const intent = assertRun(db, run, now()).preparedIntent
    if (!intent) throw new BackendError('USER_INTENT_REQUIRED', 403)
    return { source, intent }
  }
  const write = <T,>(toolCallId: string, execute: () => T) => db.withAgentTool({ runId: run.id, toolCallId, now: now() }, execute)
  function wrap<T>(name: string, operation: OperationType | ((input: T) => OperationType), schema: z.ZodType<T>, execute: (input: T, requestId: string, toolCallId: string) => unknown | Promise<unknown>) {
    return tool({ description: name, inputSchema: schema, execute: async (input, context) => {
      signal.throwIfAborted()
      assertRun(db, run, now())
      const step: ToolStep = { id: toolRequestId(run.id, context.toolCallId), toolCallId: context.toolCallId, operation: typeof operation === 'function' ? operation(input) : operation, status: 'started' }
      saveToolStep(db, run, step, now())
      emit({ type: 'tool', ...envelope, messageId: run.messageId, step })
      try {
        if (name !== 'get_day_context') requireContext()
        const value = await execute(input, step.id, context.toolCallId)
        signal.throwIfAborted()
        const result = value && typeof value === 'object' && 'result' in value ? (value as { result: { status?: string; errorCode?: string } }).result : value as { status?: string; errorCode?: string } | undefined
        const end: ToolStep = { ...step, status: result?.status === 'needs_input' ? 'awaiting_user' : ['failed', 'conflict'].includes(result?.status ?? '') ? 'failed' : 'succeeded', ...(result?.errorCode ? { errorCode: result.errorCode } : {}) }
        const snapshot = saveToolStep(db, run, end, now())
        emit({ type: 'tool', ...envelope, messageId: run.messageId, step: end })
        emit({ type: 'snapshot', ...envelope, snapshot })
        return value
      } catch (error) {
        if (signal.aborted) throw error
        const code = error instanceof BackendError ? error.code : 'TOOL_FAILED'
        const needsInput = error instanceof BackendError && [200, 422].includes(error.httpStatus)
        const end: ToolStep = { ...step, status: needsInput ? 'awaiting_user' : 'failed', errorCode: code }
        saveToolStep(db, run, end, now())
        emit({ type: 'tool', ...envelope, messageId: run.messageId, step: end })
        return { status: needsInput ? 'needs_input' : 'failed', errorCode: code }
      }
    } })
  }
  return {
    get_day_context: wrap('get_day_context', 'context', z.strictObject({}), (_input, requestId) => {
      const context = getDayContext(db, run.sessionId, { runId: run.id, requestId, resetEpoch: run.resetEpoch })
      updateRun(db, run, now(), (_snapshot, current) => { current.lastContextReadId = context.id; current.lastVersions = context.versions })
      return { ...context, snapshot: { ...context.snapshot, messages: [] } }
    }),
    get_gym_equipment: wrap('get_gym_equipment', 'equipment', z.strictObject({ gymId: z.enum(['gym-a', 'gym-b']) }), input => getGymEquipment(input.gymId, db.getSnapshot(run.sessionId).conditions.equipmentStatus)),
    query_history: wrap('query_history', 'history', z.discriminatedUnion('metric', [
      z.strictObject({ metric: z.literal('weight'), ...dates }), z.strictObject({ metric: z.literal('training'), ...dates }), z.strictObject({ metric: z.literal('nutrition'), ...dates }),
      z.strictObject({ metric: z.literal('exercise_load'), ...dates, exerciseId: id, equipmentId: id }),
    ]), input => queryHistory(db, run.sessionId, { ...input, resetEpoch: run.resetEpoch })),
    search_restaurant_menu: wrap('search_restaurant_menu', 'menu_search', menuSearchInputSchema, async input => {
      updateRun(db, run, now(), (_snapshot, current) => {
        if (current.searchUsed) throw new BackendError('SEARCH_LIMIT_REACHED', 429)
        current.searchUsed = true
      })
      return searchRestaurantMenu(input, { ...options.menuSearch, signal })
    }),
    mutate_meal_log: wrap('mutate_meal_log', input => input.action === 'add' ? 'meal_add' : input.action === 'delete' ? 'meal_delete' : 'meal_update', mealToolSchema, (input, requestId, toolCallId) => {
      const { intent } = userIntent()
      if (intent.kind === 'needs_input') throw new BackendError(intent.errorCode, 200)
      if (intent.kind !== 'meal') throw new BackendError('USER_INTENT_REQUIRED', 403)
      const context = requireContext()
      const authorization = authorizeUserMutation(db, run.sessionId, { sourceMessageId: run.sourceMessageId, resetEpoch: run.resetEpoch, runId: run.id })
      const meal = input.action !== 'add' ? context.snapshot.meals.find(meal => meal.id === input.mealId) : undefined
      return write(toolCallId, () => mutateMealLog(db, run.sessionId, { ...input, kind: 'mutate_meal_log', requestId, resetEpoch: run.resetEpoch, runId: run.id, authorizationId: authorization.id, expectedMealRevision: context.snapshot.mealRevision, ...(input.action !== 'add' ? { expectedMealVersion: meal?.version ?? 1 } : {}) }))
    }),
    undo_meal_change: wrap('undo_meal_change', 'meal_undo', z.strictObject({ operationId: id }), (input, requestId, toolCallId) => {
      const { source, intent } = userIntent()
      if (intent.kind === 'needs_input') throw new BackendError(intent.errorCode, 200)
      if (intent.kind !== 'undo' || intent.operationId !== input.operationId) throw new BackendError('USER_INTENT_REQUIRED', 403)
      if (source.versions.meal !== db.getSnapshot(run.sessionId).mealRevision) throw new BackendError('VERSION_CONFLICT', 409)
      return write(toolCallId, () => undoMeal(db, run.sessionId, { kind: 'undo_meal', ...input, requestId, resetEpoch: run.resetEpoch, source: 'agent' }))
    }),
    propose_workout: wrap('propose_workout', 'workout_proposal', z.discriminatedUnion('scope', [
      z.strictObject({ scope: z.literal('schedule'), reason: localized, contextReadId: id }),
      z.strictObject({ scope: z.literal('workout'), reason: localized, contextReadId: id, workout: workoutSchema }),
    ]), (input, requestId, toolCallId) => {
      const context = requireContext()
      if (context.id !== input.contextReadId) throw new BackendError('CONTEXT_STALE', 409)
      if (run.requestedGymId && (input.scope !== 'workout' || input.workout.gymId !== run.requestedGymId)) throw new BackendError('UI_GYM_MISMATCH', 409)
      return write(toolCallId, () => proposeWorkout(db, run.sessionId, { ...input, kind: 'propose_workout', requestId, resetEpoch: run.resetEpoch, runId: run.id }))
    }),
    record_workout_progress: wrap('record_workout_progress', 'workout_progress', progressSchema, (input, requestId, toolCallId) => {
      const { source, intent } = userIntent()
      if (intent.kind === 'needs_input') throw new BackendError(intent.errorCode, 200)
      if (intent.kind !== 'progress' || canonicalJson(intent.action) !== canonicalJson(input)) throw new BackendError('USER_INTENT_REQUIRED', 403)
      const snapshot = requireContext().snapshot
      if (source.versions.workout !== snapshot.workout?.version || source.versions.plan !== snapshot.plan.version) throw new BackendError('VERSION_CONFLICT', 409)
      return write(toolCallId, () => recordWorkoutProgress(db, run.sessionId, { ...input, requestId, resetEpoch: run.resetEpoch, source: 'agent', expectedWorkoutVersion: snapshot.workout!.version }))
    }),
  }
}
