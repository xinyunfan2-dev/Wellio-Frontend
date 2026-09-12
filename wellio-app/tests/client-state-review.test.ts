import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReactElement } from 'react'
import type { ActionRequest, ActionResult, ChatEvent, ChatRequest, Locale, Message, Snapshot } from '../src/lib/contracts'
import { createFixture } from '../src/lib/fixtures'
import { createBackend } from '../src/server/app'

// This is a narrow asynchronous-state harness: the real provider handlers run,
// while hook cells are retained between explicit renders. No UI is simulated.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, locale: 'en' as Locale }))
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>()
  return { ...original,
    useEffect: () => undefined,
    useState: <T,>(initial: T) => {
      const index = hooks.cursor++
      if (!(index in hooks.cells)) hooks.cells[index] = initial
      return [hooks.cells[index], (next: T | ((old: T) => T)) => {
        hooks.cells[index] = typeof next === 'function' ? (next as (old: T) => T)(hooks.cells[index] as T) : next
      }]
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++
      if (!(index in hooks.cells)) hooks.cells[index] = { current: initial }
      return hooks.cells[index]
    },
  }
})
vi.mock('../src/lib/i18n', () => ({ useI18n: () => ({ locale: hooks.locale, setLocale: (locale: Locale) => { hooks.locale = locale } }) }))

import { api, ApiError } from '../src/lib/api-client'
import { WellioProvider, type ChatTarget, type useWellio } from '../src/lib/wellio-context'

function render() {
  hooks.cursor = 0
  return (WellioProvider({ children: null }) as ReactElement<{ value: ReturnType<typeof useWellio> }>).props.value
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function message(id: string): Message {
  return { id, role: 'assistant', content: '', createdAt: '2026-09-12T08:00:00+08:00', source: 'agent', status: 'streaming', phase: 'thinking', steps: [] }
}
const request: ChatRequest = { requestId: 'request-current', resetEpoch: 1, conversationId: 'preview-conversation', message: 'Log this meal', locale: 'en', attachmentIds: ['image-1'], source: 'user' }

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.locale = 'en' })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Client transport review: success must be explicit', () => {
  it('rejects an empty HTTP 200 stream instead of reporting chat success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')))
    await expect(api.chat(request, vi.fn(), new AbortController().signal)).rejects.toThrow()
  })

  it('rejects a truncated stream that has no terminal done event', async () => {
    const event: ChatEvent = { type: 'message', requestId: request.requestId, resetEpoch: 1, message: message('partial') }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(event) + '\n')))
    const onEvent = vi.fn()
    await expect(api.chat(request, onEvent, new AbortController().signal)).rejects.toThrow()
  })

  it('delivers a server error to the UI and rejects the chat promise', async () => {
    const event: ChatEvent = { type: 'error', requestId: request.requestId, resetEpoch: 1, errorCode: 'PROVIDER_ERROR' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(event) + '\n')))
    const onEvent = vi.fn()
    await expect(api.chat(request, onEvent, new AbortController().signal)).rejects.toBeInstanceOf(ApiError)
    expect(onEvent).toHaveBeenCalledWith(event)
  })

  it('completes only a stream with a terminal event for this request and reset epoch', async () => {
    const done: ChatEvent = { type: 'done', requestId: request.requestId, resetEpoch: request.resetEpoch, messageId: 'complete-reply' }
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(done) + '\n'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...done, requestId: 'foreign-request' }) + '\n'))
    vi.stubGlobal('fetch', fetch)
    await expect(api.chat(request, vi.fn(), new AbortController().signal)).resolves.toBeUndefined()
    await expect(api.chat(request, vi.fn(), new AbortController().signal)).rejects.toThrow('STREAM_PROTOCOL_ERROR')
  })
})

describe('Client provider review: concurrent and cancelled work', () => {
  it.each(['failed', 'stopped'] as const)('keeps authoritative %s status and saved metadata after snapshot → error', async status => {
    const seed = createFixture()
    const savedMessage: Message = { ...message('saved-reply'), status, phase: undefined, operationId: 'saved-meal-operation', mealId: 'meal-lunch', errorCode: status === 'stopped' ? 'USER_PRIORITY' : 'PROVIDER_ERROR' }
    const saved = { ...seed, revision: 2, messages: [savedMessage] }
    vi.spyOn(api, 'getSnapshot').mockResolvedValue(seed)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const submitted = JSON.parse(init.body as string) as ChatRequest
      const envelope = { requestId: submitted.requestId, resetEpoch: submitted.resetEpoch }
      const events: ChatEvent[] = [
        { type: 'message', ...envelope, message: message('saved-reply') },
        { type: 'snapshot', ...envelope, snapshot: saved },
        { type: 'error', ...envelope, messageId: savedMessage.id, errorCode: status === 'stopped' ? 'RUN_STOPPED' : 'PROVIDER_ERROR' },
      ]
      return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n')
    }))
    let value = render(); await value.refresh(); value.setDraft('Keep my unsent correction'); value = render()
    await expect(value.sendMessage(value.draft)).rejects.toBeInstanceOf(ApiError)
    expect(render().snapshot!.messages).toEqual([savedMessage])
    expect(render().draft).toBe('Keep my unsent correction')
    expect(render().chatBusy).toBe(false)
  })

  it.each([
    [{ mealId: 'meal-lunch', mealItemId: 'item-rice' }, { targetMealId: 'meal-lunch', targetMealItemId: 'item-rice' }],
    [{ operationId: 'saved-meal-operation' }, { targetOperationId: 'saved-meal-operation' }],
  ] satisfies [ChatTarget, Partial<ChatRequest>][])('transmits only the explicit optional target %j', async (target, expected) => {
    vi.spyOn(api, 'getSnapshot').mockResolvedValue(createFixture())
    const chat = vi.spyOn(api, 'chat').mockResolvedValue(undefined)
    let value = render(); await value.refresh(); value.setChatTarget(target); value = render()
    await value.sendMessage('Make this change')
    const submitted = chat.mock.calls[0][0]
    expect(submitted).toMatchObject(expected)
    expect(submitted).not.toHaveProperty('sourceMessageId')
    expect(submitted).not.toHaveProperty('checkKey')
    expect(submitted).not.toHaveProperty('checkAttemptId')
  })

  it('keeps server source and check identities through snapshot → done and final reconciliation', async () => {
    let saved = createFixture()
    saved.capabilities.agent = true
    saved.readinessCheck = { key: 'server-check', status: 'idle' }
    vi.spyOn(api, 'getSnapshot').mockImplementation(async () => saved)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const submitted = JSON.parse(init.body as string) as ChatRequest
      const envelope = { requestId: submitted.requestId, resetEpoch: submitted.resetEpoch }
      const reply: Message = { ...message('check-reply'), source: 'app_open', status: 'complete', phase: undefined, proposalId: 'check-proposal' }
      saved = {
        ...saved, revision: 2, messages: [reply],
        conditions: { ...saved.conditions, lastChange: { sourceMessageId: 'earlier-user-message', requestId: 'earlier-user-request', version: saved.conditions.version } },
        readinessCheck: { key: 'server-check', status: 'completed', messageId: reply.id, proposalId: 'check-proposal' },
        proposals: [{ id: 'check-proposal', scope: 'workout', status: 'pending', reason: { en: 'Adjust after recovery review', 'zh-CN': '结合恢复情况调整' }, expected: { meal: saved.mealRevision, plan: saved.plan.version, workout: saved.workout!.version, conditions: saved.conditions.version, readiness: saved.readiness.version }, contextReadId: 'context-read', readinessSnapshotId: saved.readiness.id, messageId: reply.id, checkKey: 'server-check', checkAttemptId: 'server-attempt' }],
      }
      const events: ChatEvent[] = [
        { type: 'message', ...envelope, message: { ...reply, status: 'streaming' } },
        { type: 'snapshot', ...envelope, snapshot: saved },
        { type: 'done', ...envelope, messageId: reply.id },
      ]
      return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n')
    }))
    let value = render(); value.setDraft('My next question'); value.setChatTarget({ mealId: 'meal-lunch' }); value = render()
    await value.checkReadiness()
    expect(render().snapshot).toEqual(saved)
    expect(render().snapshot!.proposals[0]).toMatchObject({ checkKey: 'server-check', checkAttemptId: 'server-attempt' })
    expect(render().snapshot!.conditions.lastChange?.sourceMessageId).toBe('earlier-user-message')
    expect(render().draft).toBe('My next question')
    expect(render().chatTarget).toEqual({ mealId: 'meal-lunch' })
    expect(render().readinessBusy).toBe(false)
  })

  it('preserves a streamed message when an earlier read returns the same revision', async () => {
    const seed = createFixture(), staleRead = deferred<Snapshot>(), chat = deferred<void>()
    vi.spyOn(api, 'getSnapshot').mockResolvedValueOnce(seed).mockReturnValueOnce(staleRead.promise).mockResolvedValue(seed)
    let emit!: (event: ChatEvent) => void, requestId = ''
    vi.spyOn(api, 'chat').mockImplementation((request, callback) => { requestId = request.requestId; emit = callback; return chat.promise })
    let value = render(); await value.refresh(); value = render()
    const refresh = value.refresh(), sending = value.sendMessage('hello')
    emit({ type: 'message', requestId, resetEpoch: 1, message: message('live') })
    expect(render().snapshot!.messages[0].id).toBe('live')
    staleRead.resolve(seed); await refresh
    const retained = render().snapshot!.messages.some(item => item.id === 'live')
    chat.resolve(); await sending
    expect(retained).toBe(true)
  })

  it('ignores events that belong to a different request in the same reset epoch', async () => {
    const seed = createFixture(), chat = deferred<void>()
    vi.spyOn(api, 'getSnapshot').mockResolvedValue(seed)
    let emit!: (event: ChatEvent) => void
    vi.spyOn(api, 'chat').mockImplementation((_request, callback) => { emit = callback; return chat.promise })
    let value = render(); await value.refresh(); value = render()
    const sending = value.sendMessage('hello')
    emit({ type: 'message', requestId: 'a-previous-run', resetEpoch: 1, message: message('foreign') })
    const acceptedForeignEvent = render().snapshot!.messages.some(item => item.id === 'foreign')
    chat.resolve(); await sending
    expect(acceptedForeignEvent).toBe(false)
  })

  it('does not stop messages from a new reset epoch when an old abort settles late', async () => {
    const seed = createFixture(), chat = deferred<void>(), reset = { ...createFixture('low_recovery'), resetEpoch: 2, messages: [message('new-epoch-reply')] }
    vi.spyOn(api, 'getSnapshot').mockResolvedValue(seed)
    vi.spyOn(api, 'chat').mockReturnValue(chat.promise)
    vi.spyOn(api, 'action').mockResolvedValue({ requestId: 'reset-1', status: 'succeeded', snapshot: reset })
    let value = render(); await value.refresh(); value = render()
    const sending = value.sendMessage('old question').catch(error => error)
    await value.runAction({ kind: 'reset_demo', scenario: 'low_recovery' }, 'profile')
    chat.reject(new DOMException('Aborted', 'AbortError')); await sending
    expect(render().snapshot!.messages[0].status).toBe('streaming')
  })

  it('rejects an overlapping send instead of resolving as if that request was sent', async () => {
    const seed = createFixture(), chat = deferred<void>()
    vi.spyOn(api, 'getSnapshot').mockResolvedValue(seed)
    const apiChat = vi.spyOn(api, 'chat').mockReturnValue(chat.promise)
    let value = render(); await value.refresh(); value = render()
    const first = value.sendMessage('first')
    let secondRejected = false
    await value.sendMessage('second', [{ id: 'image-2', name: 'meal.png', url: '/meal.png', mediaType: 'image/png', purpose: 'food' }]).catch(() => { secondRejected = true })
    chat.resolve(); await first
    expect(apiChat).toHaveBeenCalledTimes(1)
    expect(secondRejected).toBe(true)
  })

  it('marks the current partial reply failed when the transport rejects without an error event', async () => {
    const seed = createFixture(), chat = deferred<void>()
    vi.spyOn(api, 'getSnapshot').mockResolvedValue(seed)
    let emit!: (event: ChatEvent) => void, requestId = ''
    vi.spyOn(api, 'chat').mockImplementation((request, callback) => { requestId = request.requestId; emit = callback; return chat.promise })
    let value = render(); await value.refresh(); value = render()
    const sending = value.sendMessage('hello').catch(error => error)
    emit({ type: 'message', requestId, resetEpoch: 1, message: message('partial') })
    chat.reject(new ApiError('NETWORK_ERROR')); await sending
    expect(render().snapshot!.messages[0].status).toBe('failed')
    expect(render().snapshot!.messages[0].phase).toBeUndefined()
  })

  it('does not return an old successful action as current success after another reset is observed', async () => {
    const seed = createFixture(), action = deferred<Awaited<ReturnType<typeof api.action>>>()
    const reset = { ...createFixture('low_recovery'), resetEpoch: 2 }
    vi.spyOn(api, 'getSnapshot').mockResolvedValueOnce(seed).mockResolvedValue(reset)
    vi.spyOn(api, 'action').mockReturnValue(action.promise)
    let value = render(); await value.refresh(); value = render()
    const saving = value.runAction({ kind: 'dismiss_proposal', proposalId: 'old-proposal' }, 'agent')
    await value.refresh()
    action.resolve({ requestId: 'old-action', status: 'succeeded', snapshot: { ...seed, revision: 2 } })
    const result = await saving
    expect(render().snapshot!.resetEpoch).toBe(2)
    expect(result?.status).not.toBe('succeeded')
  })

  it('accepts saved message metadata from the final refresh after chat has finished', async () => {
    const seed = createFixture(), chat = deferred<void>()
    const saved = { ...seed, revision: 2, messages: [{ ...message('meal-reply'), status: 'complete' as const, phase: undefined, operationId: 'save-meal-1', mealId: 'meal-lunch' }] }
    vi.spyOn(api, 'getSnapshot').mockResolvedValueOnce(seed).mockResolvedValue(saved)
    let emit!: (event: ChatEvent) => void, requestId = ''
    vi.spyOn(api, 'chat').mockImplementation((request, callback) => { requestId = request.requestId; emit = callback; return chat.promise })
    let value = render(); await value.refresh(); value = render()
    const sending = value.sendMessage('Log this meal')
    emit({ type: 'message', requestId, resetEpoch: 1, message: message('meal-reply') })
    emit({ type: 'done', requestId, resetEpoch: 1, messageId: 'meal-reply' })
    chat.resolve(); await sending
    expect(render().snapshot!.revision).toBe(2)
    expect(render().snapshot!.messages[0].operationId).toBe('save-meal-1')
  })

  it('keeps an active request in its original language and sends the next request in the selected language', async () => {
    const seed = createFixture(), firstChat = deferred<void>()
    vi.spyOn(api, 'getSnapshot').mockResolvedValue(seed)
    const apiChat = vi.spyOn(api, 'chat').mockReturnValueOnce(firstChat.promise).mockResolvedValue(undefined)
    let value = render(); await value.refresh(); value = render()
    const first = value.sendMessage('English request')
    hooks.locale = 'zh-CN'; value = render()
    expect(value.snapshot!.resetEpoch).toBe(1)
    firstChat.resolve(); await first
    await render().sendMessage('中文请求')
    expect(apiChat.mock.calls.map(call => call[0].locale)).toEqual(['en', 'zh-CN'])
  })
})

describe('Client action recovery against persistent storage', () => {
  async function storage() {
    const directory = mkdtempSync(join(tmpdir(), 'wellio-client-recovery-'))
    const backend = createBackend({ databasePath: join(directory, 'state.sqlite'), cookieSecure: false })
    const response = await backend.handleRequest(new Request('http://localhost/api/state'))
    const cookie = response.headers.get('set-cookie')!.split(';')[0]
    const seed = await response.json() as Snapshot
    return {
      seed,
      async state(): Promise<Snapshot> {
        return await (await backend.handleRequest(new Request('http://localhost/api/state', { headers: { cookie } }))).json() as Snapshot
      },
      async action(request: ActionRequest): Promise<ActionResult> {
        const response = await backend.handleRequest(new Request('http://localhost/api/actions', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(request),
        }))
        expect(response.status).toBe(200)
        return await response.json() as ActionResult
      },
      close() { backend.close(); rmSync(directory, { recursive: true, force: true }) },
    }
  }

  it('reuses the uncertain request ID after a lost response and stale read, committing only once', async () => {
    const server = await storage()
    try {
      const order: string[] = [], submitted: ActionRequest[] = []
      let committed: ActionResult | undefined
      vi.spyOn(api, 'getSnapshot').mockImplementation(async () => { order.push('read'); return server.seed })
      vi.spyOn(api, 'action').mockImplementation(async request => {
        submitted.push(request); order.push('action')
        const result = await server.action(request)
        if (submitted.length === 1) { committed = result; throw new TypeError('Response connection lost after commit') }
        return result
      })
      let value = render(); await value.refresh(); value = render()
      const first = await value.runAction({ kind: 'set_locale', locale: 'zh-CN' }, 'profile')
      expect(first).toBeNull()
      expect(order).toEqual(['read', 'action', 'read'])
      expect(render().snapshot!.revision).toBe(server.seed.revision)
      const retried = await render().runAction({ kind: 'set_locale', locale: 'zh-CN' }, 'profile')
      expect(retried?.status).toBe('succeeded')
      expect(submitted[1]).toEqual(submitted[0])
      expect(retried?.operationId).toBe(committed?.operationId)
      const saved = await server.state()
      expect(saved.locale).toBe('zh-CN')
      expect(saved.revision).toBe(server.seed.revision + 1)
      expect(render().snapshot).toEqual(saved)
    } finally { server.close() }
  })

  it('does not replay an old request after reconciliation observes a new reset epoch', async () => {
    const server = await storage()
    try {
      const submitted: ActionRequest[] = []
      vi.spyOn(api, 'getSnapshot').mockResolvedValueOnce(server.seed).mockImplementation(async () => {
        await server.action({ kind: 'reset_demo', scenario: 'low_recovery', requestId: 'external-reset', resetEpoch: server.seed.resetEpoch, source: 'profile' })
        return server.state()
      })
      vi.spyOn(api, 'action').mockImplementation(async request => {
        submitted.push(request)
        const result = await server.action(request)
        if (submitted.length === 1) throw new TypeError('Response connection lost after commit')
        return result
      })
      let value = render(); await value.refresh(); value = render()
      expect(await value.runAction({ kind: 'set_locale', locale: 'zh-CN' }, 'profile')).toBeNull()
      expect(submitted).toHaveLength(1)
      expect(render().snapshot!.resetEpoch).toBe(server.seed.resetEpoch + 1)
      // This is a new explicit user action in the new epoch, not an automatic replay.
      const result = await render().runAction({ kind: 'set_locale', locale: 'zh-CN' }, 'profile')
      expect(result?.status).toBe('succeeded')
      expect(submitted).toHaveLength(2)
      expect(submitted[1].requestId).not.toBe(submitted[0].requestId)
      expect(submitted.map(item => item.resetEpoch)).toEqual([server.seed.resetEpoch, server.seed.resetEpoch + 1])
      expect((await server.state()).resetEpoch).toBe(server.seed.resetEpoch + 1)
    } finally { server.close() }
  })
})
