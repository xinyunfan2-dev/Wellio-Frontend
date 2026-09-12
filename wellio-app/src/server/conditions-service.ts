import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { StoredReply, WellioDatabase } from './database'
import { lookupEquipment } from './equipment'
import { BackendError } from './errors'
import { invalidateWorkoutAdvice } from './workout-service'

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const equipmentStatusPatch = z.record(
  id.refine(value => lookupEquipment(value) !== undefined),
  z.enum(['available', 'temporarily_occupied', 'unavailable']),
).refine(value => Object.keys(value).length > 0)

export const conditionsChangesSchema = z.strictObject({
  availableMinutes: z.number().int().min(1).max(180).optional(),
  dinnerBudget: z.number().min(0).max(10_000).multipleOf(0.01).optional(),
  gymId: z.enum(['gym-a', 'gym-b']).optional(),
  equipmentStatus: equipmentStatusPatch.optional(),
}).refine(value => Object.values(value).some(change => change !== undefined))

export const updateConditionsSchema = z.strictObject({
  kind: z.literal('update_conditions'),
  requestId: id,
  resetEpoch: version,
  runId: id,
  authorizationId: id,
  expectedConditionsVersion: version,
  changes: conditionsChangesSchema,
})

export type ConditionsChanges = z.infer<typeof conditionsChangesSchema>
export type UpdateConditionsInput = z.infer<typeof updateConditionsSchema>

/** Apply one verified user instruction to this session's current conditions. */
export function updateConditions(database: WellioDatabase, sessionId: string, input: unknown): StoredReply {
  const parsed = updateConditionsSchema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  const request = parsed.data
  return database.mutate(sessionId, request, snapshot => {
    const authorization = database.assertAuthorization(sessionId, request, { scope: 'conditions_update', changes: request.changes })
    if (snapshot.conditions.version !== request.expectedConditionsVersion) throw new BackendError('VERSION_CONFLICT', 409)

    const changes = request.changes
    const current = snapshot.conditions
    const changed = (changes.availableMinutes !== undefined && changes.availableMinutes !== current.availableMinutes)
      || (changes.dinnerBudget !== undefined && changes.dinnerBudget !== current.dinnerBudget)
      || (changes.gymId !== undefined && changes.gymId !== current.gymId)
      || Object.entries(changes.equipmentStatus ?? {}).some(([equipmentId, status]) => status !== (current.equipmentStatus?.[equipmentId] ?? 'available'))

    // The receipt and authorization are committed together, including semantic no-ops.
    database.consumeAuthorization(sessionId, request.authorizationId, request.requestId)
    if (!changed) return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', snapshot } }

    if (changes.availableMinutes !== undefined) current.availableMinutes = changes.availableMinutes
    if (changes.dinnerBudget !== undefined) current.dinnerBudget = changes.dinnerBudget
    if (changes.gymId !== undefined) current.gymId = changes.gymId
    if (changes.equipmentStatus) current.equipmentStatus = { ...current.equipmentStatus, ...changes.equipmentStatus }
    current.version += 1
    current.lastChange = { sourceMessageId: authorization.sourceMessageId, requestId: request.requestId, version: current.version }
    snapshot.revision += 1
    invalidateWorkoutAdvice(snapshot)
    return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', operationId: randomUUID() }, snapshot }
  })
}
