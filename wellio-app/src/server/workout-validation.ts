import { z } from 'zod'
import type { Exercise, Snapshot, Workout, EquipmentStatus } from '../lib/contracts'
import { BackendError } from './errors'
import { lookupEquipment } from './equipment'
import { canonicalJson } from './validation'
import { validateUserLoad, type UserLoadEvidence } from './load-confirmation'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const localized = z.strictObject({ en: z.string().trim().min(1).max(2000), 'zh-CN': z.string().trim().min(1).max(2000) })
const exerciseSchema = z.strictObject({
  id, catalogId: id, name: localized, equipmentId: id, equipment: localized,
  sets: z.number().int().min(1).max(6), reps: z.number().int().min(1).max(30), restSeconds: z.number().int().min(15).max(300),
  suggestedLoad: z.strictObject({ value: z.number().finite().nonnegative().nullable(), unit: z.literal('kg'), basis: z.enum(['per_hand', 'machine_stack', 'bodyweight']), source: z.enum(['mock_history', 'user', 'missing']), sourceHistoryId: id.optional(), sourceMessageId: id.optional(), reason: localized }),
  completed: z.boolean(), instructions: localized, animation: z.enum(['row', 'pulldown', 'lateral', 'squat']).optional(), replacesId: id.optional(), equipmentStatus: z.enum(['available', 'temporarily_occupied', 'unavailable']).optional(),
})
export const workoutSchema = z.strictObject({
  id, trainingSessionId: id, version: z.number().int().positive(), dayKey: z.string(), name: localized, gymId: z.enum(['gym-a', 'gym-b']), estimatedMinutes: z.number().int().min(1).max(180),
  status: z.enum(['planned', 'in_progress', 'completed']), exercises: z.array(exerciseSchema).min(1).max(12), startedAt: z.string().optional(), endedAt: z.string().optional(), actualMinutes: z.number().optional(), source: z.enum(['demo_preset', 'agent_proposal']).optional(),
})

type CatalogExercise = { equipment: 'cable' | 'dumbbells' | 'pullup_bar'; split: 'Pull' | 'Legs' | 'Push'; bench?: boolean; perSide?: boolean }
const catalog: Record<string, CatalogExercise> = {
  'seated-cable-row': { equipment: 'cable', split: 'Pull' },
  'lat-pulldown': { equipment: 'cable', split: 'Pull' },
  'dumbbell-curl': { equipment: 'dumbbells', split: 'Pull' },
  'one-arm-dumbbell-row': { equipment: 'dumbbells', split: 'Pull', bench: true, perSide: true },
  'pull-up': { equipment: 'pullup_bar', split: 'Pull' },
  'goblet-squat': { equipment: 'dumbbells', split: 'Legs' },
  'dumbbell-romanian-deadlift': { equipment: 'dumbbells', split: 'Legs' },
  'reverse-lunge': { equipment: 'dumbbells', split: 'Legs', perSide: true },
  'dumbbell-bench-press': { equipment: 'dumbbells', split: 'Push', bench: true },
  'dumbbell-shoulder-press': { equipment: 'dumbbells', split: 'Push' },
  'triceps-pushdown': { equipment: 'cable', split: 'Push' },
  'lateral-raise': { equipment: 'dumbbells', split: 'Push' },
}

export function exerciseAvailability(snapshot: Snapshot, exercise: Exercise): EquipmentStatus {
  const statuses = snapshot.conditions.equipmentStatus ?? {}
  const requirements = [exercise.equipmentId]
  if (catalog[exercise.catalogId]?.bench) requirements.push(exercise.equipmentId.slice(0, 5) + '-bench')
  if (requirements.some(id => statuses[id] === 'unavailable')) return 'unavailable'
  if (requirements.some(id => statuses[id] === 'temporarily_occupied')) return 'temporarily_occupied'
  return 'available'
}

/** Conservative demo timing rule: 4 s/rep, inter-set rests, 90 s transitions. */
export function minimumWorkoutMinutes(exercises: Exercise[]): number {
  const pending = exercises.filter(exercise => !exercise.completed)
  const seconds = pending.reduce((total, exercise) => total + exercise.sets * exercise.reps * 4 * (catalog[exercise.catalogId]?.perSide ? 2 : 1) + (exercise.sets - 1) * exercise.restSeconds, 0)
    + Math.max(0, pending.length - 1) * 90
  return Math.ceil(seconds / 60)
}

function validateLoad(snapshot: Snapshot, exercise: Exercise, evidence: UserLoadEvidence[]): void {
  const equipment = lookupEquipment(exercise.equipmentId)
  if (!equipment || equipment.kind === 'bench') throw new BackendError('INVALID_EQUIPMENT', 400)
  const load = exercise.suggestedLoad
  if (load.basis !== equipment.load.basis) throw new BackendError('INVALID_LOAD', 400)
  if (equipment.kind === 'pullup_bar') {
    if (load.value !== null) throw new BackendError('INVALID_LOAD', 400)
    return
  }
  if (load.value !== null && !equipment.load.allowedKg.includes(load.value)) throw new BackendError('INVALID_LOAD', 400)
  if (load.source === 'user' && evidence.some(record => validateUserLoad(snapshot, exercise, record))) return
  // A model saying source=user is not a verified user-supplied load record.
  if (load.value === null || load.source !== 'mock_history' || !load.sourceHistoryId) throw new BackendError('LOAD_CONFIRMATION_REQUIRED', 200)
  const record = snapshot.history.load.find(record => record.id === load.sourceHistoryId)
  if (!record) throw new BackendError('LOAD_CONFIRMATION_REQUIRED', 200)
  if (record.exerciseId !== exercise.catalogId || record.equipmentId !== exercise.equipmentId || record.basis !== load.basis || record.kg !== load.value || record.date > snapshot.dayKey) throw new BackendError('INVALID_LOAD', 400)
  if (record.sets !== exercise.sets || record.reps !== exercise.reps) throw new BackendError('LOAD_CONFIRMATION_REQUIRED', 200)
  const latest = snapshot.history.load.filter(row => row.exerciseId === exercise.catalogId && row.equipmentId === exercise.equipmentId && row.basis === load.basis && row.sets === exercise.sets && row.reps === exercise.reps && row.date <= snapshot.dayKey).sort((a, b) => b.date.localeCompare(a.date))[0]
  if (latest && latest.id !== record.id) throw new BackendError('INVALID_LOAD', 400)
}

export function validateWorkoutCandidate(snapshot: Snapshot, candidate: Workout, evidence: UserLoadEvidence[] = []): Workout {
  const parsed = workoutSchema.safeParse(candidate)
  if (!parsed.success) throw new BackendError('INVALID_WORKOUT_PROPOSAL', 400)
  const next = parsed.data as Workout
  const current = snapshot.workout
  const session = snapshot.plan.sessions.find(session => session.id === next.trainingSessionId)
  if (!session || session.status === 'completed' || session.date !== snapshot.dayKey || snapshot.plan.restDates.includes(snapshot.dayKey)) throw new BackendError('WORKOUT_NOT_SCHEDULED', 409)
  if (next.dayKey !== snapshot.dayKey) throw new BackendError('WORKOUT_NOT_SCHEDULED', 409)
  if (current) {
    if (current.id !== next.id || current.trainingSessionId !== next.trainingSessionId) throw new BackendError('NOT_FOUND', 404)
    if (current.status === 'completed') throw new BackendError('WORKOUT_STATE_CONFLICT', 409)
    if (next.status !== current.status || next.startedAt !== current.startedAt || next.endedAt !== current.endedAt || next.actualMinutes !== current.actualMinutes) throw new BackendError('WORKOUT_STATE_CONFLICT', 409)
    current.exercises.forEach((exercise, index) => {
      if (exercise.completed && canonicalJson(exercise) !== canonicalJson(next.exercises[index])) throw new BackendError('COMPLETED_EXERCISE_IMMUTABLE', 409)
    })
  } else if (next.status !== 'planned' || next.startedAt || next.endedAt || next.actualMinutes !== undefined || session.workoutId) throw new BackendError('WORKOUT_STATE_CONFLICT', 409)
  const ids = new Set<string>()
  const replaced = new Set<string>()
  let occupiedSeen = false
  let availableCount = 0
  for (const exercise of next.exercises) {
    if (ids.has(exercise.id)) throw new BackendError('INVALID_EXERCISE_ID', 400)
    ids.add(exercise.id)
    const old = current?.exercises.find(old => old.id === exercise.id)
    if (exercise.completed && !old?.completed) throw new BackendError('COMPLETED_EXERCISE_IMMUTABLE', 409)
    if (old?.completed) continue
    const definition = catalog[exercise.catalogId]
    const equipment = lookupEquipment(exercise.equipmentId)
    if (!definition || !equipment || equipment.gymId !== next.gymId || equipment.kind !== definition.equipment || definition.split !== session.split) throw new BackendError('INVALID_EQUIPMENT', 400)
    if (old) {
      if (exercise.catalogId !== old.catalogId || exercise.equipmentId !== old.equipmentId || exercise.replacesId !== old.replacesId) throw new BackendError('INVALID_EXERCISE_ID', 400)
    } else if (current) {
      const previous = current.exercises.find(old => old.id === exercise.replacesId)
      if (!previous || previous.completed || replaced.has(previous.id) || next.exercises.some(item => item.id === previous.id)) throw new BackendError('INVALID_EXERCISE_ID', 400)
      replaced.add(previous.id)
    }
    validateLoad(snapshot, exercise, evidence)
    const availability = exerciseAvailability(snapshot, exercise)
    if (availability === 'unavailable') throw new BackendError('EQUIPMENT_UNAVAILABLE', 409)
    if (availability === 'temporarily_occupied') occupiedSeen = true
    else { if (occupiedSeen) throw new BackendError('OCCUPIED_ORDER_INVALID', 409); availableCount += 1 }
    exercise.equipmentStatus = availability
  }
  if (!next.exercises.some(exercise => !exercise.completed)) throw new BackendError('EMPTY_WORKOUT', 400)
  if (!availableCount) throw new BackendError('EQUIPMENT_OCCUPIED', 200)
  if (next.estimatedMinutes < minimumWorkoutMinutes(next.exercises) || next.estimatedMinutes > snapshot.conditions.availableMinutes) throw new BackendError('WORKOUT_TIME_EXCEEDED', 400)
  next.version = (current?.version ?? 0) + 1
  next.source = 'agent_proposal'
  return next
}
