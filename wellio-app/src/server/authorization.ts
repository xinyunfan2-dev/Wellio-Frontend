import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Meal, MealItem, Snapshot } from '../lib/contracts'
import type { StoredReply, WellioDatabase } from './database'
import { conditionsChangesSchema, type ConditionsChanges } from './conditions-service'
import { BackendError } from './errors'
import { baselineSchema } from './meal-validation'
import type { AuthorizationRecord, MutationConstraint, UserInputRecord } from './mutation-types'
import { deriveUserIntent } from './user-intent'

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
const epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const userMessageSchema = z.strictObject({ requestId: id, resetEpoch: epoch, conversationId: id, content: z.string().min(1).max(4_000).refine(value => value.trim().length > 0), targetMealId: id.optional(), targetMealItemId: id.optional() })
const authorizeSchema = z.strictObject({ sourceMessageId: id, resetEpoch: epoch, runId: id })

/** Trusted incoming-user transport only. Not an HTTP action or model-callable tool. */
export function recordUserMessage(database: WellioDatabase, sessionId: string, input: unknown): StoredReply {
  const parsed = userMessageSchema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  const request = { ...parsed.data, kind: 'record_user_message' }
  return database.mutate(sessionId, request, snapshot => {
    if (snapshot.conversationId !== request.conversationId) throw new BackendError('CONVERSATION_MISMATCH', 409)
    if (request.targetMealId && !snapshot.meals.some(meal => meal.id === request.targetMealId)) throw new BackendError('NOT_FOUND', 404)
    if (request.targetMealItemId && !snapshot.meals.some(meal => (!request.targetMealId || meal.id === request.targetMealId) && meal.items.some(item => item.id === request.targetMealItemId))) throw new BackendError('NOT_FOUND', 404)
    const { kind: _kind, ...original } = request
    const record: UserInputRecord = { ...original, id: randomUUID(), sessionId, createdAt: new Date().toISOString(), versions: { meal: snapshot.mealRevision, conditions: snapshot.conditions.version } }
    if (snapshot.workout) record.workoutContext = { workoutId: snapshot.workout.id, trainingSessionId: snapshot.workout.trainingSessionId, gymId: snapshot.conditions.gymId }
    database.storeUserInput(record)
    snapshot.messages.push({ id: record.id, role: 'user', source: 'user', content: record.content, createdAt: record.createdAt, status: 'complete', steps: [], ...(record.targetMealId ? { mealId: record.targetMealId } : {}) })
    snapshot.revision += 1
    return { httpStatus: 200, result: { requestId: request.requestId, status: 'succeeded', messageId: record.id }, snapshot }
  })
}

function unclear(): never { throw new BackendError('EXPLICIT_USER_INTENT_REQUIRED', 422) }

function resolveItem(snapshot: Snapshot, source: UserInputRecord, label: string): { meal: Meal; item: MealItem } {
  const normalized = label.trim().toLocaleLowerCase('en')
  const matches = snapshot.meals.flatMap(meal => {
    if (source.targetMealId && meal.id !== source.targetMealId) return []
    return meal.items.filter(item => (!source.targetMealItemId || source.targetMealItemId === item.id)
      && ((normalized === 'this item' || normalized === '这份食物') ? !!source.targetMealItemId : Object.values(item.name).some(name => name.toLocaleLowerCase('en') === normalized)))
      .map(item => ({ meal, item }))
  })
  if (matches.length !== 1) return unclear()
  return matches[0]
}

function conditionIntent(content: string): MutationConstraint {
  const changes: ConditionsChanges = {}
  const assign = <K extends keyof ConditionsChanges>(key: K, value: ConditionsChanges[K]) => {
    if (Object.hasOwn(changes, key)) return unclear()
    changes[key] = value
  }
  for (const raw of content.split(';')) {
    const clause = raw.trim().replace(/[.。]$/, '').trim()
    let match: RegExpMatchArray | null
    if ((match = clause.match(/^Set available time to (\d+) minutes?$/i)) || (match = clause.match(/^剩余时间改为(\d+)分钟$/))) assign('availableMinutes', Number(match[1]))
    else if ((match = clause.match(/^Set dinner budget to (?:HK\$)?(\d+(?:\.\d{1,2})?)$/i)) || (match = clause.match(/^预算改为(\d+(?:\.\d{1,2})?)$/))) assign('dinnerBudget', Number(match[1]))
    else if ((match = clause.match(/^Set gym to Gym ([AB])$/i)) || (match = clause.match(/^场地改为Gym ([AB])$/i))) assign('gymId', match[1].toUpperCase() === 'A' ? 'gym-a' : 'gym-b')
    else if ((match = clause.match(/^Set (gym-[ab]-[a-z-]+) to (available|temporarily_occupied|unavailable)$/i))) {
      const equipmentId = match[1].toLowerCase()
      if (changes.equipmentStatus && Object.hasOwn(changes.equipmentStatus, equipmentId)) return unclear()
      changes.equipmentStatus = { ...changes.equipmentStatus, [equipmentId]: match[2].toLowerCase() as 'available' | 'temporarily_occupied' | 'unavailable' }
    } else return unclear()
  }
  const parsed = conditionsChangesSchema.safeParse(changes)
  if (!parsed.success) return unclear()
  return { scope: 'conditions_update', changes: parsed.data }
}

/** Deliberately small whole-message grammar. Unknown/quoted/hypothetical content never grants authority. */
function deriveIntent(snapshot: Snapshot, source: UserInputRecord): MutationConstraint {
  const content = source.content.trim().replace(/[.。]$/, '').trim()
  if (/[?？"'“”‘’`\n\r]/.test(content) || /\b(if|would|could|not|never|maybe|might)\b/i.test(content) || /如果|假如|不要|没有|没吃|可能|引用/.test(content)) return unclear()
  if (/^(?:Please )?(?:Log|Record) this meal$/i.test(content) || /^(?:帮我记录这餐|记录这餐)$/.test(content)) {
    if (source.targetMealId || source.targetMealItemId) return unclear()
    return { scope: 'meal_add' }
  }
  let match: RegExpMatchArray | null
  // Explicit corrected totals apply to the original portion; the consumed fraction is preserved.
  if ((match = content.match(/^Correct (.+): (\d+(?:\.\d+)?) (g|ml|piece|serving); (\d+(?:\.\d+)?) kcal; protein (\d+(?:\.\d+)?) g; carbs (\d+(?:\.\d+)?) g; fat (\d+(?:\.\d+)?) g$/i))) {
    const { meal, item } = resolveItem(snapshot, source, match[1])
    const quantity = Number(match[2]), unit = match[3].toLowerCase()
    const portion = `${quantity} ${unit}`
    const baseline = baselineSchema.safeParse({ portion: { en: portion, 'zh-CN': portion }, originalPortion: { quantity, unit }, base: { kcal: Number(match[4]), protein: Number(match[5]), carbs: Number(match[6]), fat: Number(match[7]) }, nutrientUnits: { energy: 'kcal', mass: 'g' } })
    if (!baseline.success) return unclear()
    return { scope: 'meal_update', mealId: meal.id, mealItemId: item.id, changes: { baseline: baseline.data } }
  }
  let fraction: number | undefined
  let itemName: string | undefined
  if ((match = content.match(/^I (?:only )?ate (half|a quarter|three quarters|all|\d+(?:\.\d+)?%) (?:of )?(?:the )?(.+)$/i))) {
    const amount = match[1].toLowerCase()
    fraction = amount === 'half' ? .5 : amount === 'a quarter' ? .25 : amount === 'three quarters' ? .75 : amount === 'all' ? 1 : Number(amount.slice(0, -1)) / 100
    itemName = match[2]
  } else if ((match = content.match(/^(.+?)(?:只)?吃了(一半|四分之一|四分之三|全部)$/))) {
    fraction = ({ 一半: .5, 四分之一: .25, 四分之三: .75, 全部: 1 })[match[2]]
    itemName = match[1]
  }
  if (fraction !== undefined && itemName) {
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return unclear()
    const { meal, item } = resolveItem(snapshot, source, itemName)
    return { scope: 'meal_update', mealId: meal.id, mealItemId: item.id, changes: { consumedFraction: fraction } }
  }
  if (/^(?:Delete this meal|删除这餐)$/i.test(content)) {
    if (!source.targetMealId || source.targetMealItemId) return unclear()
    const meal = snapshot.meals.find(meal => meal.id === source.targetMealId)
    if (!meal) return unclear()
    return { scope: 'meal_delete', mealId: meal.id }
  }
  if ((match = content.match(/^Delete (?:the )?(.+)$/i)) || (match = content.match(/^删除(.+)$/))) {
    const { meal, item } = resolveItem(snapshot, source, match[1])
    return { scope: 'meal_delete', mealId: meal.id, mealItemId: item.id }
  }
  if (source.targetMealId || source.targetMealItemId) return unclear()
  return conditionIntent(content)
}

/** Trusted dispatcher only. The caller cannot supply scope, patch, source labels or approval flags. */
export function authorizeUserMutation(database: WellioDatabase, sessionId: string, input: unknown): AuthorizationRecord {
  const parsed = authorizeSchema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  return database.issueAuthorization(sessionId, parsed.data, (snapshot, source) => {
    const intent = deriveUserIntent(snapshot, source)
    if (intent.kind === 'meal') return intent.constraint
    if (intent.kind === 'conditions') return { scope: 'conditions_update', changes: intent.changes }
    return deriveIntent(snapshot, source)
  })
}
