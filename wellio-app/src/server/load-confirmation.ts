import type { Exercise, LoadBasis, Snapshot } from '../lib/contracts'
import { lookupEquipment } from './equipment'
import type { UserInputRecord } from './mutation-types'

export interface LoadConfirmationSource extends UserInputRecord {
  targetWorkoutId?: string
  targetExerciseId?: string
  targetOperationId?: string
  workoutContext?: { workoutId: string; trainingSessionId: string; gymId: 'gym-a' | 'gym-b' }
}

/** Private evidence: callers must load source from user_inputs, never from model arguments. */
export interface UserLoadEvidence {
  sourceMessageId: string
  sessionId: string
  resetEpoch: number
  trainingSessionId: string
  catalogId: string
  equipmentId: string
  kg: number
  unit: 'kg'
  basis: Extract<LoadBasis, 'per_hand' | 'machine_stack'>
  source: LoadConfirmationSource
}

export type LoadConfirmationResult =
  | { kind: 'confirmed'; confirmations: UserLoadEvidence[] }
  | { kind: 'needs_input'; errorCode: string }
  | { kind: 'not_confirmation' }

/** Shared conservative boundary. Quoted/conditional/negative commands are not authorizations. */
export function isReadOnlyUserText(text: string): boolean {
  const withoutContractions = text.replace(/\b(?:I'm|I've|I'll|that's|today's)\b/gi, '')
  return /[?？"'“”‘’`\n\r]/.test(withoutContractions)
    || /\b(if|would|could|should|not|never|nothing|no|maybe|might|recommend|hypothetically|don't|didn't|can't|won't)\b/i.test(text)
    || /如果|假如|假设|不要|没有|没吃|不吃|别记录|可能|引用|推荐|建议|是否|吗[。.!！]?$/.test(text)
}

export function hasCurrentUserSource(snapshot: Snapshot, source: UserInputRecord): boolean {
  return !!source.id && source.sessionId === snapshot.sessionId && source.resetEpoch === snapshot.resetEpoch
    && source.conversationId === snapshot.conversationId
}

type Definition = { kind: 'dumbbells' | 'cable'; names: string[] }
// The same bounded demo exercise directory used by workout-validation; no free-form equipment mapping.
const definitions: Record<string, Definition> = {
  'seated-cable-row': { kind: 'cable', names: ['seated cable row', '坐姿绳索划船'] },
  'lat-pulldown': { kind: 'cable', names: ['lat pulldown', '高位下拉'] },
  'dumbbell-curl': { kind: 'dumbbells', names: ['dumbbell curl', '哑铃弯举'] },
  'one-arm-dumbbell-row': { kind: 'dumbbells', names: ['one-arm dumbbell row', 'single-arm dumbbell row', '单臂哑铃划船'] },
  'goblet-squat': { kind: 'dumbbells', names: ['goblet squat', '高脚杯深蹲'] },
  'dumbbell-romanian-deadlift': { kind: 'dumbbells', names: ['dumbbell romanian deadlift', '哑铃罗马尼亚硬拉'] },
  'reverse-lunge': { kind: 'dumbbells', names: ['reverse lunge', '反向弓步', '后撤弓步'] },
  'dumbbell-bench-press': { kind: 'dumbbells', names: ['dumbbell bench press', '哑铃卧推'] },
  'dumbbell-shoulder-press': { kind: 'dumbbells', names: ['dumbbell shoulder press', '哑铃肩推', '哑铃推举'] },
  'triceps-pushdown': { kind: 'cable', names: ['triceps pushdown', '绳索下压', '绳索肱三头肌下压'] },
  'lateral-raise': { kind: 'dumbbells', names: ['lateral raise', '侧平举', '哑铃侧平举'] },
}

function resolveCatalog(snapshot: Snapshot, source: LoadConfirmationSource, label: string): string | undefined {
  const target = source.targetExerciseId && snapshot.workout?.exercises.find(exercise => exercise.id === source.targetExerciseId)
  if (source.targetExerciseId && !target) return undefined
  const name = label.trim().toLowerCase()
  if (!name || /^(?:this exercise|this movement|这个动作|该动作)$/.test(name)) {
    // Persisted source has no full exercise-focus snapshot. Later progress cannot resolve an old ambiguity.
    return target ? target.catalogId : undefined
  }
  const matches = Object.entries(definitions).filter(([id, definition]) =>
    (!target || id === target.catalogId) && definition.names.includes(name))
  return matches.length === 1 ? matches[0][0] : undefined
}

/** Parses explicit kilograms and spoken per-hand/stack basis; never infers basis from equipment. */
export function deriveLoadConfirmations(snapshot: Snapshot, source: LoadConfirmationSource): LoadConfirmationResult {
  const text = source.content.trim().replace(/[.。!！]$/, '').trim()
  if (source.purpose === 'menu' || isReadOnlyUserText(text)) return { kind: 'not_confirmation' }
  if (!/(?:kg|kilograms?|lbs?|pounds?)\b|公斤|千克|磅/i.test(text)) return { kind: 'not_confirmation' }
  const need = (errorCode: string): LoadConfirmationResult => ({ kind: 'needs_input', errorCode })
  if (!hasCurrentUserSource(snapshot, source)) return need('SOURCE_CONTEXT_MISMATCH')
  if (source.targetMealId || source.targetMealItemId || source.targetOperationId) return need('LOAD_TARGET_REQUIRED')
  const workout = snapshot.workout
  if (!workout || workout.status === 'completed' || (source.targetWorkoutId && workout.id !== source.targetWorkoutId)) return need('WORKOUT_TARGET_REQUIRED')
  if (!source.workoutContext) return need('LOAD_CONTEXT_REQUIRED')
  if (source.workoutContext.workoutId !== workout.id || source.workoutContext.trainingSessionId !== workout.trainingSessionId
    || source.workoutContext.gymId !== snapshot.conditions.gymId) return need('LOAD_CONTEXT_MISMATCH')
  if (/(?:lbs?|pounds?)\b|磅/i.test(text)) return need('LOAD_UNIT_REQUIRED')
  const confirmations: UserLoadEvidence[] = []
  for (const clause of text.split(/[;；]/).map(value => value.trim())) {
    let match: RegExpMatchArray | null
    let label: string, kg: number, basis: UserLoadEvidence['basis']
    if ((match = clause.match(/^(?:(?:I confirm|Use|I use) )?(?:(.+?) (?:at |is |use |uses )?)?(\d+(?:\.\d+)?)\s*(?:kg|kilograms?) (per hand|on the machine stack|on the stack|machine stack)$/i))) {
      label = match[1] ?? ''; kg = Number(match[2]); basis = match[3].toLowerCase() === 'per hand' ? 'per_hand' : 'machine_stack'
    } else if ((match = clause.match(/^(?:Use|I confirm|I use) (\d+(?:\.\d+)?)\s*(?:kg|kilograms?) (per hand|on the machine stack|on the stack|machine stack) for (.+)$/i))) {
      label = match[3]; kg = Number(match[1]); basis = match[2].toLowerCase() === 'per hand' ? 'per_hand' : 'machine_stack'
    } else if ((match = clause.match(/^(?:我确认|确认)?(.*?)(?:用|使用)?(?:每只|每手)(\d+(?:\.\d+)?)\s*(?:kg|公斤|千克)$/i))) {
      label = match[1]; kg = Number(match[2]); basis = 'per_hand'
    } else if ((match = clause.match(/^(?:我确认|确认)?(.*?)(?:用|使用)?(?:配重片|配重栈|器械配重)(\d+(?:\.\d+)?)\s*(?:kg|公斤|千克)$/i))) {
      label = match[1]; kg = Number(match[2]); basis = 'machine_stack'
    } else return need('LOAD_CONFIRMATION_REQUIRED')
    const catalogId = resolveCatalog(snapshot, source, label)
    if (!catalogId || !definitions[catalogId]) return need('EXERCISE_TARGET_REQUIRED')
    const equipmentId = `${snapshot.conditions.gymId}-${definitions[catalogId].kind}`
    const equipment = lookupEquipment(equipmentId)
    if (!equipment || (equipment.kind !== 'cable' && equipment.kind !== 'dumbbells') || equipment.load.basis !== basis) return need('LOAD_BASIS_REQUIRED')
    if (!equipment.load.allowedKg.includes(kg)) return need('INVALID_LOAD')
    if (confirmations.some(item => item.catalogId === catalogId && item.equipmentId === equipmentId)) return need('LOAD_CONFIRMATION_AMBIGUOUS')
    confirmations.push({ sourceMessageId: source.id, sessionId: source.sessionId, resetEpoch: source.resetEpoch,
      trainingSessionId: workout.trainingSessionId, catalogId, equipmentId, kg, unit: 'kg', basis, source: structuredClone(source) })
  }
  return { kind: 'confirmed', confirmations }
}

/** Re-derives private transport evidence. This does not authenticate a caller-supplied source object. */
export function validateUserLoad(snapshot: Snapshot, exercise: Exercise, evidence: unknown): boolean {
  if (!evidence || typeof evidence !== 'object') return false
  const saved = evidence as UserLoadEvidence
  if (!saved.source || typeof saved.source.content !== 'string') return false
  const load = exercise.suggestedLoad
  if (saved.sessionId !== snapshot.sessionId || saved.resetEpoch !== snapshot.resetEpoch
    || saved.trainingSessionId !== snapshot.workout?.trainingSessionId || saved.catalogId !== exercise.catalogId
    || saved.equipmentId !== exercise.equipmentId || saved.unit !== 'kg' || load.unit !== 'kg'
    || saved.kg !== load.value || saved.basis !== load.basis || load.source !== 'user'
    || load.sourceMessageId !== saved.sourceMessageId || saved.source.id !== saved.sourceMessageId) return false
  const parsed = deriveLoadConfirmations(snapshot, saved.source)
  return parsed.kind === 'confirmed' && parsed.confirmations.some(item => item.sourceMessageId === saved.sourceMessageId
    && item.trainingSessionId === saved.trainingSessionId && item.catalogId === saved.catalogId
    && item.equipmentId === saved.equipmentId && item.kg === saved.kg && item.basis === saved.basis)
}
