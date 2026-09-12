import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import type {LanguageModel} from 'ai'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {ActionInput, ActionResult, ChatEvent, ChatRequest, Snapshot} from '../../src/lib/contracts'
import {createBackend} from '../../src/server/app'
import {claimRun} from '../../src/server/agent-state'
import {WellioDatabase} from '../../src/server/database'
import {contextThenAnswer, finalOutput, gatedStep, latestToolResult, normalAnswer, readEvents, scriptedModel, toolCall} from './sdk-fixtures'

const lowAnswer = {markdown: 'Recovery is 42/100. Consider resting today and review the proposed schedule before applying it.', trainingSummary: 'Recovery 42/100 suggests reviewing a rest-day proposal.', nutritionSummary: 'Keep the recorded meals and use today’s intake to plan dinner.'}

describe('Stage 4 persistent automatic readiness checks through the real SDK', () => {
  let directory: string
  let databasePath: string
  let backend: ReturnType<typeof createBackend> | undefined
  let cookie: string
  let initial: Snapshot
  let sequence = 0
  let now: number

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-readiness-sdk-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    sequence = 0
    cookie = ''
    now = Date.now()
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

  async function open(model?: LanguageModel, settings: {timeoutMs?: number} = {}) {
    backend?.close()
    backend = createBackend({databasePath, cookieSecure: false, ...{now: () => now}, ...(model ? {agent: {model, ...settings}} : {})})
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

  function request(patch: Partial<ChatRequest> = {}): ChatRequest {
    return {requestId: `readiness-chat-${++sequence}`, resetEpoch: initial.resetEpoch, conversationId: initial.conversationId, message: '', locale: 'en', attachmentIds: [], source: 'app_open', checkMode: 'auto', ...patch}
  }

  function check(input = request(), signal?: AbortSignal) {
    return backend!.handleRequest(new Request('http://wellio.test/api/chat', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(input), signal}))
  }

  function userRequest(patch: Partial<ChatRequest> = {}): ChatRequest {
    return {requestId: `readiness-user-${++sequence}`, resetEpoch: initial.resetEpoch, conversationId: initial.conversationId, message: 'Please review my recovery today.', locale: 'en', attachmentIds: [], source: 'user', ...patch}
  }

  async function action(input: ActionInput) {
    const response = await backend!.handleRequest(new Request('http://wellio.test/api/actions', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify({...input, source: 'today', requestId: `readiness-action-${++sequence}`, resetEpoch: initial.resetEpoch})}))
    expect(response.status).toBe(200)
    const result = await response.json() as ActionResult
    expect(result.status).toBe('succeeded')
    return result.snapshot!
  }

  function control(events: ChatEvent[], outcomes: string[]) {
    expect(events.map(event => event.type)).toEqual(['snapshot', 'check_result'])
    const snapshot = (events[0] as Extract<ChatEvent, {type: 'snapshot'}>).snapshot
    const result = events[1] as Extract<ChatEvent, {type: 'check_result'}>
    expect(outcomes).toContain(result.outcome)
    expect(result.checkKey).toBe(snapshot.readinessCheck?.key)
    return snapshot
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

  function scheduleModel() {
    return scriptedModel([
      () => toolCall('get_day_context'),
      options => {
        const context = latestToolResult<{contextReadId: string; snapshot: Snapshot}>(options, 'get_day_context')
        expect(context.snapshot.readiness.score).toBe(42)
        return toolCall('propose_workout', {scope: 'schedule', contextReadId: context.contextReadId, reason: {en: 'Consider rest after the short sleep and low recovery.', 'zh-CN': '睡眠较短、恢复偏低，建议考虑休息。'}}, 'rest-proposal')
      },
      () => finalOutput(lowAnswer),
    ])
  }

  it('runs a new check once without a fake user message and restores its real steps and advice after reopen', async () => {
    const model = contextThenAnswer()
    await open(model)
    expect(initial.capabilities.agent).toBe(true)
    expect(initial.readinessCheck).toMatchObject({status: 'idle'})
    const oldMessages = initial.messages
    const events = await readEvents(await check())
    expect(events.slice(-2).map(event => event.type)).toEqual(['snapshot', 'done'])
    const saved = await current()
    expect(saved.readinessCheck).toMatchObject({key: initial.readinessCheck!.key, status: 'completed'})
    expect(saved.messages.filter(message => message.role === 'user')).toEqual(oldMessages.filter(message => message.role === 'user'))
    expect(saved.messages.slice(oldMessages.length)).toEqual([expect.objectContaining({role: 'assistant', source: 'app_open', status: 'complete', content: normalAnswer.markdown, steps: [expect.objectContaining({operation: 'context', status: 'succeeded'})]})])
    expect(saved.proposals).toEqual(initial.proposals)
    expect(saved.plan).toEqual(initial.plan)
    const reopened = await open(model)
    expect(reopened.messages).toEqual(saved.messages)
    expect(reopened.advice).toEqual(saved.advice)
    expect(reopened.readinessCheck).toEqual(saved.readinessCheck)
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('returns snapshot/check_result for cached auto and retry requests without new model calls or empty assistant messages', async () => {
    const model = contextThenAnswer()
    await open(model)
    await readEvents(await check())
    const saved = await current()
    for (const mode of ['auto', 'retry'] as const) {
      const response = await check(request({checkMode: mode}))
      expect(response.headers.get('content-type')).toContain('application/x-ndjson')
      const cached = control(await readEvents(response), ['reused', 'not_needed'])
      expect(cached.messages).toEqual(saved.messages)
      expect(cached.readinessCheck).toEqual(saved.readinessCheck)
    }
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('atomically admits one run for two concurrent windows sharing the same session and check key', async () => {
    const gate = gatedStep()
    const model = scriptedModel([() => toolCall('get_day_context'), gate.step])
    await open(model)
    const first = await check()
    const firstEvents = readEvents(first)
    await gate.entered
    const whilePending = await current()
    expect(whilePending.readinessCheck?.status).toBe('pending')
    const other = createBackend({databasePath, cookieSecure: false, agent: {model}})
    try {
      const second = await other.handleRequest(new Request('http://wellio.test/api/chat', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(request())}))
      const reused = control(await readEvents(second), ['in_progress'])
      expect(reused.readinessCheck?.status).toBe('pending')
      expect(reused.messages).toEqual(whilePending.messages)
      expect(model.doStreamCalls).toHaveLength(2)
    } finally {
      gate.release(finalOutput())
      await firstEvents
      other.close()
    }
    expect((await current()).messages.length).toBe(initial.messages.length + 1)
    expect((await current()).readinessCheck?.status).toBe('completed')
  })

  it.each([
    {invalid: 'conversation', errorCode: 'CONVERSATION_MISMATCH'},
    {invalid: 'epoch', errorCode: 'STALE_EPOCH'},
  ] as const)('does not interrupt an active automatic check when a user request has an invalid $invalid', async ({invalid, errorCode}) => {
    const gate = gatedStep()
    const model = scriptedModel([() => toolCall('get_day_context'), gate.step])
    await open(model)
    initial = await action({kind: 'reset_demo', scenario: 'normal'})
    const automaticRequest = request()
    const automaticEvents = readEvents(await check(automaticRequest))
    const providerCall = await gate.entered
    const pending = await current()
    expect(pending.readinessCheck?.status).toBe('pending')
    let events: ChatEvent[]
    try {
      const invalidRequest = userRequest(invalid === 'conversation'
        ? {conversationId: 'another-conversation'}
        : {resetEpoch: initial.resetEpoch - 1})
      const rejected = await check(invalidRequest)
      expect(rejected.status).toBe(409)
      expect(await rejected.json()).toMatchObject({errorCode})
      expect(providerCall.abortSignal?.aborted).toBe(false)
      const unaffected = await current()
      expect(unaffected.readinessCheck).toEqual(pending.readinessCheck)
      expect(unaffected.messages).toEqual(pending.messages)
      expect(unaffected.messages.find(message => message.id === pending.readinessCheck!.messageId)?.status).toBe('streaming')
      expect(model.doStreamCalls).toHaveLength(2)
    } finally {
      gate.release(finalOutput())
      events = await automaticEvents
    }
    expect(events!.at(-1)).toMatchObject({type: 'done', requestId: automaticRequest.requestId, messageId: pending.readinessCheck!.messageId})
    expect(events!.some(event => event.type === 'error')).toBe(false)
    const completed = await current()
    expect(completed.readinessCheck).toMatchObject({key: pending.readinessCheck!.key, status: 'completed', messageId: pending.readinessCheck!.messageId})
    expect(completed.messages.find(message => message.id === pending.readinessCheck!.messageId)).toMatchObject({status: 'complete', content: normalAnswer.markdown})
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('replays a completed user UUID without cancelling the currently active automatic check', async () => {
    const gate = gatedStep()
    const model = scriptedModel([
      () => toolCall('get_day_context', {}, 'completed-user-context'),
      () => finalOutput(),
      () => toolCall('get_day_context', {}, 'active-auto-context'),
      gate.step,
    ])
    await open(model)
    const completedUserRequest = userRequest()
    const userEvents = await readEvents(await check(completedUserRequest))
    const userDone = userEvents.at(-1) as Extract<ChatEvent, {type: 'done'}>
    expect(userDone.type).toBe('done')
    expect((await current()).readinessCheck?.status).toBe('idle')
    const automaticRequest = request()
    const automaticEvents = readEvents(await check(automaticRequest))
    const providerCall = await gate.entered
    const pending = await current()
    expect(pending.readinessCheck?.status).toBe('pending')
    let events: ChatEvent[]
    try {
      const replay = await check(completedUserRequest)
      expect(replay.status).toBe(200)
      const replayEvents = await readEvents(replay)
      expect(replayEvents.map(event => event.type)).toEqual(['snapshot', 'done'])
      expect(replayEvents.at(-1)).toMatchObject({type: 'done', requestId: completedUserRequest.requestId, messageId: userDone.messageId})
      expect(providerCall.abortSignal?.aborted).toBe(false)
      const unaffected = await current()
      expect(unaffected.readinessCheck).toEqual(pending.readinessCheck)
      expect(unaffected.messages).toEqual(pending.messages)
      expect(model.doStreamCalls).toHaveLength(4)
    } finally {
      gate.release(finalOutput())
      events = await automaticEvents
    }
    expect(events!.at(-1)).toMatchObject({type: 'done', requestId: automaticRequest.requestId, messageId: pending.readinessCheck!.messageId})
    expect(events!.some(event => event.type === 'error')).toBe(false)
    const completed = await current()
    expect(completed.readinessCheck).toMatchObject({status: 'completed', messageId: pending.readinessCheck!.messageId})
    expect(completed.messages).toHaveLength(pending.messages.length)
    expect(completed.messages.find(message => message.id === userDone.messageId)?.status).toBe('complete')
    expect(model.doStreamCalls).toHaveLength(4)
  })

  it('does not re-open the check when locale, conditions, meals, plan, or workout versions change', async () => {
    const model = contextThenAnswer()
    await open(model)
    await readEvents(await check())
    const key = (await current()).readinessCheck!.key
    await action({kind: 'set_locale', locale: 'zh-CN'})
    changeSnapshot(snapshot => {
      snapshot.conditions.version++
      snapshot.conditions.availableMinutes = 20
      snapshot.mealRevision++
      snapshot.plan.version++
      snapshot.workout!.version++
      snapshot.advice.status = 'stale'
    })
    const saved = await current()
    expect(saved.readinessCheck).toMatchObject({key, status: 'completed'})
    expect(saved.advice.status).toBe('stale')
    const reused = control(await readEvents(await check(request({locale: 'zh-CN'}))), ['reused', 'not_needed'])
    expect(reused.readinessCheck?.key).toBe(key)
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('persists provider failure, suppresses automatic retries, and admits a distinct explicit retry attempt', async () => {
    const model = scriptedModel([
      () => toolCall('get_day_context', {}, 'context-failed-run'),
      () => { throw new Error('Controlled provider failure') },
      () => toolCall('get_day_context', {}, 'context-retry-run'),
      () => finalOutput(),
    ])
    await open(model)
    const failedEvents = await readEvents(await check())
    expect(failedEvents.at(-1)?.type).toBe('error')
    const failed = await current()
    expect(failed.readinessCheck?.status).toBe('failed')
    expect(failed.messages.at(-1)?.status).toBe('failed')
    await open(model)
    const cached = control(await readEvents(await check()), ['reused', 'not_needed'])
    expect(cached.messages).toEqual(failed.messages)
    expect(model.doStreamCalls).toHaveLength(2)
    const retried = await readEvents(await check(request({checkMode: 'retry'})))
    expect(retried.at(-1)?.type).toBe('done')
    const saved = await current()
    expect(saved.readinessCheck).toMatchObject({key: failed.readinessCheck!.key, status: 'completed'})
    expect(saved.messages).toHaveLength(failed.messages.length + 1)
    expect(saved.messages.find(message => message.id === failed.messages.at(-1)!.id)?.status).toBe('failed')
    expect(model.doStreamCalls).toHaveLength(4)
  })

  it('persists an explicit Stop and does not restart the same key on a later automatic request', async () => {
    const gate = gatedStep()
    const model = scriptedModel([() => toolCall('get_day_context'), gate.step])
    await open(model)
    const controller = new AbortController()
    const reading = readEvents(await check(request(), controller.signal))
    await gate.entered
    controller.abort()
    await reading
    const stopped = await current()
    expect(stopped.readinessCheck?.status).toBe('stopped')
    expect(stopped.messages.at(-1)?.status).toBe('stopped')
    const cached = control(await readEvents(await check()), ['reused', 'not_needed'])
    expect(cached.messages).toEqual(stopped.messages)
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it.each(['missing', 'stale', 'failed'] as const)('does not invent a recovery score or run a personalized check for %s data', async quality => {
    const model = contextThenAnswer()
    await open(model)
    changeSnapshot(snapshot => { snapshot.readiness.quality = quality; snapshot.readiness.score = null })
    const saved = await current()
    expect(saved.readiness.score).toBeNull()
    const unavailable = control(await readEvents(await check()), ['not_needed', 'not_available'])
    expect(unavailable.readiness).toEqual(saved.readiness)
    expect(unavailable.messages).toEqual(saved.messages)
    expect(unavailable.plan).toEqual(saved.plan)
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('does not use an old readiness observation to generate a personalized check for today', async () => {
    const model = contextThenAnswer()
    await open(model)
    changeSnapshot(snapshot => { snapshot.readiness.dayKey = '2026-09-11' })
    control(await readEvents(await check()), ['not_needed', 'not_available'])
    expect(model.doStreamCalls).toHaveLength(0)
    expect((await current()).messages).toEqual(initial.messages)
  })

  it('uses a new check key only after a real reset and leaves old-epoch requests unable to call the SDK', async () => {
    const model = scriptedModel([() => toolCall('get_day_context', {}, 'before-reset'), () => finalOutput(), () => toolCall('get_day_context', {}, 'after-reset'), () => finalOutput()])
    await open(model)
    const oldRequest = request()
    await readEvents(await check(oldRequest))
    const oldKey = (await current()).readinessCheck!.key
    initial = await action({kind: 'reset_demo', scenario: 'normal'})
    const reset = await current()
    expect(reset.readinessCheck).toMatchObject({status: 'idle'})
    expect(reset.readinessCheck?.key).not.toBe(oldKey)
    const stale = await check(oldRequest)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({errorCode: 'STALE_EPOCH'})
    await readEvents(await check())
    expect(model.doStreamCalls).toHaveLength(4)
    expect((await current()).readinessCheck?.status).toBe('completed')
  })

  it('returns honest unavailability without any fake assistant, tool, or network attempt', async () => {
    await open()
    expect(initial.capabilities.agent).toBe(false)
    const response = await check()
    if (response.status === 503) expect(await response.json()).toMatchObject({errorCode: 'PROVIDER_NOT_CONFIGURED'})
    else {
      expect(response.status).toBe(200)
      const unavailable = control(await readEvents(response), ['not_available'])
      expect(unavailable.readinessCheck?.status).toBe('unavailable')
    }
    const saved = await current()
    expect(saved.messages).toEqual(initial.messages)
    expect(saved.plan).toEqual(initial.plan)
    expect(saved.readiness.score).toBe(initial.readiness.score)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('recovers an abandoned persisted claim after lease expiry and requires explicit retry before calling the SDK', async () => {
    const model = contextThenAnswer()
    await open(model)
    const connection = new WellioDatabase(databasePath)
    let abandonedMessageId: string
    try {
      const claim = claimRun(connection, initial.sessionId, request(), 1_000, now)
      expect(claim.type).toBe('run')
      if (claim.type !== 'run') throw new Error('Expected an acquired execution lease')
      abandonedMessageId = claim.run.messageId
      expect(connection.getSnapshot(initial.sessionId).readinessCheck?.status).toBe('pending')
      now = claim.run.leaseExpiresAt + 1
    } finally { connection.close() }
    const recovered = await open(model)
    expect(recovered.readinessCheck).toMatchObject({status: 'failed', errorCode: 'RUN_LEASE_EXPIRED'})
    expect(recovered.messages.find(message => message.id === abandonedMessageId)).toMatchObject({status: 'failed', steps: [], errorCode: 'RUN_LEASE_EXPIRED'})
    control(await readEvents(await check()), ['not_needed', 'reused'])
    expect(model.doStreamCalls).toHaveLength(0)
    const events = await readEvents(await check(request({checkMode: 'retry'})))
    expect(events.at(-1)?.type).toBe('done')
    expect((await current()).readinessCheck?.status).toBe('completed')
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it.each(['id', 'version', 'day'] as const)('creates a distinct check key when the authoritative readiness %s changes', async field => {
    const model = scriptedModel([() => toolCall('get_day_context', {}, 'first-observation'), () => finalOutput(), () => toolCall('get_day_context', {}, 'new-observation'), () => finalOutput()])
    await open(model)
    await readEvents(await check())
    const key = (await current()).readinessCheck!.key
    changeSnapshot(snapshot => {
      if (field === 'id') snapshot.readiness.id = 'new-watch-observation'
      else if (field === 'version') snapshot.readiness.version++
      else { snapshot.dayKey = '2026-09-13'; snapshot.readiness.dayKey = '2026-09-13' }
    })
    const updated = await current()
    expect(updated.readinessCheck).toMatchObject({status: 'idle'})
    expect(updated.readinessCheck?.key).not.toBe(key)
    await readEvents(await check())
    expect(model.doStreamCalls).toHaveLength(4)
    expect((await current()).readinessCheck?.status).toBe('completed')
  })

  it.each(['apply_proposal', 'dismiss_proposal'] as const)('creates a real low-recovery proposal without applying it, then consumes the matching check atomically on %s', async kind => {
    const model = scheduleModel()
    await open(model)
    initial = await action({kind: 'reset_demo', scenario: 'low_recovery'})
    initial = await current()
    const events = await readEvents(await check())
    expect(events.at(-1)?.type).toBe('done')
    const proposed = await current()
    expect(proposed.plan).toEqual(initial.plan)
    expect(proposed.workout).toEqual(initial.workout)
    expect(proposed.proposals).toHaveLength(1)
    const proposal = proposed.proposals[0]
    expect(proposal).toMatchObject({scope: 'schedule', status: 'pending', readinessSnapshotId: initial.readiness.id, checkKey: proposed.readinessCheck!.key, messageId: proposed.readinessCheck!.messageId})
    expect(proposed.readinessCheck).toMatchObject({status: 'completed', proposalId: proposal.id})
    expect(proposed.messages.find(message => message.id === proposal.messageId)?.proposalId).toBe(proposal.id)
    expect(proposal.moves?.map(move => move.to)).toEqual(['2026-09-14', '2026-09-16', '2026-09-18'])
    expect(proposed.messages.at(-1)?.steps).toContainEqual(expect.objectContaining({operation: 'workout_proposal', status: 'succeeded'}))
    await open(model)
    if (kind === 'apply_proposal') {
      const deniedStart = await backend!.handleRequest(new Request('http://wellio.test/api/actions', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify({kind, proposalId: proposal.id, startAfterApply: true, source: 'today', requestId: 'reject-rest-start', resetEpoch: initial.resetEpoch})}))
      expect(deniedStart.status).toBe(400)
      expect(await deniedStart.json()).toMatchObject({errorCode: 'REST_CANNOT_START'})
      expect((await current()).readinessCheck).toEqual(proposed.readinessCheck)
    }
    const saved = await action(kind === 'apply_proposal' ? {kind, proposalId: proposal.id, startAfterApply: false} : {kind, proposalId: proposal.id})
    expect(saved.readinessCheck).toMatchObject({key: proposal.checkKey, status: kind === 'apply_proposal' ? 'applied' : 'dismissed', proposalId: proposal.id})
    if (kind === 'apply_proposal') {
      expect(saved.plan.sessions.slice(0, 3).map(session => session.date)).toEqual(['2026-09-14', '2026-09-16', '2026-09-18'])
      expect(saved.plan.restDates).toContain('2026-09-12')
      expect(saved.workout).toMatchObject({status: 'planned', dayKey: '2026-09-14'})
      expect(saved.workout?.startedAt).toBeUndefined()
    } else {
      expect(saved.plan).toEqual(initial.plan)
      expect(saved.workout).toEqual(initial.workout)
    }
    expect(saved.history).toEqual(initial.history)
    await open(model)
    const cached = control(await readEvents(await check(request({checkMode: 'retry'}))), ['reused', 'not_needed'])
    expect(cached.plan).toEqual(saved.plan)
    expect(cached.messages).toEqual(saved.messages)
    expect(cached.readinessCheck).toEqual(saved.readinessCheck)
    expect(model.doStreamCalls).toHaveLength(3)
  })

  it('rolls back both schedule Apply and check consumption when SQLite rejects the plan update', async () => {
    const model = scheduleModel()
    await open(model)
    initial = await action({kind: 'reset_demo', scenario: 'low_recovery'})
    await readEvents(await check())
    const proposed = await current()
    const proposal = proposed.proposals[0]
    const input = {kind: 'apply_proposal', proposalId: proposal.id, startAfterApply: false, source: 'today', requestId: 'atomic-readiness-apply', resetEpoch: proposed.resetEpoch}
    const apply = () => backend!.handleRequest(new Request('http://wellio.test/api/actions', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(input)}))
    const connection = new DatabaseSync(databasePath)
    try {
      connection.exec("CREATE TRIGGER reject_schedule_apply BEFORE UPDATE ON sessions WHEN json_extract(NEW.snapshot_json, '$.plan.version') > json_extract(OLD.snapshot_json, '$.plan.version') BEGIN SELECT RAISE(ABORT, 'injected apply failure'); END")
      const failed = await apply()
      expect(failed.status).toBe(500)
      const unchanged = await current()
      expect(unchanged.plan).toEqual(proposed.plan)
      expect(unchanged.proposals).toEqual(proposed.proposals)
      expect(unchanged.readinessCheck).toEqual(proposed.readinessCheck)
      connection.exec('DROP TRIGGER reject_schedule_apply')
    } finally { connection.close() }
    const completed = await apply()
    expect(completed.status).toBe(200)
    const result = await completed.json() as ActionResult
    expect(result.snapshot?.readinessCheck?.status).toBe('applied')
    expect(result.snapshot?.plan.sessions[0].date).toBe('2026-09-14')
    expect(model.doStreamCalls).toHaveLength(3)
  })

  it.each(['mutate_meal_log', 'record_workout_progress', 'undo_meal_change'] as const)('refuses automatic %s even when the model supplies an otherwise valid domain call', async name => {
    const model = scriptedModel([
      () => toolCall('get_day_context'),
      options => {
        const context = latestToolResult<{snapshot: Snapshot}>(options, 'get_day_context')
        const input = name === 'record_workout_progress' ? {kind: 'start_workout', workoutId: context.snapshot.workout!.id}
          : name === 'undo_meal_change' ? {operationId: 'not-user-approved'}
            : {action: 'delete', mealId: context.snapshot.meals[0].id}
        return toolCall(name, input, 'forbidden-auto-write')
      },
      () => finalOutput(),
    ])
    await open(model)
    const events = await readEvents(await check())
    const saved = await current()
    expect(saved.workout).toEqual(initial.workout)
    expect(saved.meals).toEqual(initial.meals)
    expect(saved.plan).toEqual(initial.plan)
    expect(events.filter(event => event.type === 'tool').map(event => event.step)).toContainEqual(expect.objectContaining({toolCallId: 'forbidden-auto-write', status: 'failed', errorCode: 'USER_INTENT_REQUIRED'}))
    expect(JSON.stringify(model.doStreamCalls.at(-1)!.prompt)).toContain('USER_INTENT_REQUIRED')
  })

  it.each(['in_progress', 'completed'] as const)('never shifts a %s session even when a low-recovery model requests a schedule proposal', async status => {
    const model = scheduleModel()
    await open(model)
    initial = await action({kind: 'reset_demo', scenario: 'low_recovery'})
    const started = await action({kind: 'start_workout', workoutId: initial.workout!.id, expectedWorkoutVersion: initial.workout!.version})
    if (status === 'completed') await action({kind: 'finish_workout', workoutId: started.workout!.id, expectedWorkoutVersion: started.workout!.version, actualMinutes: 25, confirmIncomplete: true})
    const before = await current()
    const events = await readEvents(await check())
    const saved = await current()
    expect(saved.workout).toEqual(before.workout)
    expect(saved.plan).toEqual(before.plan)
    expect(saved.history).toEqual(before.history)
    expect(saved.proposals).toEqual(before.proposals)
    expect(events.filter(event => event.type === 'tool').map(event => event.step)).toContainEqual(expect.objectContaining({operation: 'workout_proposal', status: 'failed'}))
  })
})
