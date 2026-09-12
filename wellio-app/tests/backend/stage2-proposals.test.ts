import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {ActionInput, ActionRequest, ActionResult, Exercise, LocalizedText, Snapshot, Workout} from '../../src/lib/contracts'
import {createBackend} from '../../src/server/app'
import {WellioDatabase} from '../../src/server/database'
import type {StoredReply} from '../../src/server/database'
import {BackendError} from '../../src/server/errors'
import {applyProposalPhase, proposeWorkout} from '../../src/server/proposals'
import {SessionCookies} from '../../src/server/session'

const reason: LocalizedText = {en: 'Adjust the remaining workout to the available time.', 'zh-CN': '根据剩余时间调整尚未完成的训练。'}

describe('Stage 2 trusted proposals and explicit HTTP application', () => {
  let directory: string
  let databasePath: string
  let database: WellioDatabase
  let backend: ReturnType<typeof createBackend>
  let initial: Snapshot
  let cookie: string
  let sequence = 0

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-proposal-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    database = new WellioDatabase(databasePath)
    backend = createBackend({databasePath, cookieSecure: false})
    initial = database.createSession(Date.now() + 300_000)
    cookie = new SessionCookies(database.signingKey).issue(initial.sessionId, Date.now() + 300_000, false).split(';')[0]
    sequence = 0
  })

  afterEach(() => {
    backend.close()
    database.close()
    rmSync(directory, {recursive: true, force: true})
  })

  const current = () => database.getSnapshot(initial.sessionId)

  function inspect<T>(run: (connection: DatabaseSync) => T): T {
    const connection = new DatabaseSync(databasePath)
    try { return run(connection) } finally { connection.close() }
  }

  function reopen() {
    backend.close()
    database.close()
    database = new WellioDatabase(databasePath)
    backend = createBackend({databasePath, cookieSecure: false})
  }

  function envelope<T extends ActionInput>(input: T): T & Pick<ActionRequest, 'requestId' | 'resetEpoch' | 'source'> {
    return {...input, requestId: `proposal-action-${++sequence}`, resetEpoch: current().resetEpoch, source: 'today'}
  }

  async function post(body: unknown, sessionCookie = cookie) {
    const response = await backend.handleRequest(new Request('http://localhost/api/actions', {
      method: 'POST', headers: {cookie: sessionCookie, 'content-type': 'application/json'}, body: JSON.stringify(body),
    }))
    expect(response.headers.get('cache-control')).toMatch(/no-store/i)
    return {httpStatus: response.status, result: await response.json() as ActionResult}
  }

  async function succeed(body: ActionRequest) {
    const reply = await post(body)
    expect(reply.httpStatus).toBe(200)
    expect(reply.result.status).toBe('succeeded')
    expect(reply.result.snapshot).toBeDefined()
    return reply.result as ActionResult & {snapshot: Snapshot}
  }

  function shortWorkout(snapshot = current()): Workout {
    return {...structuredClone(snapshot.workout!), name: {en: 'Short pull workout', 'zh-CN': '短时拉类训练'}, estimatedMinutes: 25, exercises: structuredClone(snapshot.workout!.exercises.slice(0, 2))}
  }

  function proposalInput(scope: 'workout' | 'schedule', workout?: Workout) {
    const snapshot = current()
    const runId = `proposal-run-${++sequence}`
    const context = database.captureContext(snapshot.sessionId, {runId, requestId: `context-request-${++sequence}`, resetEpoch: snapshot.resetEpoch})
    return {kind: 'propose_workout' as const, requestId: `trusted-proposal-${++sequence}`, resetEpoch: snapshot.resetEpoch, runId, contextReadId: context.id, scope, reason, ...(workout ? {workout} : {})}
  }

  function propose(input: ReturnType<typeof proposalInput>, sessionId = initial.sessionId): StoredReply {
    try { return proposeWorkout(database, sessionId, input) } catch (error) {
      if (!(error instanceof BackendError)) throw error
      return {httpStatus: error.httpStatus, result: {requestId: input.requestId, status: error.httpStatus === 409 ? 'conflict' : 'failed', errorCode: error.code}}
    }
  }

  function proposed(scope: 'workout' | 'schedule' = 'workout', workout = scope === 'workout' ? shortWorkout() : undefined) {
    const input = proposalInput(scope, workout)
    const reply = propose(input)
    expect(reply.httpStatus).toBe(200)
    expect(reply.result.status).toBe('succeeded')
    const proposalId = (reply.result as ActionResult & {proposalId?: string}).proposalId
    expect(proposalId).toBeTruthy()
    const proposal = reply.result.snapshot!.proposals.find(item => item.id === proposalId)!
    expect(proposal).toBeDefined()
    return {input, reply, proposal}
  }

  // Fixture mutation represents changed trusted input; the product has no test-only HTTP endpoint.
  function patchSnapshot(edit: (snapshot: Snapshot) => void) {
    const snapshot = current()
    edit(snapshot)
    snapshot.revision += 1
    const connection = new DatabaseSync(databasePath)
    try {
      connection.prepare('UPDATE sessions SET snapshot_json = ?, reset_epoch = ?, revision = ? WHERE id = ?').run(JSON.stringify(snapshot), snapshot.resetEpoch, snapshot.revision, snapshot.sessionId)
    } finally { connection.close() }
    return snapshot
  }

  async function startAndCompleteFirst() {
    const workout = current().workout!
    await succeed(envelope({kind: 'start_workout', workoutId: workout.id, expectedWorkoutVersion: workout.version}))
    const started = current().workout!
    await succeed(envelope({kind: 'complete_exercise', workoutId: started.id, exerciseId: started.exercises[0].id, expectedWorkoutVersion: started.version}))
    return current()
  }

  async function lowRecovery() {
    await succeed(envelope({kind: 'reset_demo', scenario: 'low_recovery'}))
    return current()
  }

  it('persists a contextual candidate without applying it and applies it only after an explicit action', async () => {
    const candidate = shortWorkout()
    const originalCandidate = structuredClone(candidate)
    const {input, reply, proposal} = proposed('workout', candidate)
    expect(candidate).toEqual(originalCandidate)
    expect(proposal).toMatchObject({scope: 'workout', status: 'pending', contextReadId: input.contextReadId, readinessSnapshotId: initial.readiness.id})
    expect(proposal.expected).toEqual({meal: initial.mealRevision, plan: initial.plan.version, workout: initial.workout!.version, conditions: initial.conditions.version, readiness: initial.readiness.version})
    expect(current().workout).toEqual(initial.workout)
    expect(current().plan).toEqual(initial.plan)
    expect(current().history).toEqual(initial.history)
    expect(propose(input)).toEqual(reply)
    expect(current().proposals).toHaveLength(1)
    reopen()
    expect(current().proposals.find(item => item.id === proposal.id)).toEqual(proposal)

    const apply = envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false})
    const applied = await succeed(apply)
    expect(applied).toMatchObject({applyStatus: 'succeeded', startStatus: 'not_requested'})
    expect(applied.snapshot.workout).toMatchObject({id: initial.workout!.id, trainingSessionId: initial.workout!.trainingSessionId, status: 'planned', source: 'agent_proposal', name: candidate.name, estimatedMinutes: 25})
    expect(applied.snapshot.workout!.exercises).toMatchObject(candidate.exercises)
    expect(applied.snapshot.workout!.exercises.every(exercise => exercise.equipmentStatus === 'available')).toBe(true)
    expect(applied.snapshot.workout!.startedAt).toBeUndefined()
    expect(applied.snapshot.proposals.find(item => item.id === proposal.id)?.status).toBe('applied')
    expect(applied.snapshot.history).toEqual(initial.history)
    expect(await succeed(apply)).toEqual(applied)
    expect(current()).toEqual(applied.snapshot)
    const duplicateApply = await post(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false}))
    expect(duplicateApply.httpStatus).toBe(409)
    expect(duplicateApply.result.errorCode).toBe('PROPOSAL_ALREADY_APPLIED')
    expect(current()).toEqual(applied.snapshot)
  })

  it('dismisses a candidate without changing the saved workout and prevents later application', async () => {
    const {proposal} = proposed()
    const dismissed = await succeed(envelope({kind: 'dismiss_proposal', proposalId: proposal.id}))
    expect(dismissed.snapshot.proposals.find(item => item.id === proposal.id)?.status).toBe('dismissed')
    expect(dismissed.snapshot.workout).toEqual(initial.workout)
    expect(dismissed.snapshot.history).toEqual(initial.history)
    reopen()
    const rejected = await post(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true}))
    expect(rejected.httpStatus).toBe(409)
    expect(current().workout).toEqual(initial.workout)
    expect(current().proposals.find(item => item.id === proposal.id)?.status).toBe('dismissed')
  })

  it('saves and then starts a workout when Apply explicitly requests both operations', async () => {
    const candidate = shortWorkout()
    const {proposal} = proposed('workout', candidate)
    const applied = await succeed(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true}))
    expect(applied).toMatchObject({applyStatus: 'succeeded', startStatus: 'succeeded'})
    expect(applied.snapshot.workout).toMatchObject({id: initial.workout!.id, status: 'in_progress', name: candidate.name})
    expect(applied.snapshot.workout!.exercises).toMatchObject(candidate.exercises)
    expect(Number.isFinite(Date.parse(applied.snapshot.workout!.startedAt!))).toBe(true)
    expect(applied.snapshot.history).toEqual(initial.history)
    expect(current()).toEqual(applied.snapshot)
  })

  it('resumes only Start after reopening a committed Apply checkpoint', async () => {
    const {proposal} = proposed()
    const body = envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true})
    const checkpoint = applyProposalPhase(database, initial.sessionId, body)
    expect(checkpoint.httpStatus).toBe(200)
    expect(checkpoint.result.applyStatus).toBe('succeeded')
    expect(checkpoint.result.startStatus).toBe('not_started')
    expect(checkpoint.continuation).toMatchObject({kind: 'start_workout', workoutId: initial.workout!.id})
    const saved = current()
    expect(saved.workout!.status).toBe('planned')
    expect(saved.proposals.find(item => item.id === proposal.id)?.status).toBe('applied')
    reopen()
    const resumed = await succeed(body)
    expect(resumed).toMatchObject({applyStatus: 'succeeded', startStatus: 'succeeded', operationId: checkpoint.result.operationId})
    expect(resumed.snapshot.workout!.version).toBe(saved.workout!.version + 1)
    expect(resumed.snapshot.revision).toBe(saved.revision + 1)
    expect(resumed.snapshot.workout!.status).toBe('in_progress')
    expect(resumed.snapshot.workout!.exercises).toEqual(saved.workout!.exercises)
    expect(resumed.snapshot.proposals).toEqual(saved.proposals)
    expect(resumed.snapshot.history).toEqual(saved.history)
    expect(await succeed(body)).toEqual(resumed)
    expect(current()).toEqual(resumed.snapshot)
  })

  it('keeps Apply saved when a newer workout version prevents the pending Start', async () => {
    const {proposal} = proposed()
    const body = envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true})
    const checkpoint = applyProposalPhase(database, initial.sessionId, body)
    const newer = patchSnapshot(snapshot => {
      snapshot.workout!.version += 1
      snapshot.workout!.estimatedMinutes = 24
    })
    reopen()
    const failed = await post(body)
    expect(failed.httpStatus).toBe(200)
    expect(failed.result).toMatchObject({status: 'failed', errorCode: 'VERSION_CONFLICT', applyStatus: 'succeeded', startStatus: 'failed', operationId: checkpoint.result.operationId})
    expect(failed.result.snapshot).toEqual(newer)
    expect(current()).toEqual(newer)
    expect(current().proposals.find(item => item.id === proposal.id)?.status).toBe('applied')
    expect(await post(body)).toEqual(failed)
    const workout = current().workout!
    const retried = await succeed(envelope({kind: 'start_workout', workoutId: workout.id, expectedWorkoutVersion: workout.version}))
    expect(retried.snapshot.workout!.status).toBe('in_progress')
    expect(retried.snapshot.workout!.estimatedMinutes).toBe(24)
    expect(retried.snapshot.proposals).toEqual(newer.proposals)
  })

  it('reports saved Apply and failed Start when the first equipment becomes occupied, then allows explicit retry', async () => {
    const {proposal} = proposed()
    const body = envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true})
    applyProposalPhase(database, initial.sessionId, body)
    const occupied = patchSnapshot(snapshot => {
      snapshot.conditions.equipmentStatus = {'gym-b-cable': 'temporarily_occupied'}
      snapshot.conditions.version += 1
    })
    const failed = await post(body)
    expect(failed.httpStatus).toBe(200)
    expect(failed.result).toMatchObject({status: 'failed', errorCode: 'EQUIPMENT_OCCUPIED', applyStatus: 'succeeded', startStatus: 'failed'})
    expect(failed.result.snapshot).toEqual(occupied)
    expect(current()).toEqual(occupied)
    expect(current().workout!.status).toBe('planned')
    expect(current().proposals.find(item => item.id === proposal.id)?.status).toBe('applied')
    patchSnapshot(snapshot => {
      snapshot.conditions.equipmentStatus = {'gym-b-cable': 'available'}
      snapshot.conditions.version += 1
    })
    const workout = current().workout!
    const retried = await succeed(envelope({kind: 'start_workout', workoutId: workout.id, expectedWorkoutVersion: workout.version}))
    expect(retried.snapshot.workout!.status).toBe('in_progress')
    expect(retried.snapshot.workout!.exercises).toEqual(occupied.workout!.exercises)
    expect(retried.snapshot.history).toEqual(occupied.history)
  })

  it('rolls back a failed Start transaction while retaining the Apply checkpoint for a later replay', async () => {
    const {proposal} = proposed()
    const body = envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true})
    const checkpoint = applyProposalPhase(database, initial.sessionId, body)
    const saved = current()
    inspect(connection => connection.exec(`CREATE TRIGGER reject_start BEFORE UPDATE ON sessions
      WHEN json_extract(NEW.snapshot_json, '$.workout.status') = 'in_progress'
      BEGIN SELECT RAISE(ABORT, 'forced Start storage failure'); END;`))
    const failed = await post(body)
    expect(failed.httpStatus).toBe(200)
    expect(failed.result).toMatchObject({status: 'failed', errorCode: 'START_FAILED', applyStatus: 'succeeded', startStatus: 'failed', operationId: checkpoint.result.operationId})
    expect(failed.result.snapshot).toEqual(saved)
    expect(current()).toEqual(saved)
    const pending = inspect(connection => connection.prepare('SELECT continuation_json FROM action_requests WHERE session_id = ? AND request_id = ?').get(initial.sessionId, body.requestId)?.continuation_json)
    expect(pending).toBeTruthy()
    inspect(connection => connection.exec('DROP TRIGGER reject_start'))
    reopen()
    const resumed = await succeed(body)
    expect(resumed).toMatchObject({applyStatus: 'succeeded', startStatus: 'succeeded', operationId: checkpoint.result.operationId})
    expect(resumed.snapshot.workout!.status).toBe('in_progress')
    expect(resumed.snapshot.workout!.version).toBe(saved.workout!.version + 1)
    expect(resumed.snapshot.workout!.exercises).toEqual(saved.workout!.exercises)
    expect(resumed.snapshot.proposals).toEqual(saved.proposals)
    const completed = inspect(connection => connection.prepare('SELECT continuation_json FROM action_requests WHERE session_id = ? AND request_id = ?').get(initial.sessionId, body.requestId)?.continuation_json)
    expect(completed).toBeNull()
  })

  it('does not apply or start a candidate whose meal context became stale', async () => {
    const {proposal} = proposed()
    const updated = patchSnapshot(snapshot => {
      snapshot.mealRevision += 1
      snapshot.meals[0].version += 1
      snapshot.meals[0].items[0].consumedFraction = 0.5
    })
    const rejected = await post(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true}))
    expect(rejected.httpStatus).toBe(409)
    expect(rejected.result.errorCode).toBe('VERSION_CONFLICT')
    expect(current().workout).toEqual(updated.workout)
    expect(current().plan).toEqual(updated.plan)
    expect(current().meals).toEqual(updated.meals)
    expect(current().history).toEqual(updated.history)
    expect(current().proposals.find(item => item.id === proposal.id)?.status).not.toBe('applied')
  })

  it('rejects a foreign session context and a foreign proposal without exposing or applying it', async () => {
    const input = proposalInput('workout', shortWorkout())
    const other = database.createSession(Date.now() + 300_000)
    const foreignContext = propose(input, other.sessionId)
    expect(foreignContext.httpStatus).toBeGreaterThanOrEqual(400)
    expect(database.getSnapshot(other.sessionId)).toEqual(other)
    expect(current().proposals).toEqual([])
    const {proposal} = proposed()
    const otherCookie = new SessionCookies(database.signingKey).issue(other.sessionId, Date.now() + 300_000, false).split(';')[0]
    const foreignApply = await post({...envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true}), resetEpoch: other.resetEpoch}, otherCookie)
    expect(foreignApply.httpStatus).toBe(404)
    expect(foreignApply.result.errorCode).toBe('NOT_FOUND')
    expect(database.getSnapshot(other.sessionId)).toEqual(other)
    expect(current().workout).toEqual(initial.workout)
    expect(current().proposals.find(item => item.id === proposal.id)?.status).toBe('pending')
  })

  it('does not expose the trusted candidate-writing operation as a public HTTP action', async () => {
    const input = proposalInput('workout', shortWorkout())
    const rejected = await post({...input, source: 'agent'})
    expect(rejected.httpStatus).toBe(400)
    expect(rejected.result.errorCode).toBe('INVALID_INPUT')
    expect(current()).toEqual(initial)
    expect(current().proposals).toEqual([])
  })

  it('requires an explicit Today or Agent UI source for Apply and Dismiss', async () => {
    const {proposal} = proposed()
    const saved = current()
    for (const source of ['app_open', 'profile', 'workout'] as const) {
      for (const input of [
        {kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true} as const,
        {kind: 'dismiss_proposal', proposalId: proposal.id} as const,
      ]) {
        const rejected = await post({...envelope(input), source})
        expect(rejected.httpStatus).toBe(403)
        expect(rejected.result.errorCode).toBe('APPLY_REQUIRES_USER_ACTION')
        expect(current()).toEqual(saved)
      }
    }
    const applied = await succeed({...envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false}), source: 'agent'})
    expect(applied.applyStatus).toBe('succeeded')
    expect(applied.startStatus).toBe('not_requested')
    expect(applied.snapshot.workout!.status).toBe('planned')
  })

  it('rejects old contexts and old Apply actions after the session resets', async () => {
    const {input, proposal} = proposed()
    const oldApply = envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true})
    const reset = await succeed(envelope({kind: 'reset_demo', scenario: 'low_recovery'}))
    const oldProposal = propose(input)
    expect(oldProposal.httpStatus).toBe(409)
    expect(oldProposal.result.errorCode).toBe('STALE_EPOCH')
    const oldAction = await post(oldApply)
    expect(oldAction.httpStatus).toBe(409)
    expect(oldAction.result.errorCode).toBe('STALE_EPOCH')
    expect(current()).toEqual(reset.snapshot)
  })

  it.each(['remove', 'move', 'change', 'uncomplete', 'forge completed'] as const)('protects completed exercise facts when a candidate attempts to %s them', async violation => {
    const saved = await startAndCompleteFirst()
    const candidate = structuredClone(saved.workout!)
    if (violation === 'remove') candidate.exercises.shift()
    if (violation === 'move') candidate.exercises.push(candidate.exercises.shift()!)
    if (violation === 'change') candidate.exercises[0].reps += 1
    if (violation === 'uncomplete') candidate.exercises[0].completed = false
    if (violation === 'forge completed') candidate.exercises[1].completed = true
    const rejected = propose(proposalInput('workout', candidate))
    expect(rejected.httpStatus).toBe(409)
    expect(rejected.result.errorCode).toBe('COMPLETED_EXERCISE_IMMUTABLE')
    expect(current()).toEqual(saved)
  })

  it('can adjust unfinished work without losing a completed exercise or the original start time', async () => {
    const saved = await startAndCompleteFirst()
    const {proposal} = proposed('workout', shortWorkout(saved))
    const applied = await succeed(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false}))
    expect(applied.snapshot.workout!.exercises).toHaveLength(2)
    expect(applied.snapshot.workout!.exercises[0]).toEqual(saved.workout!.exercises[0])
    expect(applied.snapshot.workout!.startedAt).toBe(saved.workout!.startedAt)
    expect(applied.snapshot.workout!.status).toBe('in_progress')
    expect(applied.snapshot.history).toEqual(saved.history)
  })

  it('keeps an explicit replacement linked to the replaced exercise and matching equipment history', async () => {
    const candidate = structuredClone(initial.workout!)
    const old = candidate.exercises[2]
    const replacement: Exercise = {
      ...structuredClone(old), id: 'exercise-one-arm-row-01', catalogId: 'one-arm-dumbbell-row',
      name: {en: 'One-arm dumbbell row', 'zh-CN': '单臂哑铃划船'}, replacesId: old.id,
      animation: 'row', instructions: {en: 'Support one hand on the bench and pull with control.', 'zh-CN': '一只手支撑训练凳，控制划船动作。'},
      suggestedLoad: {value: 20, unit: 'kg', basis: 'per_hand', source: 'mock_history', sourceHistoryId: 'load-b-0910-row', reason},
    }
    candidate.exercises[2] = replacement
    const unlinked = structuredClone(candidate)
    delete unlinked.exercises[2].replacesId
    const rejected = propose(proposalInput('workout', unlinked))
    expect(rejected.httpStatus).toBe(400)
    expect(rejected.result.errorCode).toBe('INVALID_EXERCISE_ID')
    expect(current().workout).toEqual(initial.workout)
    const {proposal} = proposed('workout', candidate)
    const applied = await succeed(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false}))
    expect(applied.snapshot.workout!.exercises[2]).toMatchObject(replacement)
    expect(applied.snapshot.history.load).toEqual(initial.history.load)
  })

  it.each(['missing history', 'different sets', 'unverified user load'] as const)('returns needs_input for %s without inventing a proposal or changing the saved workout', condition => {
    if (condition === 'missing history') patchSnapshot(snapshot => { snapshot.history.load = snapshot.history.load.filter(record => record.exerciseId !== 'seated-cable-row') })
    const before = current()
    const candidate = shortWorkout(before)
    if (condition === 'different sets') candidate.exercises[0].sets += 1
    if (condition === 'unverified user load') candidate.exercises[0].suggestedLoad.source = 'user'
    const reply = propose(proposalInput('workout', candidate))
    expect(reply.httpStatus).toBe(200)
    expect(reply.result).toMatchObject({status: 'needs_input', errorCode: 'LOAD_CONFIRMATION_REQUIRED'})
    expect(current()).toEqual(before)
    expect(current().proposals).toEqual([])
  })

  it('rejects equipment from another gym and loads with an invalid step or basis', () => {
    const wrongGym = shortWorkout()
    wrongGym.gymId = 'gym-a'
    const equipmentReply = propose(proposalInput('workout', wrongGym))
    expect(equipmentReply.httpStatus).toBe(400)
    expect(equipmentReply.result.errorCode).toBe('INVALID_EQUIPMENT')
    for (const change of [{value: 37.5}, {basis: 'per_hand' as const}]) {
      const candidate = shortWorkout()
      Object.assign(candidate.exercises[0].suggestedLoad, change)
      const loadReply = propose(proposalInput('workout', candidate))
      expect(loadReply.httpStatus).toBe(400)
      expect(loadReply.result.errorCode).toBe('INVALID_LOAD')
    }
    expect(current()).toEqual(initial)
  })

  it('moves temporarily occupied equipment after available exercises and starts only the available first exercise', async () => {
    const occupied = patchSnapshot(snapshot => {
      snapshot.conditions.equipmentStatus = {'gym-b-cable': 'temporarily_occupied'}
      snapshot.conditions.version += 1
    })
    const wrongOrder = propose(proposalInput('workout', structuredClone(occupied.workout!)))
    expect(wrongOrder.httpStatus).toBe(409)
    expect(wrongOrder.result.errorCode).toBe('OCCUPIED_ORDER_INVALID')
    expect(current()).toEqual(occupied)
    const candidate = structuredClone(occupied.workout!)
    candidate.exercises = [candidate.exercises[2], candidate.exercises[0], candidate.exercises[1]]
    const {proposal} = proposed('workout', candidate)
    expect(proposal.workout!.exercises.map(exercise => exercise.equipmentStatus)).toEqual(['available', 'temporarily_occupied', 'temporarily_occupied'])
    expect(current().workout).toEqual(occupied.workout)
    const applied = await succeed(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true}))
    expect(applied.startStatus).toBe('succeeded')
    expect(applied.snapshot.workout!.exercises[0].catalogId).toBe('dumbbell-curl')
    expect(applied.snapshot.workout!.status).toBe('in_progress')
    expect(applied.snapshot.history).toEqual(occupied.history)
  })

  it('rejects unavailable equipment and candidates that exceed the trusted time budget', () => {
    const unavailable = patchSnapshot(snapshot => {
      snapshot.conditions.equipmentStatus = {'gym-b-cable': 'unavailable'}
      snapshot.conditions.version += 1
    })
    const equipmentReply = propose(proposalInput('workout', shortWorkout()))
    expect(equipmentReply.httpStatus).toBe(409)
    expect(equipmentReply.result.errorCode).toBe('EQUIPMENT_UNAVAILABLE')
    expect(current()).toEqual(unavailable)
    const limited = patchSnapshot(snapshot => {
      snapshot.conditions.equipmentStatus = {}
      snapshot.conditions.availableMinutes = 15
      snapshot.conditions.version += 1
    })
    const timeReply = propose(proposalInput('workout', shortWorkout()))
    expect(timeReply.httpStatus).toBe(400)
    expect(timeReply.result.errorCode).toBe('WORKOUT_TIME_EXCEEDED')
    expect(current()).toEqual(limited)
  })

  it('proposes and applies the documented low-recovery shift without rewriting workout contents or history', async () => {
    const saved = await lowRecovery()
    const {proposal} = proposed('schedule')
    expect(proposal).toMatchObject({scope: 'schedule', status: 'pending', restDate: '2026-09-12'})
    expect(proposal.moves?.map(move => [move.sessionId, move.from, move.to])).toEqual([
      ['planned-pull-01', '2026-09-12', '2026-09-14'], ['planned-legs-02', '2026-09-14', '2026-09-16'], ['planned-push-03', '2026-09-16', '2026-09-18'],
    ])
    expect(current().plan).toEqual(saved.plan)
    expect(current().workout).toEqual(saved.workout)
    const apply = envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false})
    const applied = await succeed(apply)
    expect(applied).toMatchObject({applyStatus: 'succeeded', startStatus: 'not_requested'})
    expect(applied.snapshot.plan.version).toBe(saved.plan.version + 1)
    expect(applied.snapshot.plan.sessions.map(item => [item.id, item.split, item.templateRef])).toEqual(saved.plan.sessions.map(item => [item.id, item.split, item.templateRef]))
    expect(applied.snapshot.plan.sessions.map(item => [item.date, item.slotId, item.status])).toEqual([
      ['2026-09-14', 'slot-0914', 'pending'], ['2026-09-16', 'slot-0916', 'pending'], ['2026-09-18', 'slot-0918', 'pending'],
    ])
    expect(applied.snapshot.plan.pendingSessionIds).toEqual(saved.plan.pendingSessionIds)
    expect(applied.snapshot.plan.restDates).toContain(saved.dayKey)
    expect(applied.snapshot.workout).toMatchObject({id: saved.workout!.id, trainingSessionId: saved.workout!.trainingSessionId, dayKey: '2026-09-14', status: 'planned'})
    expect(applied.snapshot.workout!.exercises).toEqual(saved.workout!.exercises)
    expect(applied.snapshot.history).toEqual(saved.history)
    expect(applied.snapshot.profile).toEqual(saved.profile)
    expect(await succeed(apply)).toEqual(applied)
    expect(current()).toEqual(applied.snapshot)
  })

  it('refuses to start a rest proposal and refuses to start the postponed workout today', async () => {
    const saved = await lowRecovery()
    const {proposal} = proposed('schedule')
    const rejected = await post(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: true}))
    expect(rejected.httpStatus).toBe(400)
    expect(current().plan).toEqual(saved.plan)
    expect(current().workout).toEqual(saved.workout)
    expect(current().proposals.find(item => item.id === proposal.id)?.status).toBe('pending')
    const applied = await succeed(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false}))
    const workout = applied.snapshot.workout!
    const cannotStart = await post(envelope({kind: 'start_workout', workoutId: workout.id, expectedWorkoutVersion: workout.version}))
    expect(cannotStart.httpStatus).toBe(409)
    expect(current().workout).toEqual(workout)
    expect(current().history).toEqual(saved.history)
  })

  it('keeps pending sessions in order with null dates when future slots run out', async () => {
    await lowRecovery()
    const saved = patchSnapshot(snapshot => {
      snapshot.plan.availableSlots = snapshot.plan.availableSlots.filter(slot => slot.date <= '2026-09-14')
      snapshot.plan.version += 1
    })
    const {proposal} = proposed('schedule')
    expect(proposal.moves?.map(move => move.to)).toEqual(['2026-09-14', null, null])
    const applied = await succeed(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false}))
    expect(applied.snapshot.plan.sessions.map(item => [item.id, item.date, item.slotId])).toEqual([
      ['planned-pull-01', '2026-09-14', 'slot-0914'], ['planned-legs-02', null, null], ['planned-push-03', null, null],
    ])
    expect(applied.snapshot.plan.pendingSessionIds).toEqual(saved.plan.pendingSessionIds)
    expect(applied.snapshot.plan.sessions.map(item => item.templateRef)).toEqual(saved.plan.sessions.map(item => item.templateRef))
    expect(applied.snapshot.history).toEqual(saved.history)
  })

  it.each(['same slot ID on different dates', 'invalid calendar date'] as const)('rejects %s without changing the stored plan', async invalidity => {
    await lowRecovery()
    const saved = patchSnapshot(snapshot => {
      snapshot.plan.availableSlots.push(invalidity === 'same slot ID on different dates'
        ? {id: snapshot.plan.availableSlots[0].id, date: '2026-09-30'}
        : {id: 'slot-invalid-date', date: '2026-09-99'})
      snapshot.plan.version += 1
    })
    const rejected = propose(proposalInput('schedule'))
    expect(rejected.httpStatus).toBe(409)
    expect(rejected.result).toMatchObject({status: 'conflict', errorCode: 'INVALID_SCHEDULE'})
    expect(current()).toEqual(saved)
    expect(current().proposals).toEqual([])
  })

  it('sorts shuffled slots by date, allocates one session per day, and preserves a busy non-target session', async () => {
    await lowRecovery()
    const saved = patchSnapshot(snapshot => {
      snapshot.plan.sessions.push({id: 'busy-session', split: 'Push', templateRef: 'busy-template', slotId: 'slot-0914', date: '2026-09-14', status: 'in_progress'})
      snapshot.plan.availableSlots = [
        {id: 'slot-0918', date: '2026-09-18'},
        {id: 'slot-0916-z', date: '2026-09-16'},
        {id: 'slot-0914', date: '2026-09-14'},
        {id: 'slot-0921', date: '2026-09-21'},
        {id: 'slot-0916-a', date: '2026-09-16'},
        {id: 'slot-0912', date: '2026-09-12'},
      ]
      snapshot.plan.version += 1
    })
    const {proposal} = proposed('schedule')
    expect(proposal.moves?.map(move => [move.sessionId, move.to])).toEqual([
      ['planned-pull-01', '2026-09-16'], ['planned-legs-02', '2026-09-18'], ['planned-push-03', '2026-09-21'],
    ])
    expect(current().plan).toEqual(saved.plan)
    const applied = await succeed(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false}))
    const targets = applied.snapshot.plan.sessions.filter(item => saved.plan.pendingSessionIds.includes(item.id))
    expect(targets.map(item => [item.id, item.date, item.slotId])).toEqual([
      ['planned-pull-01', '2026-09-16', 'slot-0916-a'],
      ['planned-legs-02', '2026-09-18', 'slot-0918'],
      ['planned-push-03', '2026-09-21', 'slot-0921'],
    ])
    expect(new Set(targets.map(item => item.date)).size).toBe(targets.length)
    expect(applied.snapshot.plan.sessions.find(item => item.id === 'busy-session')).toEqual(saved.plan.sessions.find(item => item.id === 'busy-session'))
    expect(applied.snapshot.plan.availableSlots).toEqual(saved.plan.availableSlots)
    expect(applied.snapshot.plan.pendingSessionIds).toEqual(saved.plan.pendingSessionIds)
    expect(applied.snapshot.workout!.dayKey).toBe('2026-09-16')
    expect(applied.snapshot.workout!.exercises).toEqual(saved.workout!.exercises)
    expect(applied.snapshot.history).toEqual(saved.history)
  })

  it('preserves every unassigned session and clears the workout date when no future slot exists', async () => {
    await lowRecovery()
    const saved = patchSnapshot(snapshot => {
      snapshot.plan.availableSlots = snapshot.plan.availableSlots.filter(slot => slot.date === snapshot.dayKey)
      snapshot.plan.version += 1
    })
    const {proposal} = proposed('schedule')
    expect(proposal.moves?.map(move => move.to)).toEqual([null, null, null])
    expect(proposal.unassignedSessionIds).toEqual(saved.plan.pendingSessionIds)
    const applied = await succeed(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false}))
    expect(applied.snapshot.plan.pendingSessionIds).toEqual(saved.plan.pendingSessionIds)
    expect(applied.snapshot.plan.sessions.map(item => [item.id, item.date, item.slotId, item.status])).toEqual(saved.plan.sessions.map(item => [item.id, null, null, 'pending']))
    expect(applied.snapshot.workout!.dayKey).toBeNull()
    expect(applied.snapshot.workout!.status).toBe('planned')
    expect(applied.snapshot.workout!.exercises).toEqual(saved.workout!.exercises)
    expect(applied.snapshot.history).toEqual(saved.history)
    reopen()
    expect(current()).toEqual(applied.snapshot)
    const workout = current().workout!
    const rejected = await post(envelope({kind: 'start_workout', workoutId: workout.id, expectedWorkoutVersion: workout.version}))
    expect(rejected.httpStatus).toBe(409)
    expect(current()).toEqual(applied.snapshot)
  })

  it('does not shift an already started workout or apply an earlier schedule after training starts', async () => {
    await lowRecovery()
    const {proposal} = proposed('schedule')
    const workout = current().workout!
    const started = await succeed(envelope({kind: 'start_workout', workoutId: workout.id, expectedWorkoutVersion: workout.version}))
    const tooLate = propose(proposalInput('schedule'))
    expect(tooLate.httpStatus).toBe(409)
    expect(current().workout).toEqual(started.snapshot.workout)
    const rejected = await post(envelope({kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false}))
    expect(rejected.httpStatus).toBe(409)
    expect(current().workout).toEqual(started.snapshot.workout)
    expect(current().plan).toEqual(started.snapshot.plan)
    expect(current().history).toEqual(started.snapshot.history)
  })
})
