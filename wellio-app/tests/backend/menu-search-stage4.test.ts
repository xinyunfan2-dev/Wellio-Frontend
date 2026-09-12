import { describe, expect, it, vi } from 'vitest'
import { MAX_MENU_MARKDOWN_CHARS, searchRestaurantMenu } from '../../src/server/menu-search'

const input = { restaurant: "McDonald's", city: 'Hong Kong' }
const configured = { endpoint: 'https://managed-connector.example/firecrawl/v2/search', token: 'test-managed-credential' }
const page = { url: 'https://restaurant.example/hk/menu', title: 'Hong Kong menu', description: 'Restaurant menu', markdown: '# Menu\nChicken burger — HK$40', metadata: { sourceURL: 'https://restaurant.example/hk/menu', statusCode: 200, language: 'en', channel: 'restaurant menu' } }
const response = (web: unknown[], extra = {}) => Response.json({ success: true, data: { web }, ...extra })

describe('Stage 4 single-request managed menu search', () => {
  it('uses one v2 search with markdown scraping and returns actual source evidence', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response([page, { ...page, url: 'https://restaurant.example/hk/menu-2' }, { ...page, url: 'https://restaurant.example/hk/menu-3' }, { ...page, url: 'https://restaurant.example/ignored-fourth-result' }], { id: 'provider-search-id', warning: 'Menu prices can vary by location.' }))
    const before = Date.now()
    const result = await searchRestaurantMenu({ ...input, branch: 'Central' }, { ...configured, fetch: fetchMock, signal: controller.signal })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(configured.endpoint)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-managed-credential' } })
    expect(JSON.parse(String(init?.body))).toEqual({ query: "McDonald's Hong Kong Central menu prices", sources: ['web'], limit: 3, scrapeOptions: { formats: ['markdown'] } })
    expect(result).toMatchObject({ provider: 'lovable_firecrawl', providerRequestId: 'provider-search-id', externalRequestCount: 1, query: "McDonald's Hong Kong Central menu prices", status: 'succeeded', warning: 'Menu prices can vary by location.' })
    expect(result.searchRequestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(Date.parse(result.retrievedAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(result.retrievedAt)).toBeLessThanOrEqual(Date.now())
    expect(result.results).toHaveLength(3)
    expect(result.results[0]).toEqual({ ...page, retrievedAt: result.retrievedAt, contentStatus: 'available', truncated: false, priceStatus: 'unknown' })
    expect(result.results[0]).not.toHaveProperty('price')
    expect(result.results[0]).not.toHaveProperty('budgetGuaranteed')
  })

  it('marks missing or failed page content and caps long evidence without inventing prices', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response([
      { url: page.url, title: 'Search summary only', description: 'A burger costs HK$40.' },
      { ...page, markdown: '# Access denied', metadata: { statusCode: 403, error: 'Forbidden', sourceURL: page.url } },
      { ...page, markdown: 'm'.repeat(MAX_MENU_MARKDOWN_CHARS + 100), metadata: { statusCode: '200', original: { source: 'provider' } } },
    ]))
    const result = await searchRestaurantMenu(input, { ...configured, fetch: fetchMock })
    expect(result.status).toBe('partial')
    expect(result.results[0]).toMatchObject({ contentStatus: 'missing', markdown: '', priceStatus: 'unknown' })
    expect(result.results[1]).toMatchObject({ contentStatus: 'failed', metadata: { statusCode: 403, error: 'Forbidden' } })
    expect(result.results[2]).toMatchObject({ contentStatus: 'available', truncated: true, metadata: { statusCode: '200', original: { source: 'provider' } } })
    expect(result.results[2].markdown).toHaveLength(MAX_MENU_MARKDOWN_CHARS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns not_found for no usable result URLs and never fetches a result page', async () => {
    for (const web of [[], [{ ...page, url: 'file:///etc/passwd' }, { ...page, url: 'javascript:alert(1)' }, { ...page, url: 'https://user:password@example.com/menu' }]]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(web))
      expect(await searchRestaurantMenu(input, { ...configured, fetch: fetchMock })).toMatchObject({ status: 'not_found', results: [], externalRequestCount: 1 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('requires explicit managed configuration and rejects provider or query injection', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    for (const options of [{}, { endpoint: configured.endpoint }, { token: configured.token }]) await expect(searchRestaurantMenu(input, { ...options, fetch: fetchMock })).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' })
    for (const endpoint of ['http://managed-connector.example/search', 'file:///search', 'https://api.firecrawl.dev/v2/search', 'https://user:password@managed-connector.example/search', `${configured.endpoint}#fragment`]) await expect(searchRestaurantMenu(input, { ...configured, endpoint, fetch: fetchMock })).rejects.toMatchObject({ code: 'SEARCH_CONFIGURATION_INVALID' })
    for (const candidate of [{ ...input, endpoint: 'https://other.example' }, { ...input, limit: 99 }, { ...input, query: 'SELECT *' }, { ...input, city: '' }, { ...input, restaurant: 'name\nheader' }]) await expect(searchRestaurantMenu(candidate, { ...configured, fetch: fetchMock })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([401, 429, 500])('does not retry a failed HTTP %s request', async status => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('upstream error with private diagnostic', { status }))
    await expect(searchRestaurantMenu(input, { ...configured, fetch: fetchMock })).rejects.toMatchObject({ code: status === 429 ? 'SEARCH_RATE_LIMITED' : 'SEARCH_FAILED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry network errors or expose the upstream diagnostic', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('private provider token appeared in a network diagnostic'))
    await expect(searchRestaurantMenu(input, { ...configured, fetch: fetchMock })).rejects.toMatchObject({ code: 'SEARCH_FAILED', message: 'SEARCH_FAILED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed, legacy-shaped and oversized responses without another request', async () => {
    for (const raw of [JSON.stringify({ success: true, data: [page] }), JSON.stringify({ success: false, error: 'provider failed' }), '{broken']) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(raw))
      await expect(searchRestaurantMenu(input, { ...configured, fetch: fetchMock })).rejects.toMatchObject({ code: 'SEARCH_INVALID_RESPONSE' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1)))
    await expect(searchRestaurantMenu(input, { ...configured, fetch: fetchMock })).rejects.toMatchObject({ code: 'SEARCH_RESPONSE_TOO_LARGE' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not send an already-aborted request and propagates in-flight cancellation', async () => {
    const before = new AbortController()
    before.abort()
    const unusedFetch = vi.fn<typeof fetch>()
    await expect(searchRestaurantMenu(input, { ...configured, fetch: unusedFetch, signal: before.signal })).rejects.toMatchObject({ code: 'SEARCH_ABORTED' })
    expect(unusedFetch).not.toHaveBeenCalled()

    const during = new AbortController()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')), { once: true })
    }))
    const result = searchRestaurantMenu(input, { ...configured, fetch: fetchMock, signal: during.signal })
    during.abort()
    await expect(result).rejects.toMatchObject({ code: 'SEARCH_ABORTED', httpStatus: 499 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels response-body reading when the caller aborts', async () => {
    const controller = new AbortController()
    let reading!: () => void
    const started = new Promise<void>(resolve => { reading = resolve })
    const canceled = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull() { reading(); return new Promise<void>(() => undefined) },
      cancel: canceled,
    })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    const result = searchRestaurantMenu(input, { ...configured, fetch: fetchMock, signal: controller.signal })
    await started
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'SEARCH_ABORTED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(canceled).toHaveBeenCalledTimes(1)
  })
})
