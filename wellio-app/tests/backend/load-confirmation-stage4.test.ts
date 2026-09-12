import { beforeEach, describe, expect, it } from 'vitest'
import type { Snapshot } from '../../src/lib/contracts'
import { createSeed } from '../../src/server/seed'
import { deriveLoadConfirmations, validateUserLoad, type LoadConfirmationSource, type UserLoadEvidence } from '../../src/server/load-confirmation'
import { deriveUserIntent } from '../../src/server/user-intent'

describe('Stage 4 user load evidence', () => {
  let snapshot: Snapshot
  beforeEach(() => { snapshot = createSeed('load-session') })
  const source = (content: string, fields: Partial<LoadConfirmationSource> = {}): LoadConfirmationSource => ({
    id: 'load-message', sessionId: snapshot.sessionId, requestId: 'load-request', resetEpoch: snapshot.resetEpoch,
    conversationId: snapshot.conversationId, content, createdAt: '2026-09-12T08:00:00Z',
    versions: { meal: snapshot.mealRevision, conditions: snapshot.conditions.version },
    workoutContext: { workoutId: snapshot.workout!.id, trainingSessionId: snapshot.workout!.trainingSessionId, gymId: snapshot.conditions.gymId }, ...fields,
  })
  const derive = (text: string, fields: Partial<LoadConfirmationSource> = {}) => deriveLoadConfirmations(snapshot, source(text, fields))
  function confirmed(text = 'I confirm dumbbell curl at 10 kg per hand'): UserLoadEvidence {
    const result = derive(text)
    expect(result.kind).toBe('confirmed')
    if (result.kind !== 'confirmed') throw new Error(JSON.stringify(result))
    return result.confirmations[0]
  }
  function userExercise() {
    const exercise = structuredClone(snapshot.workout!.exercises.find(item => item.catalogId === 'dumbbell-curl')!)
    exercise.suggestedLoad = { ...exercise.suggestedLoad, source: 'user', value: 10, basis: 'per_hand', sourceMessageId: 'load-message' }
    delete exercise.suggestedLoad.sourceHistoryId
    return exercise
  }

  it.each(['I confirm dumbbell curl at 10 kg per hand', 'Use 10 kg per hand for dumbbell curl', '哑铃弯举每只10公斤', '我确认哑铃弯举用每手10kg'])('captures exact source, session, catalog, equipment and value: %s', text => {
    expect(confirmed(text)).toMatchObject({ sourceMessageId: 'load-message', sessionId: snapshot.sessionId, resetEpoch: snapshot.resetEpoch,
      trainingSessionId: snapshot.workout!.trainingSessionId, catalogId: 'dumbbell-curl', equipmentId: 'gym-b-dumbbells', kg: 10, unit: 'kg', basis: 'per_hand', source: { content: text } })
  })

  it('recognizes machine-stack confirmation without treating it as per-hand load', () => {
    const result = derive('I confirm lat pulldown at 40 kg on the machine stack')
    expect(result).toMatchObject({ kind: 'confirmed', confirmations: [{ catalogId: 'lat-pulldown', equipmentId: 'gym-b-cable', basis: 'machine_stack', kg: 40 }] })
    expect(derive('高位下拉配重栈40公斤')).toMatchObject({ kind: 'confirmed' })
    expect(derive('高位下拉每只40公斤')).toEqual({ kind: 'needs_input', errorCode: 'LOAD_BASIS_REQUIRED' })
  })

  it('supports a confirmed known replacement directory entry without inventing an instance', () => {
    expect(derive('单臂哑铃划船每只20公斤')).toMatchObject({ kind: 'confirmed', confirmations: [{ catalogId: 'one-arm-dumbbell-row', equipmentId: 'gym-b-dumbbells' }] })
    expect(derive('Unknown lift at 10 kg per hand')).toMatchObject({ kind: 'needs_input' })
  })

  it('requires a target for a bare weight, and checks a named label against the transport target', () => {
    expect(derive('10 kg per hand')).toEqual({ kind: 'needs_input', errorCode: 'EXERCISE_TARGET_REQUIRED' })
    const curl = userExercise()
    expect(derive('10 kg per hand', { targetExerciseId: curl.id })).toMatchObject({ kind: 'confirmed' })
    expect(derive('哑铃弯举每只10公斤', { targetExerciseId: 'nonexistent' })).toMatchObject({ kind: 'needs_input' })
    expect(derive('哑铃弯举每只10公斤', { targetExerciseId: snapshot.workout!.exercises[0].id })).toMatchObject({ kind: 'needs_input' })
    expect(derive('哑铃弯举每只10公斤', { targetWorkoutId: 'other' })).toMatchObject({ kind: 'needs_input' })
  })

  it.each(['dumbbell curl at 10 kg', '哑铃弯举10公斤', 'dumbbell curl at 20 lbs per hand', 'dumbbell curl at 11 kg per hand', 'dumbbell curl at 30 kg per hand'])('does not supply missing units/basis or round impossible equipment steps: %s', text => {
    expect(derive(text)).toMatchObject({ kind: 'needs_input' })
  })

  it.each(['Could I use 10 kg per hand for dumbbell curl?', 'If I use 10 kg per hand for dumbbell curl', '不要哑铃弯举每只10公斤', '“哑铃弯举每只10公斤”', '推荐哑铃弯举每只10公斤'])('ignores non-authorizing text: %s', text => {
    expect(derive(text)).toEqual({ kind: 'not_confirmation' })
  })

  it('rejects menu instructions and current-source identity mismatches', () => {
    expect(derive('哑铃弯举每只10公斤', { purpose: 'menu' })).toEqual({ kind: 'not_confirmation' })
    for (const fields of [{ sessionId: 'foreign' }, { resetEpoch: snapshot.resetEpoch + 1 }, { conversationId: 'foreign' }]) {
      expect(derive('哑铃弯举每只10公斤', fields)).toEqual({ kind: 'needs_input', errorCode: 'SOURCE_CONTEXT_MISMATCH' })
    }
  })

  it('validates the saved source and rejects a model source=user without genuine evidence', () => {
    const evidence = confirmed(), exercise = userExercise()
    expect(validateUserLoad(snapshot, exercise, evidence)).toBe(true)
    expect(validateUserLoad(snapshot, exercise, undefined)).toBe(false)
    expect(validateUserLoad(snapshot, exercise, { ...evidence, source: source('Recommend dumbbell curl') })).toBe(false)
    expect(validateUserLoad(snapshot, exercise, { ...evidence, kg: 12.5 })).toBe(false)
    expect(validateUserLoad(snapshot, exercise, { ...evidence, sourceMessageId: 'invented' })).toBe(false)
    expect(validateUserLoad(snapshot, { ...exercise, suggestedLoad: { ...exercise.suggestedLoad, sourceMessageId: undefined } }, evidence)).toBe(false)
    expect(validateUserLoad(snapshot, { ...exercise, suggestedLoad: { ...exercise.suggestedLoad, value: 12.5 } }, evidence)).toBe(false)
  })

  it('does not transfer evidence across sessions, resets, training sessions, catalogs or gyms', () => {
    const evidence = confirmed(), exercise = userExercise()
    expect(validateUserLoad({ ...snapshot, sessionId: 'foreign' }, exercise, evidence)).toBe(false)
    expect(validateUserLoad({ ...snapshot, resetEpoch: snapshot.resetEpoch + 1 }, exercise, evidence)).toBe(false)
    expect(validateUserLoad({ ...snapshot, workout: { ...snapshot.workout!, trainingSessionId: 'other' } }, exercise, evidence)).toBe(false)
    expect(validateUserLoad(snapshot, { ...exercise, catalogId: 'lateral-raise' }, evidence)).toBe(false)
    expect(validateUserLoad(snapshot, { ...exercise, equipmentId: 'gym-a-dumbbells' }, evidence)).toBe(false)
    snapshot.conditions.gymId = 'gym-a'
    expect(validateUserLoad(snapshot, exercise, evidence)).toBe(false)
  })

  it('cannot derive old raw input for the first time against a later training session or gym', () => {
    const original = source('哑铃弯举每只10公斤')
    expect(derive('哑铃弯举每只10公斤', { workoutContext: undefined })).toEqual({ kind: 'needs_input', errorCode: 'LOAD_CONTEXT_REQUIRED' })
    snapshot.workout!.trainingSessionId = 'later-session'
    expect(deriveLoadConfirmations(snapshot, original)).toEqual({ kind: 'needs_input', errorCode: 'LOAD_CONTEXT_MISMATCH' })
    snapshot.workout!.trainingSessionId = original.workoutContext!.trainingSessionId
    snapshot.conditions.gymId = 'gym-a'
    expect(deriveLoadConfirmations(snapshot, original)).toEqual({ kind: 'needs_input', errorCode: 'LOAD_CONTEXT_MISMATCH' })
  })

  it('later progress or model-written exercise aliases cannot retroactively authorize ambiguous text', () => {
    const bare = source('10 kg per hand')
    snapshot.workout!.exercises.filter(exercise => exercise.catalogId !== 'dumbbell-curl').forEach(exercise => { exercise.completed = true })
    expect(deriveLoadConfirmations(snapshot, bare)).toEqual({ kind: 'needs_input', errorCode: 'EXERCISE_TARGET_REQUIRED' })
    snapshot.workout!.exercises.find(exercise => exercise.catalogId === 'dumbbell-curl')!.name.en = 'made-up lift'
    expect(derive('made-up lift at 10 kg per hand')).toEqual({ kind: 'needs_input', errorCode: 'EXERCISE_TARGET_REQUIRED' })
  })

  it('validates all confirmations atomically, rejects duplicate objects, and preserves its input', () => {
    const before = structuredClone(snapshot)
    expect(derive('哑铃弯举每只10公斤；高位下拉配重栈40公斤')).toMatchObject({ kind: 'confirmed', confirmations: [{ kg: 10 }, { kg: 40 }] })
    expect(derive('哑铃弯举每只10公斤；高位下拉配重栈999公斤')).toMatchObject({ kind: 'needs_input' })
    expect(derive('哑铃弯举每只10公斤；哑铃弯举每只12.5公斤')).toEqual({ kind: 'needs_input', errorCode: 'LOAD_CONFIRMATION_AMBIGUOUS' })
    expect(deriveUserIntent(snapshot, source('哑铃弯举每只10公斤'))).toMatchObject({ kind: 'load_confirmation' })
    expect(snapshot).toEqual(before)
  })
})
