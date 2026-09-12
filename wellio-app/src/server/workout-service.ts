import { randomUUID } from 'node:crypto'
import type { ActionRequest, Snapshot, Workout } from '../lib/contracts'
import type { MutationOutcome, WellioDatabase } from './database'
import { BackendError } from './errors'
import { exerciseAvailability } from './workout-validation'
import { parseAction } from './validation'

export type ProgressRequest = Extract<ActionRequest, { kind: 'start_workout' | 'complete_exercise' | 'undo_exercise' | 'finish_workout' }>

export function invalidateWorkoutAdvice(snapshot: Snapshot): void {
  for (const proposal of snapshot.proposals) if (proposal.status === 'pending') proposal.status = 'stale'
  if (snapshot.advice.status === 'valid') snapshot.advice.status = 'stale'
}

/** Without a persisted focus event, only one unfinished exercise is unambiguous. */
export function resolveExerciseTarget(snapshot: Snapshot, exerciseId?: string): string {
  if (exerciseId) {
    if (!snapshot.workout?.exercises.some(exercise => exercise.id === exerciseId)) throw new BackendError('NOT_FOUND', 404)
    return exerciseId
  }
  const remaining = snapshot.workout?.exercises.filter(exercise => !exercise.completed) ?? []
  if (remaining.length !== 1) throw new BackendError('EXERCISE_TARGET_REQUIRED', 200)
  return remaining[0].id
}

function assertToday(snapshot: Snapshot, workout: Workout): void {
  const session = snapshot.plan.sessions.find(session => session.id === workout.trainingSessionId)
  if (!session || session.workoutId !== workout.id || session.date !== snapshot.dayKey || workout.dayKey !== snapshot.dayKey || !session.slotId || snapshot.plan.restDates.includes(snapshot.dayKey)) throw new BackendError('WORKOUT_NOT_SCHEDULED', 409)
  return
}

/** Pure synchronous transition used by buttons, future tools, and Apply's continuation. */
export function transitionWorkout(snapshot: Snapshot, request: ProgressRequest): MutationOutcome {
  const workout = snapshot.workout
  if (!workout || workout.id !== request.workoutId) throw new BackendError('NOT_FOUND', 404)
  if (workout.version !== request.expectedWorkoutVersion) throw new BackendError('VERSION_CONFLICT', 409)
  assertToday(snapshot, workout)
  const session = snapshot.plan.sessions.find(session => session.id === workout.trainingSessionId)!
  const success = () => ({ httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded' as const, snapshot } })
  if (request.kind === 'start_workout') {
    if (workout.status === 'in_progress' && session.status === 'in_progress') return success()
    if (workout.status !== 'planned' || session.status !== 'pending') throw new BackendError('WORKOUT_STATE_CONFLICT', 409)
    if (workout.gymId !== snapshot.conditions.gymId) throw new BackendError('CONDITIONS_CHANGED', 409)
    if (workout.estimatedMinutes > snapshot.conditions.availableMinutes) throw new BackendError('WORKOUT_TIME_EXCEEDED', 409)
    if (workout.exercises.some(exercise => !exercise.completed && exerciseAvailability(snapshot, exercise) === 'unavailable')) throw new BackendError('EQUIPMENT_UNAVAILABLE', 409)
    const first = workout.exercises.find(exercise => !exercise.completed)
    if (!first) throw new BackendError('EMPTY_WORKOUT', 409)
    const availability = exerciseAvailability(snapshot, first)
    if (availability !== 'available') throw new BackendError(availability === 'unavailable' ? 'EQUIPMENT_UNAVAILABLE' : 'EQUIPMENT_OCCUPIED', 409)
    workout.status = 'in_progress'
    workout.startedAt = new Date().toISOString()
    session.status = 'in_progress'
    snapshot.plan.pendingSessionIds = snapshot.plan.pendingSessionIds.filter(id => id !== session.id)
    snapshot.plan.version += 1
  } else if (request.kind === 'finish_workout') {
    if (workout.status === 'completed' && workout.actualMinutes === request.actualMinutes) return success()
    if (workout.status !== 'in_progress' || session.status !== 'in_progress') throw new BackendError('WORKOUT_STATE_CONFLICT', 409)
    if (workout.exercises.some(exercise => !exercise.completed) && !request.confirmIncomplete) return { httpStatus: 200, result: { requestId: request.requestId, status: 'needs_input', errorCode: 'INCOMPLETE_CONFIRMATION_REQUIRED', snapshot } }
    workout.status = 'completed'
    workout.endedAt = new Date().toISOString()
    workout.actualMinutes = request.actualMinutes
    session.status = 'completed'
    snapshot.plan.pendingSessionIds = snapshot.plan.pendingSessionIds.filter(id => id !== session.id)
    snapshot.plan.version += 1
    if (snapshot.history.training.some(record => record.workoutId === workout.id || record.trainingSessionId === session.id)) throw new BackendError('WORKOUT_STATE_CONFLICT', 409)
    snapshot.history.training.push({ date: snapshot.dayKey, type: session.split, minutes: request.actualMinutes, workoutId: workout.id, trainingSessionId: session.id })
  } else {
    if (workout.status !== 'in_progress' || session.status !== 'in_progress') throw new BackendError('WORKOUT_STATE_CONFLICT', 409)
    const exercise = workout.exercises.find(exercise => exercise.id === request.exerciseId)
    if (!exercise) throw new BackendError('NOT_FOUND', 404)
    const completed = request.kind === 'complete_exercise'
    if (exercise.completed === completed) return success()
    exercise.completed = completed
  }
  workout.version += 1
  snapshot.revision += 1
  invalidateWorkoutAdvice(snapshot)
  return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', operationId: randomUUID() }, snapshot }
}

export function recordWorkoutProgress(database: WellioDatabase, sessionId: string, request: ProgressRequest) {
  const validated = parseAction(request)
  if (!['start_workout', 'complete_exercise', 'undo_exercise', 'finish_workout'].includes(validated.kind)) throw new BackendError('INVALID_INPUT', 400)
  if (!['today', 'agent', 'workout'].includes(validated.source)) throw new BackendError('WORKOUT_REQUIRES_USER_ACTION', 403)
  return database.mutate(sessionId, validated, snapshot => transitionWorkout(snapshot, validated as ProgressRequest))
}
