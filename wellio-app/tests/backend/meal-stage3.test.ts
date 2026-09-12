import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {ActionRequest, ActionResult, LocalizedText, Meal, Nutrients, Snapshot} from '../../src/lib/contracts'
import {createBackend} from '../../src/server/app'
import {WellioDatabase} from '../../src/server/database'
import type {StoredReply} from '../../src/server/database'
import {BackendError} from '../../src/server/errors'
import {authorizeUserMutation, recordUserMessage} from '../../src/server/authorization'
import {mutateMealLog} from '../../src/server/meal-service'
import {calculateDailyTotals} from '../../src/server/read-services'
import {SessionCookies} from '../../src/server/session'

const text = (en: string, zh: string): LocalizedText => ({en, 'zh-CN': zh})
const food = (name: LocalizedText, portion: LocalizedText, quantity: number, unit: 'g' | 'ml' | 'piece' | 'serving', base: Nutrients) => ({
  name, portion, originalPortion: {quantity, unit}, base,
  nutrientUnits: {energy: 'kcal' as const, mass: 'g' as const}, consumedFraction: 1, estimated: true,
})
const dinner = () => ({
  period: 'dinner' as const, time: '18:45', items: [
    food(text('Burger', '汉堡'), text('One burger', '一个汉堡'), 1, 'piece', {kcal: 500, protein: 25, carbs: 55, fat: 20}),
    food(text('Fries', '薯条'), text('100 g fries', '100 克薯条'), 100, 'g', {kcal: 300, protein: 4, carbs: 35, fat: 16}),
    food(text('Soft drink', '汽水'), text('400 ml drink', '400 毫升饮料'), 400, 'ml', {kcal: 160, protein: 0, carbs: 40, fat: 0}),
  ],
})

describe('Stage 3 meal mutations and operation-scoped undo', () => {
  let directory: string
  let databasePath: string
  let database: WellioDatabase
  let backend: ReturnType<typeof createBackend>
  let initial: Snapshot
  let cookie: string
  let sequence = 0

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-meal-test-'))
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
  const nextId = () => `meal-test-${++sequence}`

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

  async function state(): Promise<Snapshot> {
    const response = await backend.handleRequest(new Request('http://localhost/api/state', {headers: {cookie}}))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toMatch(/no-store/i)
    return await response.json() as Snapshot
  }

  function undoRequest(operationId: string): Extract<ActionRequest, {kind: 'undo_meal'}> {
    return {kind: 'undo_meal', operationId, requestId: nextId(), resetEpoch: current().resetEpoch, source: 'agent'}
  }

  async function action(request: unknown, sessionCookie = cookie) {
    const response = await backend.handleRequest(new Request('http://localhost/api/actions', {
      method: 'POST', headers: {cookie: sessionCookie, 'content-type': 'application/json'}, body: JSON.stringify(request),
    }))
    expect(response.headers.get('cache-control')).toMatch(/no-store/i)
    return {httpStatus: response.status, result: await response.json() as ActionResult}
  }

  function assertUnrelatedFacts(snapshot: Snapshot, before = initial) {
    expect(snapshot.profile).toEqual(before.profile)
    expect(snapshot.history).toEqual(before.history)
    expect(snapshot.workout).toEqual(before.workout)
    expect(snapshot.plan).toEqual(before.plan)
    expect(snapshot.readiness).toEqual(before.readiness)
    expect(snapshot.sleep).toEqual(before.sleep)
  }

  function authorize(content: string, targets: {targetMealId?: string; targetMealItemId?: string} = {}) {
    const snapshot = current()
    const message = recordUserMessage(database, initial.sessionId, {
      requestId: nextId(), resetEpoch: snapshot.resetEpoch, conversationId: snapshot.conversationId, content, ...targets,
    })
    expect(message.httpStatus).toBe(200)
    expect(message.result.status).toBe('succeeded')
    const sourceMessageId = (message.result as ActionResult & {messageId?: string}).messageId!
    expect(sourceMessageId).toBeTruthy()
    const runId = nextId()
    const authorization = authorizeUserMutation(database, initial.sessionId, {sourceMessageId, resetEpoch: snapshot.resetEpoch, runId})
    return {runId, authorizationId: authorization.id}
  }

  function mutation(input: unknown, sessionId = initial.sessionId): StoredReply {
    try { return mutateMealLog(database, sessionId, input) } catch (error) {
      if (!(error instanceof BackendError)) throw error
      return {httpStatus: error.httpStatus, result: {requestId: '', status: error.httpStatus === 409 ? 'conflict' : 'failed', errorCode: error.code}}
    }
  }

  function commit(input: unknown): ActionResult & {snapshot: Snapshot} {
    const reply = mutation(input)
    expect(reply.httpStatus).toBe(200)
    expect(reply.result.status).toBe('succeeded')
    expect(reply.result.snapshot).toBeDefined()
    return reply.result as ActionResult & {snapshot: Snapshot}
  }

  function meal(mealId: string): Meal {
    const found = current().meals.find(candidate => candidate.id === mealId)
    expect(found).toBeDefined()
    return found!
  }

  function addInput(draft = dinner()) {
    const grant = authorize('Log this meal.')
    return {kind: 'mutate_meal_log' as const, requestId: nextId(), resetEpoch: current().resetEpoch, ...grant, expectedMealRevision: current().mealRevision, action: 'add' as const, meal: draft}
  }

  function add(draft = dinner()) {
    const input = addInput(draft)
    const ids = new Set(current().meals.map(item => item.id))
    const result = commit(input)
    const saved = result.snapshot.meals.find(item => !ids.has(item.id))!
    expect(saved).toBeDefined()
    expect(result.operationId).toBeTruthy()
    return {input, result, meal: saved, operationId: result.operationId!}
  }

  function halfInput(mealId: string) {
    const saved = meal(mealId)
    const fries = saved.items.find(item => item.name.en === 'Fries')!
    const grant = authorize('I only ate half of the fries.', {targetMealId: mealId, targetMealItemId: fries.id})
    return {
      kind: 'mutate_meal_log' as const, requestId: nextId(), resetEpoch: current().resetEpoch, ...grant,
      expectedMealRevision: current().mealRevision, action: 'update' as const, mealId, mealItemId: fries.id,
      expectedMealVersion: saved.version, changes: {consumedFraction: 0.5},
    }
  }

  function baselineInput(mealId: string) {
    const saved = meal(mealId)
    const fries = saved.items.find(item => item.name.en === 'Fries')!
    const grant = authorize('Correct fries: 80 g; 240 kcal; protein 3 g; carbs 30 g; fat 12 g.', {targetMealId: mealId, targetMealItemId: fries.id})
    return {
      kind: 'mutate_meal_log' as const, requestId: nextId(), resetEpoch: current().resetEpoch, ...grant,
      expectedMealRevision: current().mealRevision, action: 'update' as const, mealId, mealItemId: fries.id,
      expectedMealVersion: saved.version, changes: {baseline: {
        portion: text('80 g', '80 g'), originalPortion: {quantity: 80, unit: 'g' as const},
        base: {kcal: 240, protein: 3, carbs: 30, fat: 12}, nutrientUnits: {energy: 'kcal' as const, mass: 'g' as const},
      }},
    }
  }

  function deleteInput(mealId: string, mealItemId?: string) {
    const saved = meal(mealId)
    const grant = authorize(mealItemId ? 'Delete the fries.' : 'Delete this meal.', {targetMealId: mealId, ...(mealItemId ? {targetMealItemId: mealItemId} : {})})
    return {
      kind: 'mutate_meal_log' as const, requestId: nextId(), resetEpoch: current().resetEpoch, ...grant,
      expectedMealRevision: current().mealRevision, action: 'delete' as const, mealId, expectedMealVersion: saved.version,
      ...(mealItemId ? {mealItemId} : {}),
    }
  }

  async function undo(operationId: string, request = undoRequest(operationId)): Promise<ActionResult & {snapshot: Snapshot}> {
    const reply = await action(request)
    expect(reply.httpStatus).toBe(200)
    expect(reply.result.status).toBe('succeeded')
    expect(reply.result.snapshot).toBeDefined()
    return reply.result as ActionResult & {snapshot: Snapshot}
  }

  const operationRows = () => inspect(connection => connection.prepare('SELECT * FROM meal_operations ORDER BY rowid').all())

  it('adds three independently identified foods with their original portions and server-calculated totals', async () => {
    const draft = dinner()
    const untouched = structuredClone(draft)
    const added = add(draft)
    expect(draft).toEqual(untouched)
    expect(added.meal.id).toBeTruthy()
    expect(added.meal.version).toBe(1)
    expect(added.meal.items).toHaveLength(3)
    expect(new Set(added.meal.items.map(item => item.id)).size).toBe(3)
    expect(added.meal.items.map(({id: _id, ...item}) => item)).toEqual(draft.items)
    expect(added.result.snapshot.meals.slice(0, 2)).toEqual(initial.meals)
    expect(added.result.snapshot.mealRevision).toBe(initial.mealRevision + 1)
    expect(calculateDailyTotals(added.result.snapshot)).toMatchObject({
      consumed: {kcal: 2610, protein: 119, carbs: 340, fat: 86},
      remaining: {kcal: -210, protein: 21, carbs: -60, fat: -6}, energyDeficit: -110,
    })
    expect(operationRows()).toHaveLength(1)
    assertUnrelatedFacts(added.result.snapshot)
    expect(await state()).toEqual(current())
  })

  it('sets fries to one half absolutely and treats a new half request as a no-op', () => {
    const added = add()
    expect(added.result.nutrition).toMatchObject({
      meal: {mealId: added.meal.id, total: {kcal: 960, protein: 29, carbs: 130, fat: 36}},
      day: {consumed: {kcal: 2610, protein: 119, carbs: 340, fat: 86}, energyDeficit: -110},
    })
    const half = commit(halfInput(added.meal.id))
    const corrected = meal(added.meal.id)
    expect(corrected.items.map(item => item.consumedFraction)).toEqual([1, 0.5, 1])
    expect(corrected.items[0]).toEqual(added.meal.items[0])
    expect(corrected.items[2]).toEqual(added.meal.items[2])
    expect(corrected.items[1].base).toEqual(added.meal.items[1].base)
    expect(corrected.items[1].originalPortion).toEqual(added.meal.items[1].originalPortion)
    expect(calculateDailyTotals(half.snapshot).consumed).toEqual({kcal: 2460, protein: 117, carbs: 322.5, fat: 78})
    expect(half.nutrition?.meal).toEqual({
      mealId: added.meal.id, total: {kcal: 810, protein: 27, carbs: 112.5, fat: 28}, items: [
        {mealItemId: added.meal.items[0].id, total: {kcal: 500, protein: 25, carbs: 55, fat: 20}},
        {mealItemId: added.meal.items[1].id, total: {kcal: 150, protein: 2, carbs: 17.5, fat: 8}},
        {mealItemId: added.meal.items[2].id, total: {kcal: 160, protein: 0, carbs: 40, fat: 0}},
      ],
    })
    expect(half.nutrition?.day).toMatchObject({
      consumed: {kcal: 2460, protein: 117, carbs: 322.5, fat: 78},
      remaining: {kcal: -60, protein: 23, carbs: -42.5, fat: 2}, energyDeficit: 40,
    })
    const repeat = halfInput(added.meal.id)
    const beforeNoop = current()
    const rows = operationRows()
    const noop = commit(repeat)
    expect(noop.snapshot).toEqual(beforeNoop)
    expect(noop.nutrition).toEqual(half.nutrition)
    expect(noop.operationId).toBeUndefined()
    expect(operationRows()).toEqual(rows)
    expect(meal(added.meal.id).version).toBe(corrected.version)
    expect(calculateDailyTotals(current()).consumed).toEqual({kcal: 2460, protein: 117, carbs: 322.5, fat: 78})
  })

  it('corrects the original fries baseline separately while retaining the already consumed fraction', () => {
    const added = add()
    commit(halfInput(added.meal.id))
    const result = commit(baselineInput(added.meal.id))
    const corrected = meal(added.meal.id)
    expect(corrected.items[1]).toMatchObject({
      consumedFraction: 0.5, portion: text('80 g', '80 g'), originalPortion: {quantity: 80, unit: 'g'},
      base: {kcal: 240, protein: 3, carbs: 30, fat: 12}, nutrientUnits: {energy: 'kcal', mass: 'g'},
    })
    expect(corrected.items[0]).toEqual(added.meal.items[0])
    expect(corrected.items[2]).toEqual(added.meal.items[2])
    expect(calculateDailyTotals(result.snapshot).consumed).toEqual({kcal: 2430, protein: 116.5, carbs: 320, fat: 76})
    const mixed = baselineInput(added.meal.id)
    const before = current()
    const rejected = mutation({...mixed, changes: {...mixed.changes, consumedFraction: 1}})
    expect(rejected.httpStatus).toBe(400)
    expect(rejected.result.errorCode).toBe('INVALID_INPUT')
    expect(current()).toEqual(before)
  })

  it('undoes an add without removing the source messages or changing unrelated fitness data', async () => {
    const added = add()
    const beforeUndo = current()
    const automatic = await action({...undoRequest(added.operationId), source: 'app_open'})
    expect(automatic.httpStatus).toBe(403)
    expect(automatic.result.errorCode).toBe('MEAL_REQUIRES_USER_ACTION')
    expect(current()).toEqual(beforeUndo)
    const undone = await undo(added.operationId)
    expect(undone.snapshot.meals).toEqual(initial.meals)
    expect(undone.snapshot.mealRevision).toBe(added.result.snapshot.mealRevision + 1)
    expect(undone.snapshot.messages).toEqual(added.result.snapshot.messages)
    expect(calculateDailyTotals(undone.snapshot).consumed).toEqual({kcal: 1650, protein: 90, carbs: 210, fat: 50})
    assertUnrelatedFacts(undone.snapshot)
    expect(operationRows()).toHaveLength(1)
    const persisted = inspect(connection => connection.prepare('SELECT record_json FROM meal_operations WHERE id = ?').get(added.operationId)?.record_json)
    expect(JSON.parse(String(persisted))).toMatchObject({id: added.operationId, action: 'add', status: 'undone', before: null})
  })

  it('undoes a fraction correction using its prior value and leaves the other foods intact', async () => {
    const added = add()
    const half = commit(halfInput(added.meal.id))
    const undone = await undo(half.operationId!)
    expect(meal(added.meal.id).items).toEqual(added.meal.items)
    expect(meal(added.meal.id).version).toBeGreaterThan(half.snapshot.meals.find(item => item.id === added.meal.id)!.version)
    expect(calculateDailyTotals(undone.snapshot).consumed).toEqual({kcal: 2610, protein: 119, carbs: 340, fat: 86})
    assertUnrelatedFacts(undone.snapshot)
  })

  it('undoes a baseline correction without converting the original portion into another fraction change', async () => {
    const added = add()
    commit(halfInput(added.meal.id))
    const half = meal(added.meal.id)
    const baseline = commit(baselineInput(added.meal.id))
    await undo(baseline.operationId!)
    expect(meal(added.meal.id).items).toEqual(half.items)
    expect(calculateDailyTotals(current()).consumed).toEqual({kcal: 2460, protein: 117, carbs: 322.5, fat: 78})
  })

  it('deletes one food and undo restores the same IDs and original order', async () => {
    const added = add()
    const friesId = added.meal.items[1].id
    const deleted = commit(deleteInput(added.meal.id, friesId))
    expect(meal(added.meal.id).items).toEqual([added.meal.items[0], added.meal.items[2]])
    expect(calculateDailyTotals(current()).consumed).toEqual({kcal: 2310, protein: 115, carbs: 305, fat: 70})
    await undo(deleted.operationId!)
    expect(meal(added.meal.id).items).toEqual(added.meal.items)
    expect(operationRows()).toHaveLength(2)
  })

  it('deletes and restores a whole meal without changing the other meals', async () => {
    const added = add()
    const deleted = commit(deleteInput(added.meal.id))
    expect(deleted.snapshot.meals).toEqual(initial.meals)
    const undone = await undo(deleted.operationId!)
    const restored = meal(added.meal.id)
    expect(restored.items).toEqual(added.meal.items)
    expect(restored).toMatchObject({id: added.meal.id, period: added.meal.period, time: added.meal.time})
    expect(undone.snapshot.meals.slice(0, 2)).toEqual(initial.meals)
    expect(restored.version).toBeGreaterThan(added.meal.version)
  })

  it('removes a meal when its last food is deleted and undo restores that meal and food', async () => {
    const draft = dinner()
    draft.items = [draft.items[1]]
    const added = add(draft)
    const deleted = commit(deleteInput(added.meal.id, added.meal.items[0].id))
    expect(deleted.snapshot.meals.some(item => item.id === added.meal.id)).toBe(false)
    await undo(deleted.operationId!)
    expect(meal(added.meal.id).items).toEqual(added.meal.items)
    expect(current().meals).toHaveLength(initial.meals.length + 1)
  })

  it('makes repeated undo a no-op and never overwrites a later valid edit', async () => {
    const added = add()
    const half = commit(halfInput(added.meal.id))
    const body = undoRequest(half.operationId!)
    const first = await undo(half.operationId!, body)
    expect(await undo(half.operationId!, body)).toEqual(first)
    const duplicate = await undo(half.operationId!)
    expect(duplicate.snapshot).toEqual(first.snapshot)
    const baseline = commit(baselineInput(added.meal.id))
    const before = current()
    const repeatedAfterEdit = await undo(half.operationId!)
    expect(repeatedAfterEdit.snapshot).toEqual(before)
    expect(meal(added.meal.id).items[1].base.kcal).toBe(240)
    expect(baseline.operationId).not.toBe(half.operationId)
  })

  it('refuses to undo an older operation after a later edit to the same meal', async () => {
    const added = add()
    const half = commit(halfInput(added.meal.id))
    commit(baselineInput(added.meal.id))
    const before = current()
    for (const operationId of [added.operationId, half.operationId!]) {
      const rejected = await action(undoRequest(operationId))
      expect(rejected.httpStatus).toBe(409)
      expect(rejected.result).toMatchObject({status: 'conflict', errorCode: 'UNDO_CONFLICT'})
    }
    expect(current()).toEqual(before)
  })

  it('can undo one meal while keeping later changes to a different meal', async () => {
    const first = add()
    const halfFirst = commit(halfInput(first.meal.id))
    const second = add()
    commit(halfInput(second.meal.id))
    const secondBeforeUndo = meal(second.meal.id)
    const beforeRevision = current().mealRevision
    const undone = await undo(halfFirst.operationId!)
    expect(meal(first.meal.id).items).toEqual(first.meal.items)
    expect(meal(second.meal.id)).toEqual(secondBeforeUndo)
    expect(undone.snapshot.mealRevision).toBe(beforeRevision + 1)
    assertUnrelatedFacts(undone.snapshot)
  })

  it('retains same-cookie state and exact request receipts after closing and reopening SQLite', async () => {
    const added = add()
    const half = halfInput(added.meal.id)
    const saved = commit(half)
    reopen()
    expect(await state()).toEqual(saved.snapshot)
    expect(commit(added.input)).toEqual(added.result)
    expect(commit(half)).toEqual(saved)
    expect(current()).toEqual(saved.snapshot)
    const body = undoRequest(saved.operationId!)
    const undone = await undo(saved.operationId!, body)
    reopen()
    expect(await state()).toEqual(undone.snapshot)
    expect(await undo(saved.operationId!, body)).toEqual(undone)
    expect(operationRows()).toHaveLength(2)
  })

  it('rejects replaying the same request ID with different meal contents', () => {
    const added = add()
    const changed = structuredClone(added.input)
    changed.meal.items[0].base.kcal = 600
    const rejected = mutation(changed)
    expect(rejected.httpStatus).toBe(409)
    expect(rejected.result.errorCode).toBe('IDEMPOTENCY_CONFLICT')
    expect(current()).toEqual(added.result.snapshot)
    expect(operationRows()).toHaveLength(1)
  })

  it('refuses stale meal revisions and prevents rebasing an old grant by changing its expected versions', () => {
    const added = add()
    const staleGlobal = halfInput(added.meal.id)
    commit(baselineInput(added.meal.id))
    const before = current()
    const globalReply = mutation(staleGlobal)
    expect(globalReply.httpStatus).toBe(409)
    expect(globalReply.result.errorCode).toBe('VERSION_CONFLICT')
    const staleMeal = {...staleGlobal, requestId: nextId(), expectedMealRevision: before.mealRevision}
    const mealReply = mutation(staleMeal)
    expect(mealReply.httpStatus).toBe(403)
    expect(mealReply.result.errorCode).toBe('AUTHORIZATION_MISMATCH')
    expect(current()).toEqual(before)
  })

  it('rejects old-epoch meal requests and undo after reset', async () => {
    const added = add()
    const oldUpdate = halfInput(added.meal.id)
    const oldUndo = undoRequest(added.operationId)
    const reset = await action({kind: 'reset_demo', requestId: nextId(), resetEpoch: current().resetEpoch, source: 'profile', scenario: 'low_recovery'})
    expect(reset.httpStatus).toBe(200)
    for (const input of [added.input, oldUpdate]) {
      const rejected = mutation(input)
      expect(rejected.httpStatus).toBe(409)
      expect(rejected.result.errorCode).toBe('STALE_EPOCH')
    }
    const rejectedUndo = await action(oldUndo)
    expect(rejectedUndo.httpStatus).toBe(409)
    expect(rejectedUndo.result.errorCode).toBe('STALE_EPOCH')
    expect(current()).toEqual(reset.result.snapshot)
    expect(current().meals).toEqual(initial.meals)
  })

  it('rejects another session\'s authorization and operation ID', async () => {
    const added = add()
    const other = database.createSession(Date.now() + 300_000)
    const input = halfInput(added.meal.id)
    const rejectedMutation = mutation(input, other.sessionId)
    expect(rejectedMutation.httpStatus).toBe(403)
    expect(database.getSnapshot(other.sessionId)).toEqual(other)
    const otherCookie = new SessionCookies(database.signingKey).issue(other.sessionId, Date.now() + 300_000, false).split(';')[0]
    const rejectedUndo = await action({...undoRequest(added.operationId), resetEpoch: other.resetEpoch}, otherCookie)
    expect(rejectedUndo.httpStatus).toBe(404)
    expect(rejectedUndo.result.errorCode).toBe('NOT_FOUND')
    expect(database.getSnapshot(other.sessionId)).toEqual(other)
    expect(meal(added.meal.id).items).toEqual(added.meal.items)
  })

  it('does not trust a claimed source, invented authorization, or public HTTP meal mutation', async () => {
    const input = {kind: 'mutate_meal_log', requestId: nextId(), resetEpoch: initial.resetEpoch, runId: nextId(), expectedMealRevision: initial.mealRevision, action: 'add', meal: dinner()}
    const missing = mutation({...input, source: 'user'})
    expect(missing.httpStatus).toBe(400)
    expect(missing.result.errorCode).toBe('INVALID_INPUT')
    const invented = mutation({...input, authorizationId: 'invented-authorization'})
    expect(invented.httpStatus).toBe(403)
    const publicAction = await action({...input, authorizationId: 'invented-authorization', source: 'agent'})
    expect(publicAction.httpStatus).toBe(400)
    expect(publicAction.result.errorCode).toBe('INVALID_INPUT')
    expect(current()).toEqual(initial)
    expect(operationRows()).toEqual([])
  })

  it('does not apply an older authorized edit after its target meal has been removed', () => {
    const added = add()
    const waiting = halfInput(added.meal.id)
    commit(deleteInput(added.meal.id))
    const before = current()
    const rejected = mutation(waiting)
    expect(rejected.httpStatus).toBe(409)
    expect(rejected.result.errorCode).toBe('VERSION_CONFLICT')
    expect(current()).toEqual(before)
  })

  it('rejects unknown meal, item, and operation IDs without creating a target or changing state', async () => {
    const added = add()
    const before = current()
    for (const targets of [
      {targetMealId: 'unknown-meal'},
      {targetMealId: added.meal.id, targetMealItemId: 'unknown-food'},
    ]) {
      expect(() => recordUserMessage(database, initial.sessionId, {
        requestId: nextId(), resetEpoch: before.resetEpoch, conversationId: before.conversationId,
        content: 'Delete this meal.', ...targets,
      })).toThrow('NOT_FOUND')
      expect(current()).toEqual(before)
    }
    const missingOperation = await action(undoRequest('unknown-operation'))
    expect(missingOperation.httpStatus).toBe(404)
    expect(missingOperation.result.errorCode).toBe('NOT_FOUND')
    expect(current()).toEqual(before)
  })

  it('rejects altered targets, fractions, versions, and run IDs under an otherwise valid authorization', () => {
    const added = add()
    const input = halfInput(added.meal.id)
    const before = current()
    for (const altered of [
      {...input, changes: {consumedFraction: 0.25}},
      {...input, mealItemId: added.meal.items[0].id},
      {...input, expectedMealVersion: input.expectedMealVersion + 1},
    ]) {
      const rejected = mutation(altered)
      expect(rejected.httpStatus).toBe(403)
      expect(rejected.result.errorCode).toBe('AUTHORIZATION_MISMATCH')
      expect(current()).toEqual(before)
    }
    const wrongRun = mutation({...input, runId: 'another-run'})
    expect(wrongRun.httpStatus).toBe(403)
    expect(current()).toEqual(before)
    const accepted = commit(input)
    const reusedGrant = mutation({...input, requestId: nextId()})
    expect(reusedGrant.httpStatus).toBe(409)
    expect(reusedGrant.result.errorCode).toBe('AUTHORIZATION_CONSUMED')
    expect(current()).toEqual(accepted.snapshot)
  })

  it('rejects invalid portions, units, fractions, nutrients, and client-issued food IDs before consuming a grant', () => {
    const input = addInput()
    const before = current()
    const invalidItems = [
      {...input.meal.items[0], originalPortion: {quantity: 0, unit: 'piece'}},
      {...input.meal.items[0], originalPortion: {quantity: 1, unit: 'cup'}},
      {...input.meal.items[0], consumedFraction: -0.1},
      {...input.meal.items[0], consumedFraction: 1.1},
      {...input.meal.items[0], base: {...input.meal.items[0].base, kcal: -1}},
      {...input.meal.items[0], nutrientUnits: {energy: 'kJ', mass: 'g'}},
      {...input.meal.items[0], id: 'client-issued-food-id'},
    ]
    for (const item of invalidItems) {
      const rejected = mutation({...input, meal: {...input.meal, items: [item]}})
      expect(rejected.httpStatus).toBe(400)
      expect(rejected.result.errorCode).toBe('INVALID_INPUT')
      expect(current()).toEqual(before)
    }
    const rejectedMealId = mutation({...input, meal: {...input.meal, id: 'client-issued-meal-id'}})
    expect(rejectedMealId.httpStatus).toBe(400)
    expect(current()).toEqual(before)
    const recovered = commit(input)
    expect(recovered.snapshot.meals).toHaveLength(initial.meals.length + 1)
  })

  it('allows only one of two independently authorized writes prepared against the same meal revision', async () => {
    const added = add()
    const first = halfInput(added.meal.id)
    const second = halfInput(added.meal.id)
    expect(first.authorizationId).not.toBe(second.authorizationId)
    expect(first.expectedMealRevision).toBe(second.expectedMealRevision)
    const replies = await Promise.all([first, second].map(input => Promise.resolve().then(() => mutation(input))))
    expect(replies.map(reply => reply.httpStatus).sort()).toEqual([200, 409])
    expect(replies.find(reply => reply.httpStatus === 409)?.result.errorCode).toBe('VERSION_CONFLICT')
    expect(meal(added.meal.id).items.map(item => item.consumedFraction)).toEqual([1, 0.5, 1])
    expect(operationRows()).toHaveLength(2)
  })

  it('rolls back meal, operation, entity head, receipt, and authorization consumption after a receipt SQL failure', () => {
    const input = addInput()
    const before = current()
    const rows = operationRows()
    const heads = inspect(connection => connection.prepare('SELECT * FROM meal_entities ORDER BY rowid').all())
    inspect(connection => connection.exec(`CREATE TRIGGER reject_meal_receipt BEFORE INSERT ON action_requests
      WHEN NEW.kind = 'mutate_meal_log'
      BEGIN SELECT RAISE(ABORT, 'forced meal receipt failure'); END;`))
    expect(() => mutateMealLog(database, initial.sessionId, input)).toThrow('forced meal receipt failure')
    reopen()
    expect(current()).toEqual(before)
    expect(operationRows()).toEqual(rows)
    expect(inspect(connection => connection.prepare('SELECT * FROM meal_entities ORDER BY rowid').all())).toEqual(heads)
    inspect(connection => connection.exec('DROP TRIGGER reject_meal_receipt'))
    const retried = commit(input)
    expect(retried.snapshot.meals).toHaveLength(initial.meals.length + 1)
    expect(operationRows()).toHaveLength(rows.length + 1)
  })

  it('rolls back an undo if saving its HTTP receipt fails and can retry the same operation', async () => {
    const added = add()
    const half = commit(halfInput(added.meal.id))
    const body = undoRequest(half.operationId!)
    const before = current()
    const rows = operationRows()
    inspect(connection => connection.exec(`CREATE TRIGGER reject_undo_receipt BEFORE INSERT ON action_requests
      WHEN NEW.kind = 'undo_meal'
      BEGIN SELECT RAISE(ABORT, 'forced undo receipt failure'); END;`))
    const failed = await action(body)
    expect(failed.httpStatus).toBe(500)
    expect(failed.result.errorCode).toBe('INTERNAL_ERROR')
    expect(current()).toEqual(before)
    expect(operationRows()).toEqual(rows)
    inspect(connection => connection.exec('DROP TRIGGER reject_undo_receipt'))
    const retried = await undo(half.operationId!, body)
    expect(retried.snapshot.meals.find(item => item.id === added.meal.id)!.items).toEqual(added.meal.items)
  })
})
