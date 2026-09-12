import { createHmac, timingSafeEqual } from 'node:crypto'
import { BackendError } from './errors'

export const SESSION_COOKIE = 'wellio_session'
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export class SessionCookies {
  constructor(private key: Buffer) {}

  private signature(value: string): string { return createHmac('sha256', this.key).update(value).digest('base64url') }

  issue(sessionId: string, expiresAt: number, secure: boolean): string {
    const payload = `v1.${sessionId}.${Math.floor(expiresAt / 1000)}`
    return `${SESSION_COOKIE}=${payload}.${this.signature(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`
  }

  clear(secure: boolean): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`
  }

  read(request: Request): string | null {
    const matches = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`))
    if (matches.length === 0) return null
    if (matches.length !== 1) throw new BackendError('INVALID_SESSION', 401)
    const token = matches[0].slice(SESSION_COOKIE.length + 1)
    const match = /^(v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9]{10}))\.([A-Za-z0-9_-]{43})$/.exec(token)
    if (!match) throw new BackendError('INVALID_SESSION', 401)
    const expected = Buffer.from(this.signature(match[1]))
    const actual = Buffer.from(match[4])
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || Number(match[3]) * 1000 <= Date.now()) throw new BackendError('INVALID_SESSION', 401)
    return match[2]
  }
}
