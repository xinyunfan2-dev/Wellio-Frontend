import type {LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4StreamResult} from '@ai-sdk/provider'
import {simulateReadableStream} from 'ai'
import {MockLanguageModelV4} from 'ai/test'
import type {ChatEvent} from '../../src/lib/contracts'

export interface FinalAnswer { markdown: string; trainingSummary: string; nutritionSummary: string }
export const normalAnswer: FinalAnswer = {
  markdown: 'Your recovery is 82/100. Keep today’s Pull session and review dinner protein.',
  trainingSummary: 'Recovery 82/100; the current Pull session can stay as planned.',
  nutritionSummary: 'Use today’s recorded intake when choosing dinner.',
}

const usage = {
  inputTokens: {total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined},
  outputTokens: {total: 18, text: 18, reasoning: undefined},
}

export function streamed(parts: LanguageModelV4StreamPart[]): LanguageModelV4StreamResult {
  return {stream: simulateReadableStream({chunks: parts, initialDelayInMs: 0, chunkDelayInMs: 0})}
}

export function toolCall(toolName: string, input: unknown = {}, toolCallId = `${toolName}-call`): LanguageModelV4StreamResult {
  return streamed([
    {type: 'stream-start', warnings: []},
    {type: 'tool-input-start', id: toolCallId, toolName},
    {type: 'tool-input-delta', id: toolCallId, delta: JSON.stringify(input)},
    {type: 'tool-input-end', id: toolCallId},
    {type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input)},
    {type: 'finish', finishReason: {unified: 'tool-calls', raw: undefined}, usage},
  ])
}

export function textOutput(text: string): LanguageModelV4StreamResult {
  const split = Math.floor(text.length / 2)
  return streamed([
    {type: 'stream-start', warnings: []},
    {type: 'text-start', id: 'answer'},
    {type: 'text-delta', id: 'answer', delta: text.slice(0, split)},
    {type: 'text-delta', id: 'answer', delta: text.slice(split)},
    {type: 'text-end', id: 'answer'},
    {type: 'finish', finishReason: {unified: 'stop', raw: undefined}, usage},
  ])
}

export function finalOutput(answer: FinalAnswer = normalAnswer): LanguageModelV4StreamResult {
  return textOutput(JSON.stringify(answer))
}

export type ModelStep = (options: LanguageModelV4CallOptions) => LanguageModelV4StreamResult | Promise<LanguageModelV4StreamResult>

/** Every entry is one provider call made by the real AI SDK, including tool loops. */
export function scriptedModel(steps: ModelStep[]): MockLanguageModelV4 {
  let next = 0
  return new MockLanguageModelV4({
    provider: 'wellio-offline-test',
    modelId: 'wellio-scripted-v4',
    doStream: async options => {
      const step = steps[next++]
      if (!step) throw new Error('Unexpected extra provider call in offline SDK fixture')
      return step(options)
    },
  })
}

export function contextThenAnswer(answer: FinalAnswer = normalAnswer) {
  return scriptedModel([() => toolCall('get_day_context'), () => finalOutput(answer)])
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return {promise, resolve, reject}
}

/** A provider that remains pending until an explicit fixture release or SDK abort. */
export function gatedStep() {
  const entered = deferred<LanguageModelV4CallOptions>()
  const release = deferred<LanguageModelV4StreamResult>()
  const step: ModelStep = options => {
    entered.resolve(options)
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(options.abortSignal?.reason ?? new DOMException('Aborted', 'AbortError'))
      if (options.abortSignal?.aborted) { onAbort(); return }
      options.abortSignal?.addEventListener('abort', onAbort, {once: true})
      release.promise.then(resolve, reject).finally(() => options.abortSignal?.removeEventListener('abort', onAbort))
    })
  }
  return {step, entered: entered.promise, release: release.resolve, fail: release.reject}
}

export async function readEvents(response: Response): Promise<ChatEvent[]> {
  const body = await response.text()
  return body.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as ChatEvent)
}

export function latestToolResult<T>(options: LanguageModelV4CallOptions, toolName: string): T {
  for (const message of [...options.prompt].reverse()) {
    if (message.role !== 'tool') continue
    for (const part of [...message.content].reverse()) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'json') return part.output.value as T
    }
  }
  throw new Error(`The real SDK prompt is missing a JSON result for ${toolName}`)
}
