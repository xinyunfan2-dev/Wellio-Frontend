import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {ActionInput, ActionRequest, ActionResult, Snapshot} from '../../src/lib/contracts'
import {createBackend} from '../../src/server/app'

type Backend = ReturnType<typeof createBackend>
type Session = {cookie: string; snapshot: Snapshot}

describe('Stage 2 workout progress over HTTP and persistent SQLite', () => {
  let directory: string
  let databasePath: string
  let backend: Backend
  let sequence = 0
  const opened = new Set<Backend>()

  function open() {
    const instance = createBackend({databasePath, cookieSecure: false})
    opened.add(instance)
    return instance
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-workout-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    backend = open()
    sequence = 0
  })

  afterEach(() => {
    for (const instance of opened) instance.close()
    opened.clear()
    rmSync(directory, {recursive: true, force: true})
  })

  async function send(path: string, init?: RequestInit) {
    const response = await backend.handleRequest(new Request(`http://localhost${path}`, init))
    expect(response.headers.get('cache-control')).toMatch(/no-store/i)
    return response
  }

  async function session(): Promise<Session> {
    const response = await send('/api/state')
    expect(response.status).toBe(200)
    return {cookie: response.headers.get('set-cookie')!.split(';')[0], snapshot: await response.json() as Snapshot}
  }

  async function state(cookie: string): Promise<Snapshot> {
    const response = await send('/api/state', {headers: {cookie}})
    expect(response.status).toBe(200)
    return await response.json() as Snapshot
  }

  function envelope<T extends ActionInput>(snapshot: Snapshot, input: T): T & Pick<ActionRequest, 'requestId' | 'resetEpoch' | 'source'> {
    return {...input, requestId: `workout-request-${++sequence}`, resetEpoch: snapshot.resetEpoch, source: 'workout'}
  }

  async function post(cookie: string, body: unknown) {
    const response = await send('/api/actions', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(body)})
    return {response, result: await response.json() as ActionResult}
  }

  async function succeed(cookie: string, body: ActionRequest): Promise<ActionResult & {snapshot: Snapshot}> {
    const {response, result} = await post(cookie, body)
    expect(response.status).toBe(200)
    expect(result).toMatchObject({requestId: body.requestId, status: 'succeeded'})
    expect(result.snapshot).toBeDefined()
    return result as ActionResult & {snapshot: Snapshot}
  }

  function startRequest(snapshot: Snapshot) {
    return envelope(snapshot, {kind: 'start_workout', workoutId: snapshot.workout!.id, expectedWorkoutVersion: snapshot.workout!.version})
  }

  function exerciseRequest(snapshot: Snapshot, kind: 'complete_exercise' | 'undo_exercise', index = 0) {
    return envelope(snapshot, {kind, workoutId: snapshot.workout!.id, exerciseId: snapshot.workout!.exercises[index].id, expectedWorkoutVersion: snapshot.workout!.version})
  }

  function finishRequest(snapshot: Snapshot, confirmIncomplete: boolean, actualMinutes = 27) {
    return envelope(snapshot, {kind: 'finish_workout', workoutId: snapshot.workout!.id, expectedWorkoutVersion: snapshot.workout!.version, actualMinutes, confirmIncomplete})
  }

  it('starts the saved workout and its plan entry without recording completed training', async () => {
    const original = await session()
    const started = await succeed(original.cookie, startRequest(original.snapshot))
    expect(started.snapshot.workout).toMatchObject({id: original.snapshot.workout!.id, status: 'in_progress', version: original.snapshot.workout!.version + 1})
    expect(Number.isFinite(Date.parse(started.snapshot.workout!.startedAt!))).toBe(true)
    expect(started.snapshot.workout!.exercises).toEqual(original.snapshot.workout!.exercises)
    expect(started.snapshot.plan.sessions.find(item => item.id === original.snapshot.workout!.trainingSessionId)?.status).toBe('in_progress')
    expect(started.snapshot.history).toEqual(original.snapshot.history)
    expect(started.snapshot.profile.expenditure).toBe(2500)
    expect(await state(original.cookie)).toEqual(started.snapshot)
  })

  it('completes and undoes exactly one exercise while preserving the other exercises and history', async () => {
    const original = await session()
    const started = await succeed(original.cookie, startRequest(original.snapshot))
    const completed = await succeed(original.cookie, exerciseRequest(started.snapshot, 'complete_exercise', 1))
    expect(completed.snapshot.workout!.exercises.map(exercise => exercise.completed)).toEqual([false, true, false])
    expect(completed.snapshot.workout!.version).toBe(started.snapshot.workout!.version + 1)
    expect(completed.snapshot.workout!.status).toBe('in_progress')
    expect(completed.snapshot.history).toEqual(original.snapshot.history)
    const undone = await succeed(original.cookie, exerciseRequest(completed.snapshot, 'undo_exercise', 1))
    expect(undone.snapshot.workout!.exercises).toEqual(started.snapshot.workout!.exercises)
    expect(undone.snapshot.workout!.version).toBe(completed.snapshot.workout!.version + 1)
    expect(undone.snapshot.history).toEqual(original.snapshot.history)
    expect(await state(original.cookie)).toEqual(undone.snapshot)
  })

  it('replays a previous start or completion without overwriting newer progress', async () => {
    const original = await session()
    const start = startRequest(original.snapshot)
    const started = await succeed(original.cookie, start)
    const complete = exerciseRequest(started.snapshot, 'complete_exercise')
    const completed = await succeed(original.cookie, complete)
    const undone = await succeed(original.cookie, exerciseRequest(completed.snapshot, 'undo_exercise'))
    expect(await succeed(original.cookie, start)).toEqual(started)
    expect(await succeed(original.cookie, complete)).toEqual(completed)
    expect(await state(original.cookie)).toEqual(undone.snapshot)
  })

  it('requires explicit confirmation before finishing a workout with incomplete exercises', async () => {
    const original = await session()
    const started = await succeed(original.cookie, startRequest(original.snapshot))
    const completed = await succeed(original.cookie, exerciseRequest(started.snapshot, 'complete_exercise'))
    const {response, result} = await post(original.cookie, finishRequest(completed.snapshot, false))
    expect(response.status).toBe(200)
    expect(result.status).toBe('needs_input')
    expect(result.errorCode).toBe('INCOMPLETE_CONFIRMATION_REQUIRED')
    expect(await state(original.cookie)).toEqual(completed.snapshot)

    const finished = await succeed(original.cookie, finishRequest(completed.snapshot, true))
    expect(finished.snapshot.workout).toMatchObject({status: 'completed', actualMinutes: 27})
    expect(Number.isFinite(Date.parse(finished.snapshot.workout!.endedAt!))).toBe(true)
    expect(finished.snapshot.workout!.exercises.map(exercise => exercise.completed)).toEqual([true, false, false])
    expect(finished.snapshot.plan.sessions.find(item => item.id === original.snapshot.workout!.trainingSessionId)?.status).toBe('completed')
    expect(finished.snapshot.plan.pendingSessionIds).not.toContain(original.snapshot.workout!.trainingSessionId)
    expect(finished.snapshot.history.training.slice(0, -1)).toEqual(original.snapshot.history.training)
    expect(finished.snapshot.history.training.at(-1)).toMatchObject({date: original.snapshot.dayKey, minutes: 27})
    expect(finished.snapshot.history.training.reduce((sum, day) => sum + day.minutes, 0)).toBe(297)
    expect(finished.snapshot.history.load).toEqual(original.snapshot.history.load)
    expect(finished.snapshot.history.weight).toEqual(original.snapshot.history.weight)
    expect(finished.snapshot.history.nutrition).toEqual(original.snapshot.history.nutrition)
    expect(finished.snapshot.profile).toEqual(original.snapshot.profile)
  })

  it('finishes all completed exercises without extra confirmation and commits concurrent retries only once', async () => {
    const original = await session()
    let current = (await succeed(original.cookie, startRequest(original.snapshot))).snapshot
    for (let index = 0; index < current.workout!.exercises.length; index += 1) {
      current = (await succeed(original.cookie, exerciseRequest(current, 'complete_exercise', index))).snapshot
    }
    const body = finishRequest(current, false, 31)
    const results = await Promise.all(Array.from({length: 8}, () => succeed(original.cookie, body)))
    for (const result of results) expect(result).toEqual(results[0])
    expect(results[0].snapshot.workout!.exercises.every(exercise => exercise.completed)).toBe(true)
    expect(results[0].snapshot.history.training).toHaveLength(original.snapshot.history.training.length + 1)
    expect(results[0].snapshot.history.training.at(-1)).toMatchObject({date: original.snapshot.dayKey, minutes: 31})
    expect(results[0].snapshot.history.load).toEqual(original.snapshot.history.load)
    backend.close()
    opened.delete(backend)
    backend = open()
    expect(await succeed(original.cookie, body)).toEqual(results[0])
    expect(await state(original.cookie)).toEqual(results[0].snapshot)
  })

  it('treats repeated current-state progress as a no-op while preserving original timestamps and versions', async () => {
    const original = await session()
    const started = await succeed(original.cookie, startRequest(original.snapshot))
    expect((await succeed(original.cookie, startRequest(started.snapshot))).snapshot).toEqual(started.snapshot)
    const undoneBeforeCompletion = await succeed(original.cookie, exerciseRequest(started.snapshot, 'undo_exercise'))
    expect(undoneBeforeCompletion.snapshot).toEqual(started.snapshot)
    const completed = await succeed(original.cookie, exerciseRequest(started.snapshot, 'complete_exercise'))
    expect((await succeed(original.cookie, exerciseRequest(completed.snapshot, 'complete_exercise'))).snapshot).toEqual(completed.snapshot)
    const undone = await succeed(original.cookie, exerciseRequest(completed.snapshot, 'undo_exercise'))
    expect((await succeed(original.cookie, exerciseRequest(undone.snapshot, 'undo_exercise'))).snapshot).toEqual(undone.snapshot)
    expect(await state(original.cookie)).toEqual(undone.snapshot)
  })

  it('does not double count a completed workout under new request IDs or permit changing its recorded duration', async () => {
    const original = await session()
    const started = await succeed(original.cookie, startRequest(original.snapshot))
    const finished = await succeed(original.cookie, finishRequest(started.snapshot, true, 27))
    const duplicate = await succeed(original.cookie, finishRequest(finished.snapshot, true, 27))
    expect(duplicate.snapshot).toEqual(finished.snapshot)
    const altered = await post(original.cookie, finishRequest(finished.snapshot, true, 30))
    expect(altered.response.status).toBe(409)
    expect(altered.result).toMatchObject({status: 'conflict', errorCode: 'WORKOUT_STATE_CONFLICT'})
    expect(await state(original.cookie)).toEqual(finished.snapshot)
  })

  it('rejects stale workout versions and leaves the current progress intact', async () => {
    const original = await session()
    const futureVersion = {...startRequest(original.snapshot), expectedWorkoutVersion: original.snapshot.workout!.version + 1}
    const future = await post(original.cookie, futureVersion)
    expect(future.response.status).toBe(409)
    expect(future.result).toMatchObject({status: 'conflict', errorCode: 'VERSION_CONFLICT'})
    expect(await state(original.cookie)).toEqual(original.snapshot)
    const started = await succeed(original.cookie, startRequest(original.snapshot))
    for (const body of [exerciseRequest(original.snapshot, 'complete_exercise'), finishRequest(original.snapshot, true)]) {
      const stale = await post(original.cookie, body)
      expect(stale.response.status).toBe(409)
      expect(stale.result).toMatchObject({status: 'conflict', errorCode: 'VERSION_CONFLICT'})
    }
    expect(await state(original.cookie)).toEqual(started.snapshot)
  })

  it('does not allow exercise progress or finishing before a workout starts, or progress after it finishes', async () => {
    const original = await session()
    for (const body of [exerciseRequest(original.snapshot, 'complete_exercise'), exerciseRequest(original.snapshot, 'undo_exercise'), finishRequest(original.snapshot, true)]) {
      const rejected = await post(original.cookie, body)
      expect(rejected.response.status).toBe(409)
      expect(rejected.result.status).toBe('conflict')
    }
    expect(await state(original.cookie)).toEqual(original.snapshot)
    const started = await succeed(original.cookie, startRequest(original.snapshot))
    const finished = await succeed(original.cookie, finishRequest(started.snapshot, true))
    for (const body of [startRequest(finished.snapshot), exerciseRequest(finished.snapshot, 'complete_exercise'), exerciseRequest(finished.snapshot, 'undo_exercise')]) {
      const rejected = await post(original.cookie, body)
      expect(rejected.response.status).toBe(409)
      expect(rejected.result.status).toBe('conflict')
    }
    expect(await state(original.cookie)).toEqual(finished.snapshot)
  })

  it('keeps workout progress and request identities scoped to the cookie session', async () => {
    const first = await session()
    const second = await session()
    const sharedRequest = startRequest(first.snapshot)
    const firstStarted = await succeed(first.cookie, sharedRequest)
    const firstCompleted = await succeed(first.cookie, exerciseRequest(firstStarted.snapshot, 'complete_exercise'))
    expect(await state(second.cookie)).toEqual(second.snapshot)
    const secondStarted = await succeed(second.cookie, sharedRequest)
    expect(secondStarted.snapshot.sessionId).toBe(second.snapshot.sessionId)
    expect(secondStarted.snapshot.workout!.exercises.every(exercise => !exercise.completed)).toBe(true)
    expect(await state(first.cookie)).toEqual(firstCompleted.snapshot)
  })

  it('rejects old-epoch progress after reset, including previously successful request IDs', async () => {
    const original = await session()
    const start = startRequest(original.snapshot)
    const started = await succeed(original.cookie, start)
    const oldCompletion = exerciseRequest(started.snapshot, 'complete_exercise')
    const reset = await succeed(original.cookie, envelope(started.snapshot, {kind: 'reset_demo', scenario: 'low_recovery'}))
    for (const body of [start, oldCompletion, finishRequest(started.snapshot, true)]) {
      const rejected = await post(original.cookie, body)
      expect(rejected.response.status).toBe(409)
      expect(rejected.result).toMatchObject({status: 'conflict', errorCode: 'STALE_EPOCH'})
    }
    expect(await state(original.cookie)).toEqual(reset.snapshot)
    expect(reset.snapshot.workout!.status).toBe('planned')
    expect(reset.snapshot.history).toEqual(original.snapshot.history)
  })

  it('rejects missing entities and client-injected training facts', async () => {
    const original = await session()
    const missingWorkout = await post(original.cookie, {...startRequest(original.snapshot), workoutId: 'absent-workout'})
    expect(missingWorkout.response.status).toBe(404)
    expect(missingWorkout.result.errorCode).toBe('NOT_FOUND')
    const started = await succeed(original.cookie, startRequest(original.snapshot))
    const missingExercise = await post(original.cookie, {...exerciseRequest(started.snapshot, 'complete_exercise'), exerciseId: 'absent-exercise'})
    expect(missingExercise.response.status).toBe(404)
    expect(missingExercise.result.errorCode).toBe('NOT_FOUND')
    for (const extra of [{completed: true}, {history: []}, {sessionId: 'another-session'}, {actualMinutes: 12}]) {
      const invalid = await post(original.cookie, {...exerciseRequest(started.snapshot, 'complete_exercise'), ...extra})
      expect(invalid.response.status).toBe(400)
      expect(invalid.result.errorCode).toBe('INVALID_INPUT')
    }
    for (const actualMinutes of [0, -1, 0.5, 1441]) {
      const invalid = await post(original.cookie, {...finishRequest(started.snapshot, true), actualMinutes})
      expect(invalid.response.status).toBe(400)
      expect(invalid.result.errorCode).toBe('INVALID_INPUT')
    }
    expect(await state(original.cookie)).toEqual(started.snapshot)
  })
})
