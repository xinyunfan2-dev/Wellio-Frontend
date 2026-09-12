import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {ActionResult, Snapshot} from '../../src/lib/contracts'
import {createBackend} from '../../src/server/app'
import {finalOutput, gatedStep, latestToolResult, scriptedModel, toolCall, type ModelStep} from './sdk-fixtures'

type Context = {id: string; snapshot: Snapshot}

describe('Stage 4 proposal Action identity and replay through the real SDK', () => {
  let directory: string
  let backend: ReturnType<typeof createBackend> | undefined
  let initial: Snapshot
  let cookie: string
  let requests: Promise<Response>[]

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-proposal-replay-'))
    backend = undefined
    requests = []
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected external network request'))))
  })

  afterEach(async () => {
    backend?.close()
    await Promise.allSettled(requests)
    rmSync(directory, {recursive: true, force: true})
    vi.unstubAllGlobals()
  })

  async function open(steps: ModelStep[]) {
    const model = scriptedModel(steps)
    backend = createBackend({databasePath: join(directory, 'state.sqlite'), cookieSecure: false, agent: {model}})
    const response = await backend.handleRequest(new Request('http://wellio.test/api/state'))
    expect(response.status).toBe(200)
    initial = await response.json() as Snapshot
    cookie = response.headers.get('set-cookie')!.split(';')[0]
    return model
  }

  function action(input: Record<string, unknown>) {
    const response = backend!.handleRequest(new Request('http://wellio.test/api/actions', {
      method: 'POST', headers: {cookie, 'content-type': 'application/json'},
      body: JSON.stringify({requestId: crypto.randomUUID(), resetEpoch: initial.resetEpoch, source: 'today', ...input}),
    }))
    requests.push(response)
    return response
  }

  async function state() {
    const response = await backend!.handleRequest(new Request('http://wellio.test/api/state', {headers: {cookie}}))
    expect(response.status).toBe(200)
    return response.json() as Promise<Snapshot>
  }

  function proposeCurrent(options: Parameters<ModelStep>[0]) {
    const context = latestToolResult<Context>(options, 'get_day_context')
    return toolCall('propose_workout', {scope: 'workout', contextReadId: context.id,
      reason: {en: 'Retain the verified current workout.', 'zh-CN': '保留已核实的当前训练。'}, workout: context.snapshot.workout})
  }

  function completedProposalSteps(): ModelStep[] {
    return [() => toolCall('get_day_context'), proposeCurrent, options => {
      expect(latestToolResult(options, 'propose_workout')).toMatchObject({result: {status: 'succeeded'}})
      return finalOutput()
    }]
  }

  it('returns the original successful Action receipt after locale changes without another SDK run', async () => {
    const model = await open(completedProposalSteps())
    const request = {kind: 'request_proposal', requestId: 'completed-proposal', gymId: 'gym-b'}
    const first = await action(request)
    expect(first.status).toBe(200)
    const receipt = await first.json() as ActionResult
    expect(receipt).toMatchObject({status: 'succeeded', proposalId: expect.any(String)})
    const changeLocale = await action({kind: 'set_locale', source: 'profile', locale: 'zh-CN'})
    expect(changeLocale.status).toBe(200)
    const beforeReplay = await state()
    expect(beforeReplay.locale).toBe('zh-CN')

    const replay = await action(request)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(receipt)
    expect(await state()).toEqual(beforeReplay)
    expect(model.doStreamCalls).toHaveLength(3)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('rejects a UUID already used by another Action before creating messages, proposals, or SDK calls', async () => {
    const model = await open(completedProposalSteps())
    const existing = await action({kind: 'set_locale', requestId: 'already-used', source: 'profile', locale: 'zh-CN'})
    expect(existing.status).toBe(200)
    const before = await state()

    const conflicting = await action({kind: 'request_proposal', requestId: 'already-used', gymId: 'gym-b'})
    expect(conflicting.status).toBe(409)
    expect(await conflicting.json()).toMatchObject({errorCode: 'IDEMPOTENCY_CONFLICT'})
    expect(await state()).toEqual(before)
    expect(model.doStreamCalls).toHaveLength(0)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('returns STALE_EPOCH instead of an internal error when reset removes an executing proposal run', async () => {
    const gate = gatedStep()
    const model = await open([() => toolCall('get_day_context'), gate.step])
    const pending = action({kind: 'request_proposal', requestId: 'reset-during-proposal', gymId: 'gym-b'})
    const providerCall = await gate.entered
    const reset = await action({kind: 'reset_demo', requestId: 'new-demo', source: 'profile', scenario: 'normal'})
    expect(reset.status).toBe(200)
    const resetState = await state()
    expect(resetState.resetEpoch).toBe(initial.resetEpoch + 1)
    expect(providerCall.abortSignal?.aborted).toBe(true)

    const response = await pending
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({requestId: 'reset-during-proposal', errorCode: 'STALE_EPOCH'})
    expect(await state()).toEqual(resetState)
    expect(resetState.proposals).toHaveLength(0)
    expect(resetState.messages).toHaveLength(0)
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('matches a pending proposal by its original Action after a locale change and leaves its provider active', async () => {
    const gate = gatedStep()
    const model = await open([() => toolCall('get_day_context'), gate.step, () => finalOutput()])
    const request = {kind: 'request_proposal', requestId: 'pending-locale', gymId: 'gym-b'}
    const pending = action(request)
    const providerCall = await gate.entered
    try {
      expect((await action({kind: 'set_locale', source: 'profile', locale: 'zh-CN'})).status).toBe(200)
      const beforeRetry = await state()
      const replay = await action(request)
      expect(replay.status).toBe(409)
      expect(await replay.json()).toMatchObject({errorCode: 'RUN_IN_PROGRESS'})
      expect(providerCall.abortSignal?.aborted).toBe(false)
      expect(await state()).toEqual(beforeRetry)
      expect(model.doStreamCalls).toHaveLength(2)
    } finally {
      gate.release(proposeCurrent(providerCall))
    }

    const response = await pending
    expect(response.status).toBe(200)
    const receipt = await response.json() as ActionResult
    expect(receipt).toMatchObject({status: 'succeeded', proposalId: expect.any(String)})
    const saved = await state()
    expect(saved.locale).toBe('zh-CN')
    expect(saved.proposals).toHaveLength(1)
    expect(saved.messages).toHaveLength(1)
    expect(saved.messages[0]).toMatchObject({status: 'complete', proposalId: receipt.proposalId})
    expect(await (await action(request)).json()).toEqual(receipt)
    expect(model.doStreamCalls).toHaveLength(3)
  })

  it('reserves a pending proposal UUID against a different Action and retains that protection after completion', async () => {
    const gate = gatedStep()
    const model = await open([() => toolCall('get_day_context'), gate.step, () => finalOutput()])
    const request = {kind: 'request_proposal', requestId: 'reserved-proposal', gymId: 'gym-b'}
    const conflictingAction = {kind: 'set_locale', requestId: request.requestId, source: 'profile', locale: 'zh-CN'}
    const pending = action(request)
    const providerCall = await gate.entered
    try {
      const before = await state()
      const conflicting = await action(conflictingAction)
      expect(conflicting.status).toBe(409)
      expect(await conflicting.json()).toMatchObject({errorCode: 'IDEMPOTENCY_CONFLICT'})
      expect(await state()).toEqual(before)
      expect(providerCall.abortSignal?.aborted).toBe(false)
      expect(model.doStreamCalls).toHaveLength(2)
    } finally {
      gate.release(proposeCurrent(providerCall))
    }

    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({status: 'succeeded', proposalId: expect.any(String)})
    const completed = await state()
    expect(completed.locale).toBe('en')
    expect(completed.proposals).toHaveLength(1)
    const conflicting = await action(conflictingAction)
    expect(conflicting.status).toBe(409)
    expect(await conflicting.json()).toMatchObject({errorCode: 'IDEMPOTENCY_CONFLICT'})
    expect(await state()).toEqual(completed)
    expect(model.doStreamCalls).toHaveLength(3)
  })
})
