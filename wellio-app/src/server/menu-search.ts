import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BackendError } from './errors'

export const MAX_MENU_RESULTS = 3
export const MAX_MENU_MARKDOWN_CHARS = 20_000
const MAX_RESPONSE_BYTES = 512 * 1024
const inputText = z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
export const menuSearchInputSchema = z.strictObject({ restaurant: inputText, city: inputText, branch: inputText.optional() })
export type MenuSearchInput = z.infer<typeof menuSearchInputSchema>
export interface MenuSearchOptions { endpoint?: string; token?: string; fetch?: typeof globalThis.fetch; signal?: AbortSignal }
export interface MenuSearchPage {
  url: string
  title: string
  description?: string
  markdown: string
  metadata: Record<string, unknown>
  retrievedAt: string
  contentStatus: 'available' | 'missing' | 'failed'
  truncated: boolean
  /** This adapter returns evidence, and does not infer numeric prices from it. */
  priceStatus: 'unknown'
}
export interface MenuSearchResult {
  searchRequestId: string
  providerRequestId?: string
  provider: 'lovable_firecrawl'
  externalRequestCount: 1
  query: string
  retrievedAt: string
  status: 'succeeded' | 'partial' | 'not_found'
  results: MenuSearchPage[]
  warning?: string
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

const pageSchema = z.object({
  url: z.string().max(2048).refine(httpUrl),
  title: z.string(),
  description: z.string().optional(),
  markdown: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
const responseSchema = z.object({ success: z.literal(true), data: z.object({ web: z.array(z.unknown()) }), id: z.string().optional(), warning: z.string().optional() })

export function isMenuSearchConfigured(options: MenuSearchOptions): boolean {
  if (!options.endpoint || !options.token?.trim() || /[\r\n]/.test(options.token)) return false
  try {
    const endpoint = new URL(options.endpoint)
    return endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.hash && endpoint.hostname !== 'api.firecrawl.dev'
  } catch { return false }
}

async function readResponse(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (!response.body) throw new BackendError('SEARCH_INVALID_RESPONSE', 502)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      if (signal?.aborted) throw new BackendError('SEARCH_ABORTED', 499)
      const chunk = await reader.read()
      if (signal?.aborted) throw new BackendError('SEARCH_ABORTED', 499)
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new BackendError('SEARCH_RESPONSE_TOO_LARGE', 502) }
      chunks.push(chunk.value)
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BackendError('SEARCH_INVALID_RESPONSE', 502) }
}

/** One managed-connector request, with no retries, redirects or per-page fetches. */
export async function searchRestaurantMenu(input: unknown, options: MenuSearchOptions = {}): Promise<MenuSearchResult> {
  const parsed = menuSearchInputSchema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  if (!options.endpoint || !options.token) throw new BackendError('SEARCH_NOT_CONFIGURED', 503)
  if (!isMenuSearchConfigured(options)) throw new BackendError('SEARCH_CONFIGURATION_INVALID', 503)
  const endpoint = new URL(options.endpoint)
  if (options.signal?.aborted) throw new BackendError('SEARCH_ABORTED', 499)

  const query = [parsed.data.restaurant, parsed.data.city, parsed.data.branch, 'menu prices'].filter(Boolean).join(' ')
  let raw: unknown
  try {
    const response = await (options.fetch ?? globalThis.fetch)(endpoint.href, {
      method: 'POST', redirect: 'error', signal: options.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ query, sources: ['web'], limit: MAX_MENU_RESULTS, scrapeOptions: { formats: ['markdown'] } }),
    })
    if (options.signal?.aborted) throw new BackendError('SEARCH_ABORTED', 499)
    if (!response.ok) {
      await response.body?.cancel()
      throw new BackendError(response.status === 429 ? 'SEARCH_RATE_LIMITED' : 'SEARCH_FAILED', response.status === 429 ? 503 : 502)
    }
    raw = await readResponse(response, options.signal)
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new BackendError('SEARCH_ABORTED', 499)
    if (error instanceof BackendError) throw error
    throw new BackendError('SEARCH_FAILED', 502)
  }
  const response = responseSchema.safeParse(raw)
  if (!response.success) throw new BackendError('SEARCH_INVALID_RESPONSE', 502)
  const retrievedAt = new Date().toISOString()
  const results: MenuSearchPage[] = []
  let rejected = false
  for (const candidate of response.data.data.web.slice(0, MAX_MENU_RESULTS)) {
    const page = pageSchema.safeParse(candidate)
    if (!page.success) { rejected = true; continue }
    const metadata = page.data.metadata ?? {}
    const original = page.data.markdown?.trim() ?? ''
    const statusCode = typeof metadata.statusCode === 'number' ? metadata.statusCode : typeof metadata.statusCode === 'string' && /^\d+$/.test(metadata.statusCode) ? Number(metadata.statusCode) : undefined
    const failed = !!metadata.error || (statusCode !== undefined && (statusCode < 200 || statusCode >= 400))
    results.push({
      url: page.data.url, title: page.data.title.slice(0, 500),
      ...(page.data.description ? { description: page.data.description.slice(0, 2000) } : {}),
      markdown: original.slice(0, MAX_MENU_MARKDOWN_CHARS), metadata, retrievedAt,
      contentStatus: failed ? 'failed' : original ? 'available' : 'missing',
      truncated: original.length > MAX_MENU_MARKDOWN_CHARS || page.data.title.length > 500 || (page.data.description?.length ?? 0) > 2000,
      priceStatus: 'unknown',
    })
  }
  return {
    searchRequestId: randomUUID(),
    ...(response.data.id ? { providerRequestId: response.data.id.slice(0, 200) } : {}),
    provider: 'lovable_firecrawl', externalRequestCount: 1, query, retrievedAt,
    status: results.length === 0 ? 'not_found' : rejected || results.some(page => page.contentStatus !== 'available' || page.truncated) ? 'partial' : 'succeeded',
    results,
    ...(response.data.warning ? { warning: response.data.warning.slice(0, 2000) } : {}),
  }
}
