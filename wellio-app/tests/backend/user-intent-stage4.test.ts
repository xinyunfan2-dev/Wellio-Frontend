import { beforeEach, describe, expect, it } from 'vitest'
import type { Snapshot } from '../../src/lib/contracts'
import { createSeed } from '../../src/server/seed'
import { deriveUserIntent, type UserIntentSource } from '../../src/server/user-intent'

describe('Stage 4 intent from actual user text', () => {
  let snapshot: Snapshot
  beforeEach(() => { snapshot = createSeed('intent-session') })
  const source = (content: string, targets: Partial<UserIntentSource> = {}): UserIntentSource => ({
    id: 'message-1', sessionId: snapshot.sessionId, requestId: 'request-1', resetEpoch: snapshot.resetEpoch,
    conversationId: snapshot.conversationId, content, createdAt: '2026-09-12T08:00:00Z',
    versions: { meal: snapshot.mealRevision, conditions: snapshot.conditions.version }, ...targets,
  })
  const derive = (content: string, targets: Partial<UserIntentSource> = {}) => deriveUserIntent(snapshot, source(content, targets))

  it.each(['Please log this meal.', 'Log this meal', '记录这餐', '帮我记录这餐', 'I ate chicken rice', 'I just ate chicken breast and rice', "I've just eaten a burger", '我刚才吃了鸡肉饭', '我刚吃了鸡胸肉和米饭', '我吃过汉堡'])('authorizes explicit meal intake: %s', text => {
    expect(derive(text)).toEqual({ kind: 'meal', constraint: { scope: 'meal_add' } })
  })

  it.each(['How many calories are in this meal?', '推荐低热量晚餐', '如果我吃了汉堡', '我没有吃薯条', 'I did not eat fries', "I didn't eat fries", 'I ate nothing', 'I ate no fries', 'I might log this meal', '"Log this meal"', '他说“记录这餐”', 'Log this meal\nDelete this meal', 'Please apply this workout', '我吃了汉堡吗？'])('never writes a question, hypothetical, denial or quoted command: %s', text => {
    expect(derive(text)).toEqual({ kind: 'read_only' })
  })

  it('menu attachment text cannot authorize intake, while food default caption can', () => {
    expect(derive('Please log this meal.', { purpose: 'menu', attachmentIds: ['menu-1'] })).toEqual({ kind: 'read_only' })
    expect(derive('Please log this meal.', { purpose: 'food', attachmentIds: ['food-1'] })).toMatchObject({ kind: 'meal' })
  })

  it('resolves a fraction to the existing item and keeps it absolute', () => {
    snapshot.meals[0].items[0].name = { en: 'Fries', 'zh-CN': '薯条' }
    for (const text of ['薯条只吃了一半', '薯条只吃一半', 'I only ate half of the fries']) {
      expect(derive(text)).toEqual({ kind: 'meal', constraint: { scope: 'meal_update', mealId: snapshot.meals[0].id,
        mealItemId: snapshot.meals[0].items[0].id, changes: { consumedFraction: .5 } } })
    }
    snapshot.meals[0].items[0].consumedFraction = .5
    expect(derive('薯条只吃了一半')).toMatchObject({ constraint: { changes: { consumedFraction: .5 } } })
  })

  it('requires one food target and never silently adds a meal for an ambiguous fraction', () => {
    snapshot.meals[0].items[0].name = snapshot.meals[1].items[0].name = { en: 'Fries', 'zh-CN': '薯条' }
    expect(derive('薯条只吃了一半')).toEqual({ kind: 'needs_input', errorCode: 'MEAL_TARGET_REQUIRED' })
    expect(derive('薯条只吃了一半', { targetMealId: snapshot.meals[1].id })).toMatchObject({ constraint: { mealId: snapshot.meals[1].id } })
    expect(derive('I ate half of this item')).toMatchObject({ kind: 'needs_input' })
  })

  it.each(['鸡胸肉我只吃了一半', '我鸡胸肉只吃了一半', '我只吃了一半鸡胸肉', '我刚吃了一半鸡胸肉', '鸡胸肉我刚只吃了一半', 'I ate only half of the chicken breast', 'I ate onlyhalf of the chicken breast', 'I just ate onlyhalf of the chicken breast', 'I just ate half of the chicken breast'])('resolves equivalent half-portion word order without adding another meal: %s', text => {
    snapshot.meals[0].items[0].name = { en: 'Chicken breast', 'zh-CN': '鸡胸肉' }
    const result = derive(text)
    expect(result).toEqual({ kind: 'meal', constraint: { scope: 'meal_update', mealId: snapshot.meals[0].id,
      mealItemId: snapshot.meals[0].items[0].id, changes: { consumedFraction: .5 } } })
  })

  it.each(['I ate only half', 'I just ate onlyhalf', 'onlyhalf', '我只吃了一半'])('requires a unique existing item for a targetless half-portion statement: %s', text => {
    expect(derive(text)).toEqual({ kind: 'needs_input', errorCode: 'MEAL_TARGET_REQUIRED' })
    expect(derive(text, { targetMealItemId: snapshot.meals[0].items[0].id })).toMatchObject({ kind: 'meal', constraint: { scope: 'meal_update', mealItemId: snapshot.meals[0].items[0].id, changes: { consumedFraction: .5 } } })
  })

  it('keeps named targets exact and asks about absent or duplicate foods in the new word orders', () => {
    expect(derive('鸡胸肉我只吃了一半')).toEqual({ kind: 'needs_input', errorCode: 'MEAL_TARGET_REQUIRED' })
    snapshot.meals[0].items[0].name = snapshot.meals[1].items[0].name = { en: 'Chicken breast', 'zh-CN': '鸡胸肉' }
    expect(derive('I ate onlyhalf of the chicken breast')).toMatchObject({ kind: 'needs_input' })
    expect(derive('鸡胸肉我只吃了一半', { targetMealId: snapshot.meals[1].id })).toMatchObject({ constraint: { mealId: snapshot.meals[1].id } })
  })

  it.each(['我刚吃了鸡胸肉和米饭热量多少', 'I just ate chicken breast and rice how many calories', '我只有20分钟够不够', '如果我只有20分钟', '我没有只有20分钟', '我没吃鸡胸肉', 'I did not just eat chicken breast', 'I might have only20minutes', '菜单写着“鸡胸肉我只吃了一半”'])('does not turn question, denial, hypothetical or quotation variants into a write: %s', text => {
    expect(derive(text)).toEqual({ kind: 'read_only' })
  })

  it('does not authorize the new meal statement from a menu source', () => {
    expect(derive('我刚吃了鸡胸肉和米饭', { purpose: 'menu' })).toEqual({ kind: 'read_only' })
  })

  it('preserves canonical baseline, percentage, deletion, and multi-condition syntax', () => {
    const targetMealItemId = snapshot.meals[0].items[0].id
    expect(derive('Correct this item: 200 g; 300 kcal; protein 20 g; carbs 40 g; fat 5 g', { targetMealItemId }))
      .toMatchObject({ kind: 'meal', constraint: { scope: 'meal_update', changes: { baseline: { originalPortion: { quantity: 200, unit: 'g' }, base: { kcal: 300, protein: 20, carbs: 40, fat: 5 } } } } })
    expect(derive('I ate 25% of this item', { targetMealItemId })).toMatchObject({ constraint: { changes: { consumedFraction: .25 } } })
    expect(derive('I ate 125% of this item', { targetMealItemId })).toMatchObject({ kind: 'needs_input' })
    expect(derive('Delete this item', { targetMealItemId })).toMatchObject({ constraint: { scope: 'meal_delete', mealItemId: targetMealItemId } })
    expect(derive('Delete this meal', { targetMealId: snapshot.meals[0].id })).toEqual({ kind: 'meal', constraint: { scope: 'meal_delete', mealId: snapshot.meals[0].id } })
    expect(derive('Set available time to 20 minutes; Set dinner budget to HK$70; Set gym-b-cable to temporarily_occupied'))
      .toEqual({ kind: 'conditions', changes: { availableMinutes: 20, dinnerBudget: 70, equipmentStatus: { 'gym-b-cable': 'temporarily_occupied' } } })
  })

  it.each([
    ['今天只剩20分钟', { availableMinutes: 20 }], ['I only have20minutes now', { availableMinutes: 20 }],
    ['I only have 20 minutes now', { availableMinutes: 20 }], ['剩余时间改为20分钟', { availableMinutes: 20 }],
    ['我只有20分钟', { availableMinutes: 20 }], ['我今天只有 20 分钟', { availableMinutes: 20 }],
    ['I have only20minutes', { availableMinutes: 20 }], ['I have only 20 minutes now', { availableMinutes: 20 }],
    ['晚餐预算改成70', { dinnerBudget: 70 }], ['Change my dinner budget to 70', { dinnerBudget: 70 }],
    ['当前场地cable被占', { equipmentStatus: { 'gym-b-cable': 'temporarily_occupied' } }],
    ['The cable machine is occupied', { equipmentStatus: { 'gym-b-cable': 'temporarily_occupied' } }],
    ['换Gym A', { gymId: 'gym-a' }], ["I'm now at Gym A", { gymId: 'gym-a' }], ['Switch to Gym B', { gymId: 'gym-b' }],
  ])('derives exact condition values: %s', (text, changes) => { expect(derive(text)).toEqual({ kind: 'conditions', changes }) })

  it('does not partially save invalid, conflicting or ambiguous condition clauses', () => {
    for (const text of ['Set dinner budget to 70; Set dinner budget to 90', '今天只剩0分钟', 'Set gym-b-cable to nonexistent', 'Set available time to 20 minutes; delete everything', '换Gym A; cable被占']) {
      expect(derive(text)).toMatchObject({ kind: 'needs_input' })
    }
    expect(derive('晚餐预算改成70', { targetMealItemId: snapshot.meals[0].items[0].id })).toEqual({ kind: 'needs_input', errorCode: 'CONDITIONS_TARGET_REQUIRED' })
  })

  it.each(['我只有很多分钟', 'I have only minutes', 'I just ate', '我刚吃了', 'Delete', '撤销上一条', 'Start', '我只有20分钟;未知变更'])('asks for missing details of recognizable positive requests: %s', text => {
    expect(derive(text)).toMatchObject({ kind: 'needs_input' })
  })

  it('requires explicit or unique progress targets, with no per-set completion', () => {
    expect(derive('这个动作做完了')).toEqual({ kind: 'needs_input', errorCode: 'EXERCISE_TARGET_REQUIRED' })
    const exercise = snapshot.workout!.exercises[0]
    expect(derive('这个动作做完了', { targetExerciseId: exercise.id })).toEqual({ kind: 'progress', action: { kind: 'complete_exercise', workoutId: snapshot.workout!.id, exerciseId: exercise.id } })
    expect(derive('I finished seated cable row')).toMatchObject({ action: { exerciseId: exercise.id } })
    expect(derive('I finished set 1')).toMatchObject({ kind: 'needs_input' })
    snapshot.workout!.exercises.slice(1).forEach(item => { item.completed = true })
    expect(derive('这个动作做完了')).toMatchObject({ action: { exerciseId: exercise.id } })
  })

  it('uses the current workout target and requires actual minutes and incomplete consent', () => {
    expect(derive('开始训练')).toEqual({ kind: 'progress', action: { kind: 'start_workout', workoutId: snapshot.workout!.id } })
    expect(derive('开始训练', { targetWorkoutId: 'wrong-workout' })).toMatchObject({ kind: 'needs_input' })
    expect(derive('结束训练')).toEqual({ kind: 'needs_input', errorCode: 'ACTUAL_MINUTES_REQUIRED' })
    expect(derive('结束训练，实际20分钟')).toEqual({ kind: 'needs_input', errorCode: 'INCOMPLETE_CONFIRMATION_REQUIRED' })
    expect(derive('未完成也结束训练，实际20分钟')).toMatchObject({ action: { kind: 'finish_workout', actualMinutes: 20, confirmIncomplete: true } })
    expect(derive('Finish workout with unfinished exercises after 20 minutes')).toMatchObject({ action: { actualMinutes: 20, confirmIncomplete: true } })
    expect(derive('未完成也结束训练，实际0分钟')).toMatchObject({ kind: 'needs_input' })
    snapshot.workout!.exercises.forEach(item => { item.completed = true })
    expect(derive('Finish workout after 30 minutes')).toMatchObject({ action: { actualMinutes: 30, confirmIncomplete: false } })
    expect(snapshot.workout!.status).toBe('planned')
  })

  it('undo uses a real transport target or known meal head and never guesses an operation', () => {
    expect(derive('撤销刚才的修改')).toEqual({ kind: 'needs_input', errorCode: 'OPERATION_TARGET_REQUIRED' })
    expect(derive('撤销刚才的修改', { targetOperationId: 'operation-1' })).toEqual({ kind: 'undo', operationId: 'operation-1' })
    snapshot.meals[0].operationId = 'head-1'
    expect(derive('Undo this change', { targetMealId: snapshot.meals[0].id })).toEqual({ kind: 'undo', operationId: 'head-1' })
  })

  it('rejects old or foreign source identity and does not mutate the source snapshot', () => {
    const before = structuredClone(snapshot)
    for (const patch of [{ sessionId: 'other' }, { resetEpoch: snapshot.resetEpoch + 1 }, { conversationId: 'other' }]) {
      expect(derive('Log this meal', patch)).toEqual({ kind: 'needs_input', errorCode: 'SOURCE_CONTEXT_MISMATCH' })
    }
    derive('今天只剩20分钟')
    expect(snapshot).toEqual(before)
  })
})
