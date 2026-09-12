import type { Meal, MealItem, Snapshot } from '../lib/contracts'
import { conditionsChangesSchema, type ConditionsChanges } from './conditions-service'
import { lookupEquipment } from './equipment'
import { deriveLoadConfirmations, hasCurrentUserSource, isReadOnlyUserText, type UserLoadEvidence } from './load-confirmation'
import { baselineSchema } from './meal-validation'
import type { MutationConstraint, UserInputRecord } from './mutation-types'
import type { ProgressRequest } from './workout-service'

export interface UserIntentSource extends UserInputRecord {
  targetWorkoutId?: string
  targetExerciseId?: string
  targetOperationId?: string
}
type DomainAction<T> = T extends unknown ? Omit<T, 'requestId' | 'resetEpoch' | 'source' | 'expectedWorkoutVersion'> : never
export type UserProgressAction = DomainAction<ProgressRequest>
export type UserIntent =
  | { kind: 'meal'; constraint: MutationConstraint }
  | { kind: 'conditions'; changes: ConditionsChanges }
  | { kind: 'undo'; operationId: string }
  | { kind: 'progress'; action: UserProgressAction }
  | { kind: 'load_confirmation'; confirmations: UserLoadEvidence[] }
  | { kind: 'read_only' }
  | { kind: 'needs_input'; errorCode: string }

const need = (errorCode: string): UserIntent => ({ kind: 'needs_input', errorCode })
const readOnly: UserIntent = { kind: 'read_only' }
const normalized = (value: string) => value.trim().toLowerCase()

function resolveItem(snapshot: Snapshot, source: UserIntentSource, label: string): { meal: Meal; item: MealItem } | undefined {
  const name = normalized(label)
  const pronoun = /^(?:this item|this food|this|it|这份食物|这个|这份|它)$/.test(name)
  const matches = snapshot.meals.flatMap(meal => (!source.targetMealId || meal.id === source.targetMealId)
    ? meal.items.filter(item => (!source.targetMealItemId || item.id === source.targetMealItemId)
      && (pronoun || Object.values(item.name).some(alias => normalized(alias) === name))).map(item => ({ meal, item })) : [])
  return matches.length === 1 ? matches[0] : undefined
}

function resolveExercise(snapshot: Snapshot, source: UserIntentSource, label: string, completed: boolean): string | undefined {
  const name = normalized(label)
  const pronoun = /^(?:this exercise|this movement|the exercise|这个动作|该动作|整个动作)$/.test(name)
  const matches = (snapshot.workout?.exercises ?? []).filter(exercise =>
    (!source.targetExerciseId || source.targetExerciseId === exercise.id)
    && (pronoun ? (!!source.targetExerciseId || exercise.completed === completed)
      : Object.values(exercise.name).some(alias => normalized(alias) === name)))
  return matches.length === 1 ? matches[0].id : undefined
}

function progressIntent(snapshot: Snapshot, source: UserIntentSource, text: string): UserIntent | undefined {
  const start = /^(?:(?:Please )?start (?:the |this |my )?workout|开始训练|开始今天的训练|我现在开始训练)$/i.test(text)
  const finish = text.match(/^(?:Finish|End) (?:the |this |my )?workout( with unfinished exercises| even if incomplete)?(?:[,，:]? (?:after |in |actual time )?(\d+) minutes?)?$/i)
    ?? text.match(/^(未完成也)?(?:结束训练|训练结束了)(?:[，,:]?\s*(?:实际(?:用时|用了)?|用时|用了)?\s*(\d+)\s*分钟)?$/)
  const complete = text.match(/^(?:I (?:have )?(?:finished|completed)|Complete|Mark complete) (.+)$/i)
    ?? text.match(/^(.+?)(?:全部)?(?:做完了|完成了)$/)
    ?? text.match(/^完成(.+)$/)
  const undo = text.match(/^Undo (?:completion of )(.+)$/i) ?? text.match(/^撤回(.+?)(?:的)?完成(?:状态)?$/)
  if (!start && !finish && !complete && !undo) return undefined
  if (source.targetMealId || source.targetMealItemId || source.targetOperationId) return need('WORKOUT_TARGET_REQUIRED')
  const workout = snapshot.workout
  if (!workout || (source.targetWorkoutId && workout.id !== source.targetWorkoutId)) return need('WORKOUT_TARGET_REQUIRED')
  if (start) return source.targetExerciseId ? need('WORKOUT_TARGET_REQUIRED') : { kind: 'progress', action: { kind: 'start_workout', workoutId: workout.id } }
  if (finish) {
    if (source.targetExerciseId) return need('WORKOUT_TARGET_REQUIRED')
    if (!finish[2]) return need('ACTUAL_MINUTES_REQUIRED')
    const actualMinutes = Number(finish[2])
    if (!Number.isInteger(actualMinutes) || actualMinutes < 1 || actualMinutes > 1440) return need('INVALID_ACTUAL_MINUTES')
    const confirmIncomplete = !!finish[1]
    if (workout.exercises.some(exercise => !exercise.completed) && !confirmIncomplete) return need('INCOMPLETE_CONFIRMATION_REQUIRED')
    return { kind: 'progress', action: { kind: 'finish_workout', workoutId: workout.id, actualMinutes, confirmIncomplete } }
  }
  const exerciseId = resolveExercise(snapshot, source, (undo ?? complete)![1], !!undo)
  if (!exerciseId) return need('EXERCISE_TARGET_REQUIRED')
  return { kind: 'progress', action: { kind: undo ? 'undo_exercise' : 'complete_exercise', workoutId: workout.id, exerciseId } }
}

/** Returns a patch only when every clause matches; no partial writes on an unknown second clause. */
function conditionsIntent(snapshot: Snapshot, text: string): UserIntent | undefined {
  const changes: ConditionsChanges = {}
  let invalid = false
  const assign = <K extends keyof ConditionsChanges>(key: K, value: ConditionsChanges[K]) => {
    if (Object.hasOwn(changes, key)) invalid = true
    changes[key] = value
  }
  for (const raw of text.split(/[;；]/)) {
    const clause = raw.trim().replace(/[.。]$/, '').trim()
    let match: RegExpMatchArray | null
    if ((match = clause.match(/^Set available time to (\d+) minutes?$/i))
      || (match = clause.match(/^I (?:only\s+have|have\s*(?:only)?)\s*(\d+)\s*minutes?(?: (?:left|now|today))?$/i))
      || (match = clause.match(/^(?:今天|我今天|我现在|现在)?(?:只)?(?:剩|剩下|剩余)(?:时间)?(?:改为|改成)?\s*(\d+)\s*分钟$/))
      || (match = clause.match(/^(?:我(?:今天|现在)?|今天|现在)?只有\s*(\d+)\s*分钟$/))) assign('availableMinutes', Number(match[1]))
    else if ((match = clause.match(/^(?:Set|Change) (?:my )?dinner budget to (?:HK\$)?(\d+(?:\.\d{1,2})?)$/i))
      || (match = clause.match(/^(?:今天的?|我的?)?(?:晚餐)?预算改(?:为|成)\s*(\d+(?:\.\d{1,2})?)(?:港币|港元|元)?$/))) assign('dinnerBudget', Number(match[1]))
    else if ((match = clause.match(/^(?:Set gym to|Switch (?:my gym )?to|I'm (?:now )?at) Gym\s*([AB])$/i))
      || (match = clause.match(/^(?:场地改为|场地改成|换到|换成|换|我现在在)\s*Gym\s*([AB])$/i))) assign('gymId', match[1].toUpperCase() === 'A' ? 'gym-a' : 'gym-b')
    else {
      let equipmentId: string | undefined
      let status: 'available' | 'temporarily_occupied' | 'unavailable' | undefined
      if ((match = clause.match(/^Set (gym-[ab]-[a-z-]+) to (available|temporarily_occupied|unavailable)$/i))) {
        equipmentId = match[1].toLowerCase(); status = match[2].toLowerCase() as typeof status
      } else if ((match = clause.match(/^(?:The )?(?:(?:current gym(?:'s)?|my gym(?:'s)?) )?(cable(?: machine)?|dumbbells|bench|pull-up bar) (?:is|are) (occupied|busy|available|unavailable|broken)$/i))
        || (match = clause.match(/^(?:当前场地的?|这里的?)?(cable|拉力器|绳索器械|哑铃|训练凳|单杠)(?:现在)?(?:被)?(占用|占了|占|空闲|可用|不可用|坏了)$/i))) {
        const names: Record<string, string> = { cable: 'cable', 'cable machine': 'cable', 拉力器: 'cable', 绳索器械: 'cable', dumbbells: 'dumbbells', 哑铃: 'dumbbells', bench: 'bench', 训练凳: 'bench', 'pull-up bar': 'pullup-bar', 单杠: 'pullup-bar' }
        equipmentId = `${snapshot.conditions.gymId}-${names[match[1].toLowerCase()]}`
        const word = match[2].toLowerCase()
        status = /^(?:occupied|busy|占用|占了|占)$/.test(word) ? 'temporarily_occupied' : /^(?:available|空闲|可用)$/.test(word) ? 'available' : 'unavailable'
      }
      if (!equipmentId || !status) return Object.keys(changes).length || /^(?:set |change .*budget|switch |I (?:only\s+have|have\s*only)|(?:我(?:今天|现在)?|今天|现在)?只有|剩余|今天只剩|晚餐预算|预算改|当前场地)/i.test(text) ? need('CONDITIONS_CONFIRMATION_REQUIRED') : undefined
      if (!lookupEquipment(equipmentId) || Object.hasOwn(changes.equipmentStatus ?? {}, equipmentId)) invalid = true
      changes.equipmentStatus = { ...changes.equipmentStatus, [equipmentId]: status }
    }
  }
  // A relative current-gym equipment statement and a gym switch need separate messages.
  if (changes.gymId && changes.equipmentStatus && !text.split(/[;；]/).every(clause => !/occupied|busy|被占|占用|空闲|坏了/i.test(clause))) invalid = true
  const parsed = conditionsChangesSchema.safeParse(changes)
  return !invalid && parsed.success ? { kind: 'conditions', changes: parsed.data } : need('CONDITIONS_CONFIRMATION_REQUIRED')
}

/** Pure whole-message interpretation. Persist the original transport source before calling. */
export function deriveUserIntent(snapshot: Snapshot, source: UserIntentSource): UserIntent {
  const text = source.content.trim().replace(/[.。!！]$/, '').trim()
  if (source.purpose === 'menu' || isReadOnlyUserText(text)) return readOnly
  // A reported meal followed by a question is informational, even without a question mark.
  if (/\b(?:how many|how much|what is|what are|is this|is that|did I)\b|多少|够不够|能不能|是不是|有没有/.test(text.toLowerCase())) return readOnly
  if (!hasCurrentUserSource(snapshot, source)) return need('SOURCE_CONTEXT_MISMATCH')
  const progress = progressIntent(snapshot, source, text)
  if (progress) return progress
  if (/^(?:Undo (?:this|that|the last) (?:meal )?change|Undo|撤销|撤销(?:这次|刚才的|上次的)(?:餐食)?修改)$/i.test(text)) {
    if (source.targetWorkoutId || source.targetExerciseId || source.targetMealItemId) return need('OPERATION_TARGET_REQUIRED')
    if (source.targetOperationId) return { kind: 'undo', operationId: source.targetOperationId }
    if (source.targetMealId) {
      const meal = snapshot.meals.find(item => item.id === source.targetMealId)
      if (meal?.operationId) return { kind: 'undo', operationId: meal.operationId }
    }
    return need('OPERATION_TARGET_REQUIRED')
  }
  const load = deriveLoadConfirmations(snapshot, source)
  if (load.kind === 'confirmed') return { kind: 'load_confirmation', confirmations: load.confirmations }
  if (load.kind === 'needs_input') return load
  let match: RegExpMatchArray | null
  const hasOtherTarget = !!(source.targetWorkoutId || source.targetExerciseId || source.targetOperationId)
  if ((match = text.match(/^Correct (.+): (\d+(?:\.\d+)?) (g|ml|piece|serving); (\d+(?:\.\d+)?) kcal; protein (\d+(?:\.\d+)?) g; carbs (\d+(?:\.\d+)?) g; fat (\d+(?:\.\d+)?) g$/i))) {
    const target = resolveItem(snapshot, source, match[1])
    if (!target || hasOtherTarget) return need('MEAL_TARGET_REQUIRED')
    const quantity = Number(match[2]), unit = match[3].toLowerCase(), portion = `${quantity} ${unit}`
    const baseline = baselineSchema.safeParse({ portion: { en: portion, 'zh-CN': portion }, originalPortion: { quantity, unit }, base: { kcal: Number(match[4]), protein: Number(match[5]), carbs: Number(match[6]), fat: Number(match[7]) }, nutrientUnits: { energy: 'kcal', mass: 'g' } })
    return baseline.success ? { kind: 'meal', constraint: { scope: 'meal_update', mealId: target.meal.id, mealItemId: target.item.id, changes: { baseline: baseline.data } } } : need('INVALID_MEAL_CHANGES')
  }
  let fraction: number | undefined, label: string | undefined
  if ((match = text.match(/^I (?:(?:only|just) )?ate\s+(?:only\s*)?(half|a quarter|three quarters|all|\d+(?:\.\d+)?%)(?:\s+(?:of )?(?:the )?(.+))?$/i))
    || (match = text.match(/^only\s*(half|a quarter|three quarters|all|\d+(?:\.\d+)?%)(?:\s+(?:of )?(?:the )?(.+))?$/i))) {
    const amount = match[1].toLowerCase()
    fraction = amount === 'half' ? .5 : amount === 'a quarter' ? .25 : amount === 'three quarters' ? .75 : amount === 'all' ? 1 : Number(amount.slice(0, -1)) / 100
    label = match[2] ?? 'this item'
  } else if ((match = text.match(/^(?:我)?(?:刚刚|刚才|刚|已经)?(?:只)?吃(?:了)?(一半|四分之一|四分之三|全部)(.*)$/))) {
    fraction = ({ 一半: .5, 四分之一: .25, 四分之三: .75, 全部: 1 })[match[1]]; label = match[2].trim() || '这份食物'
  } else if ((match = text.match(/^(.+?)(?:我)?(?:刚刚|刚才|刚|已经)?(?:只)?吃(?:了)?(一半|四分之一|四分之三|全部)$/))) {
    fraction = ({ 一半: .5, 四分之一: .25, 四分之三: .75, 全部: 1 })[match[2]]; label = match[1].replace(/^我(?:的)?/, '').trim()
  }
  if (fraction !== undefined && label) {
    const target = resolveItem(snapshot, source, label)
    if (!target || hasOtherTarget) return need('MEAL_TARGET_REQUIRED')
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return need('INVALID_MEAL_CHANGES')
    return { kind: 'meal', constraint: { scope: 'meal_update', mealId: target.meal.id, mealItemId: target.item.id, changes: { consumedFraction: fraction } } }
  }
  if (/^(?:Delete this meal|删除这餐)$/i.test(text)) {
    const meal = snapshot.meals.find(meal => meal.id === source.targetMealId)
    return meal && !source.targetMealItemId && !hasOtherTarget ? { kind: 'meal', constraint: { scope: 'meal_delete', mealId: meal.id } } : need('MEAL_TARGET_REQUIRED')
  }
  if ((match = text.match(/^Delete (?:the )?(.+)$/i)) || (match = text.match(/^删除(.+)$/))) {
    const target = resolveItem(snapshot, source, match[1])
    return target && !hasOtherTarget ? { kind: 'meal', constraint: { scope: 'meal_delete', mealId: target.meal.id, mealItemId: target.item.id } } : need('MEAL_TARGET_REQUIRED')
  }
  if (/^(?:(?:Please )?(?:Log|Record) this meal|帮我记录这餐|记录这餐)$/i.test(text)
    || (/^(?:I (?:just )?(?:ate|have eaten)|I've (?:just )?eaten) [^;；:：]+$/i.test(text)
      || /^(?:我)?(?:刚刚|刚才|刚|已经)?吃(?:了|过了?)[^;；:：]+$/.test(text))) {
    return source.targetMealId || source.targetMealItemId || hasOtherTarget ? need('MEAL_TARGET_REQUIRED') : { kind: 'meal', constraint: { scope: 'meal_add' } }
  }
  const conditions = conditionsIntent(snapshot, text)
  if (conditions) return source.targetMealId || source.targetMealItemId || hasOtherTarget ? need('CONDITIONS_TARGET_REQUIRED') : conditions
  // Recognizable writes with incomplete details need clarification, rather than silent read-only fallback.
  if (/^(?:(?:Please )?(?:Log|Record|Correct|Delete)\b|删除|记录|帮我记录|I (?:(?:just|only) )?ate\b|(?:我)?(?:刚刚|刚才|刚|已经)?(?:只)?吃(?:了|过))/i.test(text)) return need('MEAL_TARGET_REQUIRED')
  if (/^(?:Undo\b|撤销)/i.test(text)) return need('OPERATION_TARGET_REQUIRED')
  if (/^(?:(?:Please )?(?:Start|Finish|End|Complete)\b|开始|结束|完成)/i.test(text)) return need('WORKOUT_TARGET_REQUIRED')
  return readOnly
}
