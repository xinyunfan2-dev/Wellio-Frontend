import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {ActionInput, ActionRequest, ActionResult, Snapshot} from '../../src/lib/contracts'
import {createBackend} from '../../src/server/app'
import {SessionCookies} from '../../src/server/session'

type Backend = ReturnType<typeof createBackend>
type Session = {cookie: string; snapshot: Snapshot}

describe('Stage 1 persistent backend through its HTTP handler', () => {
  let directory: string
  let databasePath: string
  let backend: Backend
  const opened = new Set<Backend>()
  let requestSequence = 0

  function open() {
    const instance = createBackend({databasePath, cookieSecure: false})
    opened.add(instance)
    return instance
  }

  function close(instance: Backend) {
    instance.close()
    opened.delete(instance)
  }

  function inspect<T>(run: (connection: DatabaseSync) => T): T {
    const connection = new DatabaseSync(databasePath)
    try { return run(connection) } finally { connection.close() }
  }

  function expectClearedSessionCookie(response: Response, secure = false) {
    const cookie = response.headers.get('set-cookie')
    expect(cookie).toMatch(/^wellio_session=;/)
    expect(cookie).toMatch(/;\s*Path=\/(?:;|$)/i)
    expect(cookie).toMatch(/;\s*HttpOnly(?:;|$)/i)
    expect(cookie).toMatch(/;\s*SameSite=Lax(?:;|$)/i)
    expect(cookie).toMatch(/;\s*Max-Age=0(?:;|$)/i)
    const expires = cookie!.match(/;\s*Expires=([^;]+)/i)
    expect(expires).not.toBeNull()
    expect(Date.parse(expires![1])).toBeLessThan(Date.now())
    expect(/;\s*Secure(?:;|$)/i.test(cookie!)).toBe(secure)
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-backend-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    backend = open()
    requestSequence = 0
  })

  afterEach(() => {
    for (const instance of opened) instance.close()
    opened.clear()
    rmSync(directory, {recursive: true, force: true})
  })

  async function request(path: string, init?: RequestInit) {
    const response = await backend.handleRequest(new Request(`http://localhost${path}`, init))
    expect(response.headers.get('cache-control')).toMatch(/\bno-store\b/i)
    return response
  }

  async function start(): Promise<Session> {
    const response = await request('/api/state')
    expect(response.status).toBe(200)
    const setCookie = response.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    expect(setCookie).toMatch(/;\s*HttpOnly(?:;|$)/i)
    expect(setCookie).toMatch(/;\s*SameSite=Lax(?:;|$)/i)
    expect(setCookie).not.toMatch(/;\s*Secure(?:;|$)/i)
    return {cookie: setCookie!.split(';')[0], snapshot: await response.json() as Snapshot}
  }

  async function state(cookie: string): Promise<Snapshot> {
    const response = await request('/api/state', {headers: {cookie}})
    expect(response.status).toBe(200)
    return await response.json() as Snapshot
  }

  function actionInput<T extends ActionInput>(snapshot: Snapshot, action: T): T & Pick<ActionRequest, 'requestId' | 'resetEpoch' | 'source'> {
    return {...action, requestId: `test-request-${++requestSequence}`, resetEpoch: snapshot.resetEpoch, source: 'profile'}
  }

  async function action(cookie: string, body: unknown) {
    const response = await request('/api/actions', {
      method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(body),
    })
    return {response, result: await response.json() as ActionResult}
  }

  async function success(cookie: string, body: ActionRequest): Promise<ActionResult & {snapshot: Snapshot}> {
    const {response, result} = await action(cookie, body)
    expect(response.status).toBe(200)
    expect(result).toMatchObject({requestId: body.requestId, status: 'succeeded'})
    expect(result.snapshot).toBeDefined()
    return result as ActionResult & {snapshot: Snapshot}
  }

  it('issues separate server sessions and keeps mutations isolated', async () => {
    const first = await start()
    const second = await start()
    expect(first.cookie).not.toBe(second.cookie)
    expect(first.snapshot.sessionId).not.toBe(second.snapshot.sessionId)
    expect(first.snapshot.conversationId).not.toBe(second.snapshot.conversationId)
    expect(first.snapshot.sessionId).not.toBe('preview-session')
    expect(first.snapshot.conversationId).not.toBe('preview-conversation')
    expect(first.snapshot.capabilities).toEqual({agent: false, menuSearch: false, persistence: 'server'})

    const updated = await success(first.cookie, actionInput(first.snapshot, {kind: 'set_locale', locale: 'zh-CN'}))
    expect(updated.snapshot.locale).toBe('zh-CN')
    expect(await state(first.cookie)).toEqual(updated.snapshot)
    expect(await state(second.cookie)).toEqual(second.snapshot)
  })

  it('persists the signed session, state, and request result across close and reopen', async () => {
    const session = await start()
    const body = actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    const saved = await success(session.cookie, body)
    close(backend)
    backend = open()

    expect(await state(session.cookie)).toEqual(saved.snapshot)
    expect(await success(session.cookie, body)).toEqual(saved)
    expect(await state(session.cookie)).toEqual(saved.snapshot)
    const another = await start()
    expect(another.snapshot.sessionId).not.toBe(saved.snapshot.sessionId)
    expect(another.snapshot.locale).toBe('en')
  })

  it('serves the documented seed ledger with stable dates and no fabricated completed work', async () => {
    const {cookie, snapshot} = await start()
    expect(snapshot).toMatchObject({
      dayKey: '2026-09-12', timeZone: 'Asia/Hong_Kong', locale: 'en', scenario: 'normal',
      profile: {name: 'Alex', goal: 'muscle_gain', targets: {kcal: 2400, protein: 140, carbs: 280, fat: 80}, dinnerBudget: 100, expenditure: 2500},
      readiness: {quality: 'valid', score: 82, scoreScale: 100, restingHeartRate: 60, baselineHeartRate: 60, baselineSleepMinutes: 450, source: 'mock_watch'},
      sleep: {minutes: 450, bedtime: '2026-09-11T23:30:00+08:00', wakeTime: '2026-09-12T07:00:00+08:00', source: 'mock_watch'},
      advice: {status: 'unavailable', errorCode: 'PROVIDER_NOT_CONFIGURED'},
      messages: [], proposals: [],
    })
    const nutrients = snapshot.meals.flatMap(meal => meal.items).reduce((sum, item) => ({
      kcal: sum.kcal + item.base.kcal * item.consumedFraction,
      protein: sum.protein + item.base.protein * item.consumedFraction,
      carbs: sum.carbs + item.base.carbs * item.consumedFraction,
      fat: sum.fat + item.base.fat * item.consumedFraction,
    }), {kcal: 0, protein: 0, carbs: 0, fat: 0})
    expect(nutrients).toEqual({kcal: 1650, protein: 90, carbs: 210, fat: 50})
    expect(snapshot.meals.map(meal => meal.period)).toEqual(['breakfast', 'lunch'])
    expect(snapshot.history.weight).toHaveLength(14)
    expect(snapshot.history.weight[0]).toEqual({date: '2026-08-29', kg: 70})
    expect(snapshot.history.weight.at(-1)).toEqual({date: '2026-09-11', kg: 70.4})
    expect(snapshot.history.training.filter(day => day.minutes > 0)).toHaveLength(7)
    expect(snapshot.history.training.reduce((sum, day) => sum + day.minutes, 0)).toBe(270)
    expect(snapshot.history.training.slice(-7).reduce((sum, day) => sum + day.minutes, 0)).toBe(115)
    expect(snapshot.history.nutrition.reduce((sum, day) => sum + day.expenditure - day.kcal, 0)).toBe(2568)
    expect(snapshot.history.nutrition.slice(-7).reduce((sum, day) => sum + day.expenditure - day.kcal, 0)).toBe(999)
    expect(snapshot.workout?.status).toBe('planned')
    expect(snapshot.workout?.exercises.every(exercise => !exercise.completed)).toBe(true)
    expect(snapshot.plan.sessions.map(session => [session.split, session.date, session.status])).toEqual([
      ['Pull', '2026-09-12', 'pending'], ['Legs', '2026-09-14', 'pending'], ['Push', '2026-09-16', 'pending'],
    ])
    expect(snapshot.plan.availableSlots.map(slot => slot.date)).toEqual([
      '2026-09-12', '2026-09-14', '2026-09-16', '2026-09-18', '2026-09-21', '2026-09-23', '2026-09-25',
    ])
    expect(await state(cookie)).toEqual(snapshot)
  })

  it('links all three suggested loads to matching documented history records', async () => {
    const {snapshot} = await start()
    const expected = [
      {catalogId: 'seated-cable-row', historyId: 'load-b-0910-cable-row', equipmentId: 'gym-b-cable', kg: 35, basis: 'machine_stack'},
      {catalogId: 'lat-pulldown', historyId: 'load-b-0910-pulldown', equipmentId: 'gym-b-cable', kg: 40, basis: 'machine_stack'},
      {catalogId: 'dumbbell-curl', historyId: 'load-b-0910-curl', equipmentId: 'gym-b-dumbbells', kg: 10, basis: 'per_hand'},
    ]
    expect(snapshot.workout?.exercises).toHaveLength(3)
    expect(new Set(snapshot.history.load.map(record => record.id)).size).toBe(snapshot.history.load.length)
    for (const entry of expected) {
      const exercise = snapshot.workout?.exercises.find(candidate => candidate.catalogId === entry.catalogId)
      expect(exercise).toBeDefined()
      expect(exercise?.equipmentId).toBe(entry.equipmentId)
      expect(exercise?.suggestedLoad).toMatchObject({value: entry.kg, unit: 'kg', basis: entry.basis, source: 'mock_history', sourceHistoryId: entry.historyId})
      const source = snapshot.history.load.find(record => record.id === exercise?.suggestedLoad.sourceHistoryId)
      expect(source).toMatchObject({id: entry.historyId, date: '2026-09-10', exerciseId: entry.catalogId, equipmentId: entry.equipmentId, kg: entry.kg, basis: entry.basis, source: 'mock_history'})
    }
  })

  it('changes the locale without changing the stored fitness facts', async () => {
    const session = await start()
    const result = await success(session.cookie, actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'}))
    expect(result.snapshot.revision).toBe(session.snapshot.revision + 1)
    expect({...result.snapshot, locale: session.snapshot.locale, revision: session.snapshot.revision}).toEqual(session.snapshot)
  })

  it('replays the original result without applying an old action over newer state', async () => {
    const session = await start()
    const chinese = actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    const original = await success(session.cookie, chinese)
    const latest = await success(session.cookie, actionInput(original.snapshot, {kind: 'set_locale', locale: 'en'}))
    // Property ordering is not part of the request's semantic identity.
    const reordered: ActionRequest = {source: chinese.source, resetEpoch: chinese.resetEpoch, requestId: chinese.requestId, locale: 'zh-CN', kind: 'set_locale'}
    expect(await success(session.cookie, reordered)).toEqual(original)
    expect(await state(session.cookie)).toEqual(latest.snapshot)
  })

  it('rejects different payloads under the same request ID without changing state', async () => {
    const session = await start()
    const body = actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    const original = await success(session.cookie, body)
    for (const altered of [{...body, locale: 'en'}, {...body, source: 'today'}]) {
      const {response, result} = await action(session.cookie, altered)
      expect(response.status).toBe(409)
      expect(result).toMatchObject({requestId: body.requestId, status: 'conflict', errorCode: 'IDEMPOTENCY_CONFLICT'})
    }
    expect(await state(session.cookie)).toEqual(original.snapshot)
  })

  it('scopes idempotency keys to each session', async () => {
    const first = await start()
    const second = await start()
    const body = actionInput(first.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    const firstResult = await success(first.cookie, body)
    const secondResult = await success(second.cookie, {...body, locale: 'en'})
    expect(firstResult.snapshot.sessionId).toBe(first.snapshot.sessionId)
    expect(secondResult.snapshot.sessionId).toBe(second.snapshot.sessionId)
    expect(await state(first.cookie)).toEqual(firstResult.snapshot)
    expect(await state(second.cookie)).toEqual(secondResult.snapshot)
  })

  it('resets the scenario in a new epoch and conversation while preserving locale and session', async () => {
    const session = await start()
    const localized = await success(session.cookie, actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'}))
    const reset = await success(session.cookie, actionInput(localized.snapshot, {kind: 'reset_demo', scenario: 'low_recovery'}))
    expect(reset.snapshot.resetEpoch).toBe(session.snapshot.resetEpoch + 1)
    expect(reset.snapshot.sessionId).toBe(session.snapshot.sessionId)
    expect(reset.snapshot.conversationId).not.toBe(session.snapshot.conversationId)
    expect(reset.snapshot.locale).toBe('zh-CN')
    expect(reset.snapshot.scenario).toBe('low_recovery')
    expect(reset.snapshot.readiness).toMatchObject({score: 42, restingHeartRate: 72, guidanceHint: 'consider_rest'})
    expect(reset.snapshot.sleep).toMatchObject({minutes: 240, bedtime: '2026-09-12T03:00:00+08:00'})
    for (const key of ['profile', 'history', 'meals', 'workout', 'plan', 'conditions'] as const) {
      expect(reset.snapshot[key]).toEqual(session.snapshot[key])
    }
    expect(reset.snapshot.messages).toEqual([])
    expect(reset.snapshot.proposals).toEqual([])
    expect(await state(session.cookie)).toEqual(reset.snapshot)
  })

  it('replays the latest reset result after restart without undoing newer mutations', async () => {
    const session = await start()
    const body = actionInput(session.snapshot, {kind: 'reset_demo', scenario: 'low_recovery'})
    const original = await success(session.cookie, body)
    expect(await success(session.cookie, body)).toEqual(original)
    const latest = await success(session.cookie, actionInput(original.snapshot, {kind: 'set_locale', locale: 'zh-CN'}))
    close(backend)
    backend = open()
    expect(await success(session.cookie, body)).toEqual(original)
    expect(await state(session.cookie)).toEqual(latest.snapshot)
  })

  it('rejects earlier epoch actions and an older reset after a subsequent reset', async () => {
    const session = await start()
    const oldLocale = actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    await success(session.cookie, oldLocale)
    const firstBody = actionInput(session.snapshot, {kind: 'reset_demo', scenario: 'low_recovery'})
    const firstReset = await success(session.cookie, firstBody)
    const secondReset = await success(session.cookie, actionInput(firstReset.snapshot, {kind: 'reset_demo', scenario: 'normal'}))
    expect(secondReset.snapshot.resetEpoch).toBe(session.snapshot.resetEpoch + 2)
    expect(secondReset.snapshot.conversationId).not.toBe(firstReset.snapshot.conversationId)
    for (const stale of [
      oldLocale, firstBody,
      actionInput(session.snapshot, {kind: 'set_locale', locale: 'en'}),
      {...actionInput(secondReset.snapshot, {kind: 'set_locale', locale: 'en'}), resetEpoch: secondReset.snapshot.resetEpoch + 1},
    ]) {
      const {response, result} = await action(session.cookie, stale)
      expect(response.status).toBe(409)
      expect(result).toMatchObject({status: 'conflict', errorCode: 'STALE_EPOCH'})
    }
    expect(await state(session.cookie)).toEqual(secondReset.snapshot)
  })

  it('rejects an altered replay of the current reset instead of accepting its reused ID', async () => {
    const session = await start()
    const body = actionInput(session.snapshot, {kind: 'reset_demo', scenario: 'low_recovery'})
    const reset = await success(session.cookie, body)
    const {response, result} = await action(session.cookie, {...body, scenario: 'normal'})
    expect(response.status).toBe(409)
    expect(result).toMatchObject({status: 'conflict', errorCode: 'IDEMPOTENCY_CONFLICT'})
    expect(await state(session.cookie)).toEqual(reset.snapshot)
  })

  it('commits a concurrently retried reset exactly once', async () => {
    const session = await start()
    const body = actionInput(session.snapshot, {kind: 'reset_demo', scenario: 'low_recovery'})
    const results = await Promise.all(Array.from({length: 12}, () => success(session.cookie, body)))
    for (const result of results) expect(result).toEqual(results[0])
    expect(results[0].snapshot.resetEpoch).toBe(session.snapshot.resetEpoch + 1)
    expect(await state(session.cookie)).toEqual(results[0].snapshot)
  })

  it('allows only one of two competing resets from the same epoch', async () => {
    const session = await start()
    const results = await Promise.all([
      action(session.cookie, actionInput(session.snapshot, {kind: 'reset_demo', scenario: 'normal'})),
      action(session.cookie, actionInput(session.snapshot, {kind: 'reset_demo', scenario: 'low_recovery'})),
    ])
    expect(results.map(item => item.response.status).sort()).toEqual([200, 409])
    expect(results.find(item => item.response.status === 409)?.result).toMatchObject({status: 'conflict', errorCode: 'STALE_EPOCH'})
    const winner = results.find(item => item.response.status === 200)!.result.snapshot!
    expect(winner.resetEpoch).toBe(session.snapshot.resetEpoch + 1)
    expect(await state(session.cookie)).toEqual(winner)
  })

  it('requires the session cookie for writes and rejects invalid cookies for reads and writes', async () => {
    const session = await start()
    const body = actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    const missing = await request('/api/actions', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
    expect(missing.status).toBe(401)
    expect(await missing.json()).toMatchObject({errorCode: 'SESSION_REQUIRED'})

    const [name, value] = session.cookie.split('=')
    const tampered = `${name}=${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`
    for (const cookie of [tampered, `${name}=invalid`, `${name}=%ZZ`, `${name}=`]) {
      const read = await request('/api/state', {headers: {cookie}})
      expect(read.status).toBe(401)
      expectClearedSessionCookie(read)
      expect(await read.json()).toMatchObject({errorCode: 'INVALID_SESSION'})
      const write = await action(cookie, body)
      expect(write.response.status).toBe(401)
      expect(write.response.headers.get('set-cookie')).toBeNull()
      expect(write.result).toMatchObject({errorCode: 'INVALID_SESSION'})
    }
    expect(await state(session.cookie)).toEqual(session.snapshot)
  })

  it.each(['bad signature', 'expired cookie', 'expired database session', 'deleted database session'] as const)('clears a %s on GET and creates a replacement only after the browser removes the cookie', async failure => {
    const session = await start()
    let invalidCookie = session.cookie
    if (failure === 'bad signature') {
      invalidCookie = `${session.cookie.slice(0, -1)}${session.cookie.endsWith('A') ? 'B' : 'A'}`
    } else if (failure === 'expired cookie') {
      const key = inspect(connection => connection.prepare('SELECT value FROM server_metadata WHERE key = ?').get('session_signing_key_v1')?.value)
      invalidCookie = new SessionCookies(Buffer.from(String(key), 'hex')).issue(session.snapshot.sessionId, Date.now() - 60_000, false).split(';')[0]
    } else if (failure === 'expired database session') {
      inspect(connection => connection.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 60_000, session.snapshot.sessionId))
    } else {
      inspect(connection => connection.prepare('DELETE FROM sessions WHERE id = ?').run(session.snapshot.sessionId))
    }

    const storedRows = () => inspect(connection => ({
      sessions: connection.prepare('SELECT * FROM sessions ORDER BY id').all(),
      requests: connection.prepare('SELECT * FROM action_requests ORDER BY session_id, request_id').all(),
    }))
    const before = storedRows()
    const body = actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    const rejectedWrite = await action(invalidCookie, body)
    expect(rejectedWrite.response.status).toBe(401)
    expect(rejectedWrite.response.headers.get('set-cookie')).toBeNull()
    expect(rejectedWrite.result).toMatchObject({status: 'failed', errorCode: 'INVALID_SESSION'})
    expect(storedRows()).toEqual(before)

    const rejectedRead = await request('/api/state', {headers: {cookie: invalidCookie}})
    expect(rejectedRead.status).toBe(401)
    expectClearedSessionCookie(rejectedRead)
    const error = await rejectedRead.json()
    expect(error).toMatchObject({status: 'failed', errorCode: 'INVALID_SESSION'})
    expect(error).not.toHaveProperty('snapshot')
    expect(error).not.toHaveProperty('sessionId')
    expect(storedRows()).toEqual(before)

    // Applying Max-Age=0 removes the cookie; the next browser request has no Cookie header.
    const replacement = await start()
    expect(replacement.snapshot.sessionId).not.toBe(session.snapshot.sessionId)
    expect(replacement.snapshot.conversationId).not.toBe(session.snapshot.conversationId)
    expect(replacement.snapshot.locale).toBe('en')
    expect(await state(replacement.cookie)).toEqual(replacement.snapshot)
    const afterRecovery = storedRows()
    expect(afterRecovery.sessions).toHaveLength(before.sessions.length + 1)
    expect(afterRecovery.requests).toEqual(before.requests)

    const oldWrite = await action(invalidCookie, body)
    expect(oldWrite.response.status).toBe(401)
    expect(oldWrite.response.headers.get('set-cookie')).toBeNull()
    expect(oldWrite.result).toMatchObject({errorCode: 'INVALID_SESSION'})
    expect(storedRows()).toEqual(afterRecovery)
  })

  it('rejects malformed JSON and invalid action values without altering stored state', async () => {
    const session = await start()
    const malformed = await request('/api/actions', {method: 'POST', headers: {cookie: session.cookie, 'content-type': 'application/json'}, body: '{"kind":'})
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({errorCode: 'INVALID_INPUT'})
    const body = actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    const invalid: unknown[] = [
      null, [], 'set_locale', {},
      {...body, requestId: ''}, {...body, requestId: 123},
      {...body, resetEpoch: -1}, {...body, resetEpoch: 1.5}, {...body, resetEpoch: '1'},
      {...body, source: 'admin'}, {...body, locale: 'fr'}, {...body, locale: null},
      {...body, kind: 'unknown_action'},
      {...actionInput(session.snapshot, {kind: 'reset_demo', scenario: 'normal'}), scenario: 'high_recovery'},
    ]
    for (const candidate of invalid) {
      const {response, result} = await action(session.cookie, candidate)
      expect(response.status).toBe(400)
      expect(result).toMatchObject({errorCode: 'INVALID_INPUT'})
    }
    expect(await state(session.cookie)).toEqual(session.snapshot)
    // Rejected input must not reserve the otherwise valid request ID.
    const recovered = await success(session.cookie, body)
    expect(recovered.snapshot.locale).toBe('zh-CN')
    expect(recovered.snapshot.revision).toBe(session.snapshot.revision + 1)
  })

  it('rejects client supplied session or server state fields instead of trusting them', async () => {
    const attacker = await start()
    const victim = await start()
    const body = actionInput(attacker.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    for (const extra of [
      {sessionId: victim.snapshot.sessionId},
      {conversationId: victim.snapshot.conversationId},
      {snapshot: {...victim.snapshot, locale: 'zh-CN'}},
      {profile: {name: 'Injected', targets: {kcal: 1}}},
      {revision: 500},
    ]) {
      const {response, result} = await action(attacker.cookie, {...body, ...extra})
      expect(response.status).toBe(400)
      expect(result).toMatchObject({errorCode: 'INVALID_INPUT'})
    }
    expect(await state(attacker.cookie)).toEqual(attacker.snapshot)
    expect(await state(victim.cookie)).toEqual(victim.snapshot)
  })

  it('reports missing providers without creating fake persisted successes', async () => {
    const session = await start()
    for (const input of [{kind: 'check_readiness', retry: true}, {kind: 'request_proposal', gymId: 'gym-a'}] as const) {
      const {response, result} = await action(session.cookie, actionInput(session.snapshot, input))
      expect(response.status).toBe(503)
      expect(result).toMatchObject({status: 'failed', errorCode: 'PROVIDER_NOT_CONFIGURED'})
    }
    expect(await state(session.cookie)).toEqual(session.snapshot)
  })

  it('enforces HTTP methods and rejects cross-origin requests before writing or issuing sessions', async () => {
    const session = await start()
    for (const [path, method, allow] of [
      ['/api/state', 'POST', 'GET'], ['/api/actions', 'GET', 'POST'], ['/api/actions', 'DELETE', 'POST'],
    ]) {
      const response = await request(path, {method, headers: {cookie: session.cookie}})
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe(allow)
      expect(await response.json()).toMatchObject({errorCode: 'METHOD_NOT_ALLOWED'})
    }
    const body = actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    const invalidOrigins: Record<string, string>[] = [
      {origin: 'https://outside.example'}, {origin: 'http://localhost.outside.example'}, {origin: 'null'},
      {referer: 'https://outside.example/page'}, {referer: 'invalid-referrer'}, {'sec-fetch-site': 'cross-site'},
    ]
    for (const headers of invalidOrigins) {
      const response = await request('/api/actions', {method: 'POST', headers: {...headers, cookie: session.cookie, 'content-type': 'application/json'}, body: JSON.stringify(body)})
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({errorCode: 'ORIGIN_NOT_ALLOWED'})
      const fresh = await request('/api/state', {headers})
      expect(fresh.status).toBe(403)
      expect(fresh.headers.get('set-cookie')).toBeNull()
    }
    expect(await state(session.cookie)).toEqual(session.snapshot)
    const sameOrigin = await request('/api/actions', {
      method: 'POST', headers: {cookie: session.cookie, 'content-type': 'application/json', origin: 'http://localhost', referer: 'http://localhost/profile', 'sec-fetch-site': 'same-origin'},
      body: JSON.stringify(body),
    })
    expect(sameOrigin.status).toBe(200)
    expect((await state(session.cookie)).locale).toBe('zh-CN')
  })

  it('enforces JSON media type and the 16 KiB byte limit even without a Content-Length header', async () => {
    const session = await start()
    const body = actionInput(session.snapshot, {kind: 'set_locale', locale: 'zh-CN'})
    const serialized = JSON.stringify(body)
    const plain = await request('/api/actions', {method: 'POST', headers: {cookie: session.cookie, 'content-type': 'text/plain'}, body: serialized})
    expect(plain.status).toBe(415)
    expect(await plain.json()).toMatchObject({errorCode: 'UNSUPPORTED_MEDIA_TYPE'})

    const overLimit = serialized.padEnd(16 * 1024 + 1, ' ')
    const oversized = await request('/api/actions', {method: 'POST', headers: {cookie: session.cookie, 'content-type': 'application/json'}, body: overLimit})
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({errorCode: 'PAYLOAD_TOO_LARGE'})
    for (const contentLength of ['16385', '-1', 'unknown']) {
      const response = await request('/api/actions', {method: 'POST', headers: {cookie: session.cookie, 'content-type': 'application/json', 'content-length': contentLength}, body: serialized})
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({errorCode: 'PAYLOAD_TOO_LARGE'})
    }
    expect(await state(session.cookie)).toEqual(session.snapshot)
    const exactLimit = await request('/api/actions', {method: 'POST', headers: {cookie: session.cookie, 'content-type': 'application/json; charset=utf-8'}, body: serialized.padEnd(16 * 1024, ' ')})
    expect(exactLimit.status).toBe(200)
    expect((await state(session.cookie)).locale).toBe('zh-CN')
  })

  it('rejects duplicate session cookies and uses Secure when configured', async () => {
    const session = await start()
    const duplicate = await request('/api/state', {headers: {cookie: `${session.cookie}; ${session.cookie}`}})
    expect(duplicate.status).toBe(401)
    expectClearedSessionCookie(duplicate)
    expect(await duplicate.json()).toMatchObject({errorCode: 'INVALID_SESSION'})
    close(backend)
    backend = createBackend({databasePath, cookieSecure: true})
    opened.add(backend)
    const fresh = await request('/api/state')
    expect(fresh.status).toBe(200)
    expect(fresh.headers.get('set-cookie')).toMatch(/;\s*Secure(?:;|$)/i)
    const invalidSecure = await request('/api/state', {headers: {cookie: 'wellio_session=invalid'}})
    expect(invalidSecure.status).toBe(401)
    expectClearedSessionCookie(invalidSecure, true)
    expect(await state(session.cookie)).toEqual(session.snapshot)
  })

  it.each(['missing', 'stale', 'failed'] as const)('preserves %s readiness without converting its null score into zero', async quality => {
    const session = await start()
    const persisted = structuredClone(session.snapshot)
    persisted.readiness.quality = quality
    persisted.readiness.score = null
    persisted.readiness.guidanceHint = null
    const connection = new DatabaseSync(databasePath)
    try {
      connection.prepare('UPDATE sessions SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(persisted), persisted.sessionId)
    } finally { connection.close() }
    const received = await state(session.cookie)
    expect(received).toEqual(persisted)
    expect(received.readiness.score).toBeNull()
    expect(received.readiness.quality).toBe(quality)
  })
})
