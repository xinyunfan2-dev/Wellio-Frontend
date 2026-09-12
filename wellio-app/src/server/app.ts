import { dirname, resolve } from 'node:path'
import type { ActionRequest } from '../lib/contracts'
import { executeAction } from './actions'
import { WellioDatabase } from './database'
import { BackendError } from './errors'
import { SCHEMA_VERSION } from './migrations'
import { SessionCookies, SESSION_MAX_AGE_SECONDS } from './session'
import { parseAction } from './validation'
import { createAgentRuntime } from './agent-runtime'
import { loadAgentConfiguration, loadMenuConfiguration, type AgentConfiguration, type MenuConfiguration } from './agent-config'
import { createAttachmentStore, MAX_ATTACHMENT_BYTES } from './attachments'
import { parseChat } from './chat-validation'

const MAX_BODY_BYTES = 16 * 1024
export interface BackendOptions { databasePath: string; cookieSecure?: boolean; agent?: AgentConfiguration; menuSearch?: MenuConfiguration; attachmentsPath?: string; now?: () => number }

function json(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders)
  headers.set('Cache-Control', 'no-store')
  headers.set('Vary', 'Cookie')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Wellio-Schema-Version', String(SCHEMA_VERSION))
  return Response.json(value, { status, headers })
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')
  if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin !== null && origin !== new URL(request.url).origin)) throw new BackendError('ORIGIN_NOT_ALLOWED', 403)
  if (origin === null && referer !== null) {
    try { if (new URL(referer).origin === new URL(request.url).origin) return } catch { /* invalid referrer */ }
    throw new BackendError('ORIGIN_NOT_ALLOWED', 403)
  }
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new BackendError('UNSUPPORTED_MEDIA_TYPE', 415)
  const size = request.headers.get('content-length')
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BODY_BYTES)) throw new BackendError('PAYLOAD_TOO_LARGE', 413)
  if (!request.body) throw new BackendError('INVALID_INPUT', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new BackendError('PAYLOAD_TOO_LARGE', 413) }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BackendError('INVALID_INPUT', 400) }
}

async function readAttachmentForm(request: Request): Promise<{ file: File; purpose: 'food' | 'menu' }> {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data;')) throw new BackendError('UNSUPPORTED_MEDIA_TYPE', 415)
  const limit = MAX_ATTACHMENT_BYTES + 64 * 1024
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new BackendError('PAYLOAD_TOO_LARGE', 413)
  if (!request.body) throw new BackendError('INVALID_INPUT', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) { await reader.cancel(); throw new BackendError('PAYLOAD_TOO_LARGE', 413) }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  let form: FormData
  try { form = await new Response(new Uint8Array(Buffer.concat(chunks)).buffer, { headers: { 'Content-Type': request.headers.get('content-type')! } }).formData() } catch { throw new BackendError('INVALID_INPUT', 400) }
  const file = form.get('file'), purpose = form.get('purpose')
  if (!(file instanceof File) || !['food', 'menu'].includes(String(purpose)) || [...form.keys()].length !== 2 || form.getAll('file').length !== 1 || form.getAll('purpose').length !== 1) throw new BackendError('INVALID_INPUT', 400)
  return { file, purpose: purpose as 'food' | 'menu' }
}

/** Transport factory is shared by file routes and isolated tests with real disk databases. */
export function createBackend(options: BackendOptions) {
  const database = new WellioDatabase(options.databasePath)
  const cookies = new SessionCookies(database.signingKey)
  const attachments = createAttachmentStore(options.attachmentsPath ?? resolve(dirname(options.databasePath), 'attachments'))
  const agent = createAgentRuntime({ db: database, agent: options.agent, menuSearch: options.menuSearch, attachments, now: options.now })
  return {
    close: () => { agent.close(); database.close() },
    async handleRequest(request: Request): Promise<Response> {
      let action: ActionRequest | undefined
      try {
        const url = new URL(request.url)
        const path = url.pathname
        const attachmentId = path.match(/^\/api\/attachments\/([A-Za-z0-9_-]{1,128})$/)?.[1]
        if (!['/api/state', '/api/actions', '/api/chat', '/api/attachments'].includes(path) && !attachmentId) throw new BackendError('NOT_FOUND', 404)
        const method = path === '/api/state' || attachmentId ? 'GET' : 'POST'
        if (request.method !== method) return json({ errorCode: 'METHOD_NOT_ALLOWED' }, 405, { Allow: method })
        assertSameOrigin(request)
        let sessionId = cookies.read(request)
        if (path === '/api/state') {
          if (sessionId) return json(agent.snapshot(sessionId))
          const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000
          const snapshot = database.createSession(expiresAt)
          sessionId = snapshot.sessionId
          return json(agent.snapshot(sessionId), 200, { 'Set-Cookie': cookies.issue(sessionId, expiresAt, options.cookieSecure ?? url.protocol === 'https:') })
        }
        if (!sessionId) throw new BackendError('SESSION_REQUIRED', 401)
        const current = database.getSnapshot(sessionId)
        if (attachmentId) {
          const stored = await attachments.read(sessionId, current.resetEpoch, attachmentId)
          return new Response(new Uint8Array(stored.bytes).buffer, { headers: { 'Content-Type': stored.mediaType, 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } })
        }
        if (path === '/api/attachments') {
          const { file, purpose } = await readAttachmentForm(request)
          const saved = await attachments.upload(sessionId, current.resetEpoch, file, purpose)
          if (database.getSnapshot(sessionId).resetEpoch !== current.resetEpoch) {
            await attachments.reset(sessionId, current.resetEpoch)
            throw new BackendError('STALE_EPOCH', 409)
          }
          return json(saved)
        }
        if (path === '/api/chat') {
          if (!agent.available) throw new BackendError('PROVIDER_NOT_CONFIGURED', 503)
          return await agent.chat(sessionId, parseChat(await readJson(request)), request.signal)
        }
        action = parseAction(await readJson(request))
        if (action.kind === 'request_proposal' && agent.available) {
          const reply = await agent.requestProposal(sessionId, action, request.signal)
          return json(reply.result, reply.httpStatus)
        }
        if (action.kind === 'check_readiness' && agent.available) return json({ requestId: action.requestId, resetEpoch: action.resetEpoch, status: 'failed', errorCode: 'USE_CHAT_READINESS_CHECK', snapshot: agent.snapshot(sessionId) }, 410)
        const reply = executeAction(database, sessionId, action)
        if (action.kind === 'reset_demo' && reply.result.status === 'succeeded') {
          // Safe on receipt replay and concurrent new-epoch work: only clean the epoch that was reset.
          agent.abortSession(sessionId, action.resetEpoch)
          await attachments.reset(sessionId, action.resetEpoch)
        }
        return json(reply.result, reply.httpStatus)
      } catch (error) {
        const known = error instanceof BackendError
        const errorCode = known ? error.code : 'INTERNAL_ERROR'
        const status = known ? error.httpStatus : 500
        // Do not expose SQL, local paths, credentials, payloads, or stack traces.
        if (!known) console.error('[wellio] Backend request failed')
        const url = new URL(request.url)
        const clearInvalidCookie = errorCode === 'INVALID_SESSION' && request.method === 'GET' && url.pathname === '/api/state'
        return json({ ...(action ? { requestId: action.requestId, resetEpoch: action.resetEpoch } : {}), status: status === 409 ? 'conflict' : 'failed', errorCode }, status,
          clearInvalidCookie ? { 'Set-Cookie': cookies.clear(options.cookieSecure ?? url.protocol === 'https:') } : undefined)
      }
    },
  }
}

let backend: ReturnType<typeof createBackend> | undefined
export async function handleBackendRequest(request: Request): Promise<Response> {
  try {
    backend ??= createBackend({
      databasePath: process.env.WELLIO_DATABASE_PATH || resolve(process.cwd(), '.data', 'wellio.sqlite'),
      cookieSecure: process.env.WELLIO_COOKIE_SECURE === undefined ? undefined : process.env.WELLIO_COOKIE_SECURE === '1',
      agent: loadAgentConfiguration(),
      menuSearch: loadMenuConfiguration(),
    })
    return await backend.handleRequest(request)
  } catch {
    console.error('[wellio] Persistent storage could not be initialized')
    return json({ status: 'failed', errorCode: 'STORAGE_UNAVAILABLE' }, 503)
  }
}
