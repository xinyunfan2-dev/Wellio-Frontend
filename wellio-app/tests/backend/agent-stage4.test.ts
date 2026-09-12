import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import type {LanguageModel} from 'ai'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {ChatEvent, ChatRequest, Snapshot} from '../../src/lib/contracts'
import {createBackend} from '../../src/server/app'
import {contextThenAnswer, finalOutput, gatedStep, latestToolResult, normalAnswer, readEvents, scriptedModel, textOutput, toolCall, type ModelStep} from './sdk-fixtures'

const reportedMeal = {
  period: 'dinner', time: '18:30', items: [
    {name: {en: 'Burger', 'zh-CN': '汉堡'}, portion: {en: 'One burger', 'zh-CN': '一个汉堡'}, originalPortion: {quantity: 1, unit: 'piece'}, base: {kcal: 500, protein: 25, carbs: 45, fat: 24}, nutrientUnits: {energy: 'kcal', mass: 'g'}, consumedFraction: 1, estimated: true},
    {name: {en: 'Fries', 'zh-CN': '薯条'}, portion: {en: '100 g', 'zh-CN': '100 g'}, originalPortion: {quantity: 100, unit: 'g'}, base: {kcal: 300, protein: 4, carbs: 40, fat: 14}, nutrientUnits: {energy: 'kcal', mass: 'g'}, consumedFraction: 1, estimated: true},
    {name: {en: 'Drink', 'zh-CN': '饮料'}, portion: {en: '330 ml', 'zh-CN': '330 ml'}, originalPortion: {quantity: 330, unit: 'ml'}, base: {kcal: 140, protein: 0, carbs: 35, fat: 0}, nutrientUnits: {energy: 'kcal', mass: 'g'}, consumedFraction: 1, estimated: true},
  ],
}

describe('Stage 4 real AI SDK agent transport and persistence', () => {
  let directory: string
  let databasePath: string
  let backend: ReturnType<typeof createBackend> | undefined
  let cookie: string
  let initial: Snapshot
  let sequence = 0

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-agent-sdk-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    sequence = 0
    cookie = ''
    for (const name of ['WELLIO_AI_MODEL', 'LOVABLE_API_KEY', 'WELLIO_AI_PROTOCOL', 'WELLIO_AI_BASE_URL', 'WELLIO_LOVABLE_FIRECRAWL_ENDPOINT', 'WELLIO_LOVABLE_FIRECRAWL_TOKEN']) vi.stubEnv(name, '')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Network is forbidden in offline SDK tests'))))
  })

  afterEach(() => {
    backend?.close()
    backend = undefined
    rmSync(directory, {recursive: true, force: true})
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function open(model?: LanguageModel, settings: {maxSteps?: number; timeoutMs?: number; maxOutputTokens?: number} = {}) {
    backend?.close()
    backend = createBackend({databasePath, cookieSecure: false, ...(model ? {agent: {model, ...settings}} : {})})
    const response = await backend.handleRequest(new Request('http://wellio.test/api/state', {headers: cookie ? {cookie} : {}}))
    expect(response.status).toBe(200)
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
    initial = await response.json() as Snapshot
    return initial
  }

  async function current() {
    const response = await backend!.handleRequest(new Request('http://wellio.test/api/state', {headers: {cookie}}))
    expect(response.status).toBe(200)
    return response.json() as Promise<Snapshot>
  }

  function chatInput(patch: Partial<ChatRequest> = {}): ChatRequest {
    return {requestId: `sdk-chat-${++sequence}`, resetEpoch: initial.resetEpoch, conversationId: initial.conversationId, message: 'Please review my recovery and meals today.', locale: 'en', attachmentIds: [], source: 'user', ...patch}
  }

  function chat(input: unknown, signal?: AbortSignal, headers: Record<string, string> = {}) {
    return backend!.handleRequest(new Request('http://wellio.test/api/chat', {method: 'POST', headers: {cookie, 'content-type': 'application/json', ...headers}, body: JSON.stringify(input), signal}))
  }

  function finalSnapshot(events: ChatEvent[]): Snapshot {
    const event = events.filter(item => item.type === 'snapshot').at(-1)
    expect(event?.type).toBe('snapshot')
    return (event as Extract<ChatEvent, {type: 'snapshot'}>).snapshot
  }

  function changeSnapshot(change: (snapshot: Snapshot) => void) {
    const connection = new DatabaseSync(databasePath)
    try {
      const row = connection.prepare('SELECT snapshot_json FROM sessions WHERE id = ?').get(initial.sessionId) as {snapshot_json: string}
      const snapshot = JSON.parse(row.snapshot_json) as Snapshot
      change(snapshot)
      snapshot.revision++
      connection.prepare('UPDATE sessions SET snapshot_json = ?, revision = ? WHERE id = ?').run(JSON.stringify(snapshot), snapshot.revision, snapshot.sessionId)
    } finally { connection.close() }
  }

  it('executes the forced context tool through SDK and supplies authoritative source data to the next model prompt', async () => {
    const model = contextThenAnswer()
    await open(model, {maxOutputTokens: 512})
    const request = chatInput()
    const response = await chat(request)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const events = await readEvents(response)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(model.doStreamCalls[0].toolChoice).toEqual({type: 'tool', toolName: 'get_day_context'})
    expect(model.doStreamCalls[0].tools?.map(tool => tool.name)).toEqual(['get_day_context'])
    expect(model.doStreamCalls[0].maxOutputTokens).toBe(512)
    const secondPrompt = JSON.stringify(model.doStreamCalls[1].prompt)
    expect(secondPrompt).toContain(initial.readiness.id)
    expect(secondPrompt).toContain('mock_watch')
    expect(secondPrompt).toContain(initial.sleep!.id)
    expect(secondPrompt).toContain(initial.workout!.id)
    expect(secondPrompt).toContain(initial.plan.id)
    expect(secondPrompt).toContain(String(initial.readiness.score))
    expect(secondPrompt).toContain('get_day_context')
    const steps = events.filter(event => event.type === 'tool').map(event => event.step)
    expect(steps).toEqual([
      expect.objectContaining({toolCallId: 'get_day_context-call', operation: 'context', status: 'started'}),
      expect.objectContaining({toolCallId: 'get_day_context-call', operation: 'context', status: 'succeeded'}),
    ])
    expect(new Set(steps.map(step => step.id)).size).toBe(1)
    expect(events.every(event => event.requestId === request.requestId && event.resetEpoch === request.resetEpoch)).toBe(true)
    expect(events.slice(-2).map(event => event.type)).toEqual(['snapshot', 'done'])
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('streams only schema-validated Markdown and persists the same final message, summary, and context across reopen', async () => {
    const model = contextThenAnswer()
    await open(model)
    const request = chatInput()
    const events = await readEvents(await chat(request))
    const rendered = events.filter(event => event.type === 'text').map(event => event.delta).join('')
    expect(rendered).toBe(normalAnswer.markdown)
    expect(rendered).not.toContain('trainingSummary')
    expect(rendered).not.toContain('"markdown"')
    const saved = finalSnapshot(events)
    const done = events.at(-1) as Extract<ChatEvent, {type: 'done'}>
    const assistant = saved.messages.find(message => message.id === done.messageId)
    expect(assistant).toMatchObject({role: 'assistant', status: 'complete', content: normalAnswer.markdown})
    expect(assistant?.steps).toEqual([expect.objectContaining({operation: 'context', status: 'succeeded'})])
    expect(saved.advice).toMatchObject({status: 'valid', messageId: done.messageId, training: {en: normalAnswer.trainingSummary}, nutrition: {en: normalAnswer.nutritionSummary}})
    expect(saved.advice.contextReadId).toBeTruthy()
    expect(saved.advice.versions).toMatchObject({meal: initial.mealRevision, readiness: initial.readiness.version, plan: initial.plan.version})
    const reopened = await open(model)
    expect(reopened.messages).toEqual(saved.messages)
    expect(reopened.advice).toEqual(saved.advice)
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('replays the same chat UUID without another model run or duplicate messages and rejects a changed payload', async () => {
    const model = contextThenAnswer()
    await open(model)
    const request = chatInput()
    const first = finalSnapshot(await readEvents(await chat(request)))
    await open(model)
    const replay = await chat(request)
    expect(replay.status).toBe(200)
    await readEvents(replay)
    expect((await current()).messages).toEqual(first.messages)
    expect(model.doStreamCalls).toHaveLength(2)
    const conflict = await chat({...request, message: 'A different question with the same UUID.'})
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({errorCode: 'IDEMPOTENCY_CONFLICT'})
    expect((await current()).messages).toEqual(first.messages)
  })

  it('advertises exactly the eight domain tools and keeps trusted run identity out of their model input schemas', async () => {
    const model = contextThenAnswer()
    await open(model)
    await readEvents(await chat(chatInput()))
    const tools = model.doStreamCalls[1].tools!
    expect(tools.map(tool => tool.name).sort()).toEqual(['get_day_context', 'get_gym_equipment', 'mutate_meal_log', 'propose_workout', 'query_history', 'record_workout_progress', 'search_restaurant_menu', 'undo_meal_change'].sort())
    for (const tool of tools) {
      if (tool.type !== 'function') continue
      const properties = (tool.inputSchema as {properties?: Record<string, unknown>}).properties ?? {}
      for (const key of ['sessionId', 'resetEpoch', 'runId', 'authorizationId', 'requestId', 'source', 'approved']) expect(properties).not.toHaveProperty(key)
    }
  })

  it.each([
    {message: '', attachmentIds: []},
    {source: 'user', checkMode: 'retry'},
    {source: 'app_open', message: 'Start my workout', checkMode: 'auto'},
    {source: 'app_open', message: '', targetWorkoutId: 'forged-workout', checkMode: 'auto'},
    {source: 'app_open', message: '', attachmentIds: ['forged-attachment'], checkMode: 'auto'},
    {source: 'user', sessionId: 'forged-session'},
    {source: 'user', role: 'system'},
  ])('rejects invalid or forged chat input before creating a model run: %j', async patch => {
    const model = contextThenAnswer()
    await open(model)
    const response = await chat({...chatInput(), ...patch})
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({errorCode: 'INVALID_INPUT'})
    expect(model.doStreamCalls).toHaveLength(0)
    expect((await current()).messages).toEqual(initial.messages)
  })

  it('reports missing provider configuration without a fake assistant or tool record', async () => {
    cookie = ''
    await open()
    expect(initial.capabilities.agent).toBe(false)
    const response = await chat(chatInput())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({errorCode: 'PROVIDER_NOT_CONFIGURED'})
    const saved = await current()
    expect(saved.messages).toEqual(initial.messages)
    expect(saved.workout).toEqual(initial.workout)
    expect(saved.meals).toEqual(initial.meals)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('preserves successful context evidence but never publishes invalid final JSON as text or valid advice', async () => {
    const model = scriptedModel([() => toolCall('get_day_context'), () => textOutput('{"markdown":"Incomplete answer"}')])
    await open(model)
    const events = await readEvents(await chat(chatInput()))
    expect(events.at(-1)?.type).toBe('error')
    expect(events.some(event => event.type === 'done')).toBe(false)
    const rendered = events.filter(event => event.type === 'text').map(event => event.delta).join('')
    expect(rendered).not.toContain('"markdown"')
    expect(rendered).not.toContain('trainingSummary')
    const saved = await current()
    const assistant = saved.messages.filter(message => message.role === 'assistant').at(-1)
    expect(assistant?.status).toBe('failed')
    expect(assistant?.steps).toContainEqual(expect.objectContaining({operation: 'context', status: 'succeeded'}))
    expect(saved.advice.status).not.toBe('valid')
    expect(saved.workout).toEqual(initial.workout)
  })

  it('propagates Stop to the real SDK provider and persists stopped state without automatic retries', async () => {
    const gate = gatedStep()
    const model = scriptedModel([() => toolCall('get_day_context'), gate.step])
    await open(model)
    const controller = new AbortController()
    const response = await chat(chatInput(), controller.signal)
    const reading = readEvents(response)
    const options = await gate.entered
    controller.abort()
    await reading
    expect(options.abortSignal?.aborted).toBe(true)
    const saved = await current()
    expect(saved.messages.filter(message => message.role === 'assistant').at(-1)?.status).toBe('stopped')
    expect(saved.workout).toEqual(initial.workout)
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('bounds a hung provider with the configured timeout and saves a failed or stopped message', async () => {
    const gate = gatedStep()
    const model = scriptedModel([() => toolCall('get_day_context'), gate.step])
    await open(model, {timeoutMs: 75})
    const response = await chat(chatInput())
    const events = await readEvents(response)
    expect(events.at(-1)?.type).toBe('error')
    const options = await gate.entered
    expect(options.abortSignal?.aborted).toBe(true)
    const saved = await current()
    expect(['failed', 'stopped']).toContain(saved.messages.filter(message => message.role === 'assistant').at(-1)?.status)
    expect(saved.advice.status).not.toBe('valid')
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('rejects an old epoch before invoking the SDK', async () => {
    const model = contextThenAnswer()
    cookie = ''
    await open(model)
    const response = await chat(chatInput({resetEpoch: initial.resetEpoch + 1}))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({errorCode: 'STALE_EPOCH'})
    expect(model.doStreamCalls).toHaveLength(0)
    expect((await current()).messages).toEqual(initial.messages)
  })

  it('does not label an old-context summary valid when another connection changes conditions during generation', async () => {
    const gate = gatedStep()
    const model = scriptedModel([() => toolCall('get_day_context'), gate.step])
    await open(model)
    const reading = readEvents(await chat(chatInput()))
    await gate.entered
    changeSnapshot(snapshot => { snapshot.conditions.version++; snapshot.conditions.availableMinutes = 20 })
    gate.release(finalOutput())
    await reading
    const saved = await current()
    expect(saved.conditions.availableMinutes).toBe(20)
    expect(saved.conditions.version).toBe(initial.conditions.version + 1)
    expect(saved.advice.status).not.toBe('valid')
    expect(saved.workout).toEqual(initial.workout)
  })

  it('rejects late completion and old-run cleanup after Reset without contaminating the new epoch', async () => {
    const gate = gatedStep()
    const model = scriptedModel([() => toolCall('get_day_context'), gate.step])
    await open(model)
    const reading = readEvents(await chat(chatInput()))
    await gate.entered
    const resetResponse = await backend!.handleRequest(new Request('http://wellio.test/api/actions', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify({kind: 'reset_demo', requestId: 'reset-during-sdk', resetEpoch: initial.resetEpoch, scenario: 'low_recovery', source: 'profile'})}))
    expect(resetResponse.status).toBe(200)
    const reset = await current()
    gate.release(finalOutput())
    const events = await reading
    expect(events.some(event => event.type === 'done')).toBe(false)
    const saved = await current()
    expect(saved.resetEpoch).toBe(initial.resetEpoch + 1)
    expect(saved.messages).toEqual(reset.messages)
    expect(saved.proposals).toEqual(reset.proposals)
    expect(saved.workout).toEqual(reset.workout)
    expect(saved.readiness).toEqual(reset.readiness)
    expect(saved.advice).toEqual(reset.advice)
  })

  it('does not accept a structured answer from a provider that ignores the mandatory context call', async () => {
    const model = scriptedModel([() => finalOutput()])
    await open(model)
    const events = await readEvents(await chat(chatInput()))
    expect(events.at(-1)).toMatchObject({type: 'error', errorCode: 'PROVIDER_ERROR'})
    expect(events.some(event => event.type === 'done' || event.type === 'tool')).toBe(false)
    const saved = await current()
    expect(saved.advice.status).not.toBe('valid')
    expect(saved.messages.at(-1)).toMatchObject({status: 'failed', steps: []})
  })

  it('enforces the configured step budget without pretending that a tools-only result is a final answer', async () => {
    const model = scriptedModel([() => toolCall('get_day_context')])
    await open(model, {maxSteps: 1})
    const events = await readEvents(await chat(chatInput()))
    expect(model.doStreamCalls).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('error')
    expect(events.some(event => event.type === 'done' || event.type === 'text')).toBe(false)
    const saved = await current()
    expect(saved.messages.at(-1)).toMatchObject({status: 'failed', steps: [expect.objectContaining({operation: 'context', status: 'succeeded'})]})
    expect(saved.advice.status).not.toBe('valid')
  })

  it('does not execute a model-supplied identity override in strict tool arguments', async () => {
    const model = scriptedModel([
      () => toolCall('get_day_context', {}, 'legitimate-context'),
      () => toolCall('get_day_context', {sessionId: 'other-session', resetEpoch: 100, runId: 'forged-run'}, 'forged-context'),
      () => finalOutput(),
    ])
    await open(model)
    const events = await readEvents(await chat(chatInput()))
    const saved = await current()
    expect(saved.messages.flatMap(message => message.steps)).not.toContainEqual(expect.objectContaining({toolCallId: 'forged-context', status: 'succeeded'}))
    expect(events.filter(event => event.type === 'tool').map(event => event.step)).not.toContainEqual(expect.objectContaining({toolCallId: 'forged-context', status: 'succeeded'}))
    expect(saved.meals).toEqual(initial.meals)
    expect(saved.workout).toEqual(initial.workout)
    expect(saved.proposals).toEqual(initial.proposals)
    const connection = new DatabaseSync(databasePath)
    try {
      expect(connection.prepare('SELECT COUNT(*) AS count FROM context_reads WHERE session_id = ?').get(initial.sessionId)).toMatchObject({count: 1})
    } finally { connection.close() }
  })

  it('keeps messages and model context scoped to the cookie session and rejects another conversation ID', async () => {
    const model = contextThenAnswer()
    await open(model)
    const otherResponse = await backend!.handleRequest(new Request('http://wellio.test/api/state'))
    const otherCookie = otherResponse.headers.get('set-cookie')!.split(';')[0]
    const other = await otherResponse.json() as Snapshot
    expect(other.sessionId).not.toBe(initial.sessionId)
    const denied = await chat(chatInput({conversationId: other.conversationId}))
    expect(denied.status).toBe(409)
    expect(await denied.json()).toMatchObject({errorCode: 'CONVERSATION_MISMATCH'})
    expect(model.doStreamCalls).toHaveLength(0)
    await readEvents(await chat(chatInput()))
    const otherSaved = await (await backend!.handleRequest(new Request('http://wellio.test/api/state', {headers: {cookie: otherCookie}}))).json() as Snapshot
    expect(otherSaved.messages).toEqual(other.messages)
    expect(otherSaved.advice).toEqual(other.advice)
    const prompt = JSON.stringify(model.doStreamCalls[1].prompt)
    expect(prompt).toContain(initial.sessionId)
    expect(prompt).not.toContain(other.sessionId)
  })

  it('records explicitly reported food through the tool, rereads fresh context, and supplies server nutrition to the final prompt', async () => {
    const model = scriptedModel([
      () => toolCall('get_day_context', {}, 'before-meal'),
      () => toolCall('mutate_meal_log', {action: 'add', meal: reportedMeal}, 'save-reported-meal'),
      options => {
        expect(options.toolChoice).toEqual({type: 'tool', toolName: 'get_day_context'})
        return toolCall('get_day_context', {}, 'after-meal')
      },
      options => {
        const context = latestToolResult<{snapshot: Snapshot; totals: {consumed: {kcal: number}}}>(options, 'get_day_context')
        expect(context.snapshot.mealRevision).toBe(initial.mealRevision + 1)
        expect(context.snapshot.meals).toHaveLength(initial.meals.length + 1)
        expect(context.totals.consumed.kcal).toBeGreaterThan(940)
        const written = latestToolResult<{result: {status: string; operationId: string; nutrition: {meal: {total: unknown}}}}>(options, 'mutate_meal_log')
        expect(written.result).toMatchObject({status: 'succeeded', operationId: expect.any(String), nutrition: {meal: {total: {kcal: 940, protein: 29, carbs: 120, fat: 38}}}})
        return finalOutput({...normalAnswer, markdown: 'Recorded the reported meal; estimated nutrition totals 940 kcal.'})
      },
    ])
    await open(model)
    const input = chatInput({message: 'I ate a burger, fries, and a drink.'})
    const events = await readEvents(await chat(input))
    expect(events.at(-1)?.type).toBe('done')
    const saved = await current()
    const meal = saved.meals.at(-1)!
    expect(meal.items.map(item => item.name.en)).toEqual(['Burger', 'Fries', 'Drink'])
    expect(meal.id).toBeTruthy()
    expect(new Set(meal.items.map(item => item.id)).size).toBe(3)
    expect(saved.mealRevision).toBe(initial.mealRevision + 1)
    expect(saved.advice).toMatchObject({status: 'valid', versions: {meal: saved.mealRevision}})
    expect(saved.messages.at(-1)).toMatchObject({operationId: meal.operationId, mealId: meal.id})
    const connection = new DatabaseSync(databasePath)
    try {
      const contexts = connection.prepare('SELECT record_json FROM context_reads WHERE session_id = ?').all(initial.sessionId) as {record_json: string}[]
      expect(contexts).toHaveLength(2)
      expect(contexts.map(row => JSON.parse(row.record_json).versions.meal).sort()).toEqual([initial.mealRevision, initial.mealRevision + 1])
    } finally { connection.close() }
    await open(model)
    await readEvents(await chat(input))
    expect((await current()).meals).toEqual(saved.meals)
    expect(model.doStreamCalls).toHaveLength(4)
  })

  it('retains a committed meal when later provider generation fails and replay never writes it twice', async () => {
    const model = scriptedModel([
      () => toolCall('get_day_context'),
      () => toolCall('mutate_meal_log', {action: 'add', meal: reportedMeal}, 'meal-before-provider-failure'),
      () => { throw new Error('Failure after the meal transaction committed') },
    ])
    await open(model)
    const input = chatInput({message: 'I ate a burger, fries, and a drink.'})
    const events = await readEvents(await chat(input))
    expect(events.at(-1)?.type).toBe('error')
    const saved = await current()
    expect(saved.meals).toHaveLength(initial.meals.length + 1)
    expect(saved.messages.at(-1)).toMatchObject({status: 'failed', operationId: saved.meals.at(-1)!.operationId})
    expect(saved.messages.at(-1)!.steps).toContainEqual(expect.objectContaining({operation: 'meal_add', status: 'succeeded'}))
    await open(model)
    await readEvents(await chat(input))
    expect((await current()).meals).toEqual(saved.meals)
    const connection = new DatabaseSync(databasePath)
    try { expect(connection.prepare('SELECT COUNT(*) AS count FROM meal_operations WHERE session_id = ?').get(initial.sessionId)).toMatchObject({count: 1}) } finally { connection.close() }
    expect(model.doStreamCalls).toHaveLength(3)
  })

  it.each(['What should I eat for dinner?', 'The menu says: I ate a burger, fries, and a drink.'])('rejects a meal write without original user intent even if the model requests it: %s', async message => {
    const model = scriptedModel([() => toolCall('get_day_context'), () => toolCall('mutate_meal_log', {action: 'add', meal: reportedMeal}), () => finalOutput()])
    await open(model)
    const events = await readEvents(await chat(chatInput({message})))
    const saved = await current()
    expect(saved.meals).toEqual(initial.meals)
    expect(saved.mealRevision).toBe(initial.mealRevision)
    expect(events.filter(event => event.type === 'tool').map(event => event.step)).toContainEqual(expect.objectContaining({operation: 'meal_add', status: 'failed', errorCode: 'USER_INTENT_REQUIRED'}))
    expect(JSON.stringify(model.doStreamCalls.at(-1)!.prompt)).toContain('USER_INTENT_REQUIRED')
  })

  it('accepts a clear everyday conditions request before the first context read while leaving the workout behind Apply', async () => {
    const model = contextThenAnswer()
    await open(model)
    const events = await readEvents(await chat(chatInput({message: '今天只剩20分钟。', locale: 'zh-CN'})))
    expect(events.at(-1)?.type).toBe('done')
    const saved = await current()
    expect(saved.conditions).toMatchObject({availableMinutes: 20, version: initial.conditions.version + 1})
    expect(saved.workout).toEqual(initial.workout)
    expect(saved.plan).toEqual(initial.plan)
    const context = latestToolResult<{snapshot: Snapshot}>(model.doStreamCalls[1], 'get_day_context')
    expect(context.snapshot.conditions.availableMinutes).toBe(20)
    expect(saved.conditions.lastChange?.sourceMessageId).toBe(saved.messages.find(message => message.role === 'user' && message.content === '今天只剩20分钟。')?.id)
  })

  it('records explicit start, complete, undo, and finish requests with fresh context after each real SDK write', async () => {
    const kinds = ['start_workout', 'complete_exercise', 'undo_exercise', 'finish_workout'] as const
    const model = scriptedModel(kinds.flatMap(kind => [
      () => toolCall('get_day_context', {}, `before-${kind}`),
      (options: Parameters<typeof latestToolResult>[0]) => {
        const workout = latestToolResult<{snapshot: Snapshot}>(options, 'get_day_context').snapshot.workout!
        return toolCall('record_workout_progress', {kind, workoutId: workout.id, ...(kind === 'complete_exercise' || kind === 'undo_exercise' ? {exerciseId: workout.exercises[0].id} : {}), ...(kind === 'finish_workout' ? {actualMinutes: 25, confirmIncomplete: true} : {})}, `save-${kind}`)
      },
      () => toolCall('get_day_context', {}, `after-${kind}`),
      () => finalOutput({...normalAnswer, markdown: `Saved the explicitly requested ${kind} progress.`}),
    ]))
    await open(model)
    const workout = initial.workout!
    const messages = ['Start my workout.', `I completed ${workout.exercises[0].name.en}.`, `Undo completion of ${workout.exercises[0].name.en}.`, 'Finish my workout with unfinished exercises after 25 minutes.']
    for (const [index, message] of messages.entries()) {
      const events = await readEvents(await chat(chatInput({message, targetWorkoutId: workout.id, ...(index === 1 || index === 2 ? {targetExerciseId: workout.exercises[0].id} : {})})))
      expect(events.at(-1)?.type).toBe('done')
      const saved = await current()
      expect(saved.workout?.version).toBe(workout.version + index + 1)
      expect(saved.messages.at(-1)?.steps).toContainEqual(expect.objectContaining({operation: 'workout_progress', status: 'succeeded'}))
      expect(saved.advice).toMatchObject({status: 'valid', versions: {workout: saved.workout!.version}})
      if (index === 1) expect(saved.workout?.exercises[0].completed).toBe(true)
      if (index === 2) expect(saved.workout?.exercises[0].completed).toBe(false)
    }
    const saved = await current()
    expect(saved.workout).toMatchObject({status: 'completed', actualMinutes: 25})
    expect(saved.workout!.exercises.every(exercise => !exercise.completed)).toBe(true)
    expect(saved.history.training).toHaveLength(initial.history.training.length + 1)
    expect(saved.history.load).toEqual(initial.history.load)
    expect(model.doStreamCalls).toHaveLength(16)
  })

  it('rejects a model-selected workout operation that differs from the original clear user request', async () => {
    const model = scriptedModel([
      () => toolCall('get_day_context'),
      options => {
        const workout = latestToolResult<{snapshot: Snapshot}>(options, 'get_day_context').snapshot.workout!
        return toolCall('record_workout_progress', {kind: 'complete_exercise', workoutId: workout.id, exerciseId: workout.exercises[0].id})
      },
      () => finalOutput(),
    ])
    await open(model)
    const events = await readEvents(await chat(chatInput({message: 'Start my workout.'})))
    expect((await current()).workout).toEqual(initial.workout)
    expect(events.filter(event => event.type === 'tool').map(event => event.step)).toContainEqual(expect.objectContaining({operation: 'workout_progress', status: 'failed', errorCode: 'USER_INTENT_REQUIRED'}))
  })

  it('maps a genuine needs-input workout result to awaiting_user instead of a successful tool or a phantom proposal', async () => {
    const model = scriptedModel([
      () => toolCall('get_day_context'),
      options => {
        const context = latestToolResult<{contextReadId: string; snapshot: Snapshot}>(options, 'get_day_context')
        const workout = structuredClone(context.snapshot.workout!)
        workout.exercises[0].suggestedLoad = {...workout.exercises[0].suggestedLoad, source: 'missing', value: null}
        delete workout.exercises[0].suggestedLoad.sourceHistoryId
        return toolCall('propose_workout', {scope: 'workout', contextReadId: context.contextReadId, reason: {en: 'Confirm the load before changing the plan.', 'zh-CN': '调整前确认负重。'}, workout})
      },
      () => finalOutput({...normalAnswer, markdown: 'Please confirm the missing load before a proposal can be saved.'}),
    ])
    await open(model)
    const events = await readEvents(await chat(chatInput({message: 'Help me adjust my workout.'})))
    expect(events.at(-1)?.type).toBe('done')
    const steps = events.filter(event => event.type === 'tool').map(event => event.step)
    expect(steps).toContainEqual(expect.objectContaining({operation: 'workout_proposal', status: 'awaiting_user', errorCode: 'LOAD_CONFIRMATION_REQUIRED'}))
    expect(steps).not.toContainEqual(expect.objectContaining({operation: 'workout_proposal', status: 'succeeded'}))
    const saved = await current()
    expect(saved.proposals).toEqual(initial.proposals)
    expect(saved.workout).toEqual(initial.workout)
    expect(saved.messages.at(-1)?.proposalId).toBeUndefined()
  })

  it('uses absolute half-portions through SDK updates, makes a repeated half a no-op, and reverses only that item through explicit undo', async () => {
    const afterWrite = () => finalOutput({...normalAnswer, markdown: 'Saved the requested meal change using the recorded portions.'})
    const steps: ModelStep[] = [() => toolCall('get_day_context', {}, 'add-context'), () => toolCall('mutate_meal_log', {action: 'add', meal: reportedMeal}, 'add-meal'), () => toolCall('get_day_context', {}, 'added-context'), afterWrite]
    for (const attempt of [1, 2]) steps.push(
      () => toolCall('get_day_context', {}, `before-half-${attempt}`),
      options => {
        const meal = latestToolResult<{snapshot: Snapshot}>(options, 'get_day_context').snapshot.meals.at(-1)!
        const fries = meal.items.find(item => item.name.en === 'Fries')!
        return toolCall('mutate_meal_log', {action: 'update', mealId: meal.id, mealItemId: fries.id, changes: {consumedFraction: .5}}, `half-${attempt}`)
      },
      () => toolCall('get_day_context', {}, `after-half-${attempt}`), afterWrite,
    )
    steps.push(
      () => toolCall('get_day_context', {}, 'before-undo'),
      options => {
        const meal = latestToolResult<{snapshot: Snapshot}>(options, 'get_day_context').snapshot.meals.at(-1)!
        return toolCall('undo_meal_change', {operationId: meal.operationId}, 'undo-half')
      },
      () => toolCall('get_day_context', {}, 'after-undo'), afterWrite,
    )
    const model = scriptedModel(steps)
    await open(model)
    await readEvents(await chat(chatInput({message: 'I ate a burger, fries, and a drink.'})))
    const added = await current()
    const originalMeal = added.meals.at(-1)!
    const fries = originalMeal.items.find(item => item.name.en === 'Fries')!
    let half: Snapshot | undefined
    for (const attempt of [1, 2]) {
      const events = await readEvents(await chat(chatInput({message: 'I only ate half of the fries.', targetMealId: originalMeal.id, targetMealItemId: fries.id})))
      expect(events.at(-1)?.type).toBe('done')
      const saved = await current()
      const meal = saved.meals.at(-1)!
      expect(meal.items.find(item => item.id === fries.id)).toMatchObject({base: fries.base, consumedFraction: .5})
      expect(meal.items.filter(item => item.id !== fries.id)).toEqual(originalMeal.items.filter(item => item.id !== fries.id))
      expect(saved.mealRevision).toBe(added.mealRevision + 1)
      expect(meal.version).toBe(originalMeal.version + 1)
      if (attempt === 2) expect(meal).toEqual(half!.meals.at(-1))
      half = saved
    }
    const undo = chatInput({message: 'Undo this meal change.', targetMealId: originalMeal.id, targetOperationId: half!.meals.at(-1)!.operationId})
    const undoneEvents = await readEvents(await chat(undo))
    expect(undoneEvents.at(-1)?.type).toBe('done')
    expect(undoneEvents.filter(event => event.type === 'tool').map(event => event.step)).toContainEqual(expect.objectContaining({operation: 'meal_undo', status: 'succeeded'}))
    const saved = await current()
    expect(saved.meals.at(-1)!.items).toEqual(originalMeal.items)
    const connection = new DatabaseSync(databasePath)
    try {
      const operations = connection.prepare('SELECT record_json FROM meal_operations WHERE session_id = ?').all(initial.sessionId) as {record_json: string}[]
      expect(operations).toHaveLength(2)
      expect(operations.map(row => JSON.parse(row.record_json).status).sort()).toEqual(['applied', 'undone'])
    } finally { connection.close() }
    await open(model)
    await readEvents(await chat(undo))
    expect((await current()).meals).toEqual(saved.meals)
    expect(model.doStreamCalls).toHaveLength(16)
  })

  it('reports a SQLite meal-write failure as a failed step with no meal, receipt, or consumed grant left behind', async () => {
    const model = scriptedModel([() => toolCall('get_day_context'), () => toolCall('mutate_meal_log', {action: 'add', meal: reportedMeal}), () => finalOutput({...normalAnswer, markdown: 'The meal could not be saved.'})])
    await open(model)
    const connection = new DatabaseSync(databasePath)
    try {
      connection.exec("CREATE TRIGGER reject_sdk_meal BEFORE INSERT ON meal_operations BEGIN SELECT RAISE(ABORT, 'injected meal failure'); END")
      const events = await readEvents(await chat(chatInput({message: 'I ate a burger, fries, and a drink.'})))
      const saved = await current()
      expect(saved.meals).toEqual(initial.meals)
      expect(saved.mealRevision).toBe(initial.mealRevision)
      expect(saved.messages.at(-1)?.operationId).toBeUndefined()
      const steps = events.filter(event => event.type === 'tool').map(event => event.step)
      expect(steps).toContainEqual(expect.objectContaining({operation: 'meal_add', status: 'failed', errorCode: 'TOOL_FAILED'}))
      expect(steps).not.toContainEqual(expect.objectContaining({operation: 'meal_add', status: 'succeeded'}))
      expect(connection.prepare('SELECT COUNT(*) AS count FROM meal_operations').get()).toMatchObject({count: 0})
      expect(connection.prepare('SELECT COUNT(*) AS count FROM write_authorizations WHERE consumed_by_request_id IS NOT NULL').get()).toMatchObject({count: 0})
      expect(connection.prepare("SELECT COUNT(*) AS count FROM action_requests WHERE kind = 'mutate_meal_log'").get()).toMatchObject({count: 0})
    } finally { connection.close() }
  })
})
