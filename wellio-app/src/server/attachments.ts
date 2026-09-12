import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import type { Attachment } from '../lib/contracts'
import { BackendError } from './errors'

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENT_PIXELS = 40_000_000
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const attachmentIdSchema = z.uuid()
const epochSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const purposeSchema = z.enum(['food', 'menu'])
const mediaTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp'])
const metadataSchema = z.strictObject({
  sessionId: idSchema,
  resetEpoch: epochSchema,
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  attachment: z.strictObject({ id: attachmentIdSchema, url: z.string(), name: z.string().min(1).max(200), mediaType: mediaTypeSchema, purpose: purposeSchema }),
})

export interface AttachmentStore {
  upload(sessionId: string, epoch: number, file: File, purpose: 'food' | 'menu'): Promise<Attachment>
  read(sessionId: string, epoch: number, id: string): Promise<{ attachment: Attachment; bytes: Uint8Array; mediaType: string }>
  reset(sessionId: string, throughEpoch?: number): Promise<void>
}

function validateSession(sessionId: string): void {
  if (!idSchema.safeParse(sessionId).success) throw new BackendError('INVALID_INPUT', 400)
}

function signatureType(bytes: Buffer): 'jpeg' | 'png' | 'webp' | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return undefined
}

async function validateImage(bytes: Buffer): Promise<string> {
  const expected = signatureType(bytes)
  if (!expected) throw new BackendError('UNSUPPORTED_ATTACHMENT_FORMAT', 415)
  try {
    const options = { failOn: 'warning' as const, animated: true, limitInputPixels: MAX_ATTACHMENT_PIXELS }
    const metadata = await sharp(bytes, options).metadata()
    if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_ATTACHMENT_PIXELS) throw new Error('invalid dimensions or format')
    // Force complete pixel decoding; a valid header alone does not establish a valid image.
    await sharp(bytes, options).raw().toBuffer()
    return `image/${expected}`
  } catch { throw new BackendError('INVALID_ATTACHMENT_CONTENT', 400) }
}

async function privateDirectory(path: string, create = false, recursive = false): Promise<void> {
  if (create) {
    try { await mkdir(path, { recursive, mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BackendError('ATTACHMENT_STORAGE_INVALID', 500)
  if (create) await chmod(path, 0o700)
  else if ((stat.mode & 0o777) !== 0o700) throw new BackendError('ATTACHMENT_STORAGE_INVALID', 500)
}

async function writePrivateFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.chmod(0o600); await handle.sync() } finally { await handle.close() }
}

async function readPrivateFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maximum) throw new BackendError('ATTACHMENT_STORAGE_INVALID', 500)
    const bytes = await handle.readFile()
    if (bytes.length > maximum) throw new BackendError('ATTACHMENT_STORAGE_INVALID', 500)
    return bytes
  } finally { await handle.close() }
}

/** Files are private and grouped by the authenticated session and reset epoch. */
export function createAttachmentStore(basePath: string): AttachmentStore {
  if (typeof basePath !== 'string' || !basePath.trim() || /\u0000|:\/\//.test(basePath)) throw new BackendError('ATTACHMENT_STORAGE_INVALID', 500)
  const root = resolve(basePath)
  const pending = new Map<string, Promise<void>>()
  function serialized<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const work = (pending.get(sessionId) ?? Promise.resolve()).then(task)
    const tail = work.then(() => undefined, () => undefined)
    pending.set(sessionId, tail)
    void tail.then(() => { if (pending.get(sessionId) === tail) pending.delete(sessionId) })
    return work
  }

  return {
    async upload(sessionId, epoch, file, purpose) {
      validateSession(sessionId)
      if (!epochSchema.safeParse(epoch).success || !(file instanceof File) || !purposeSchema.safeParse(purpose).success) throw new BackendError('INVALID_INPUT', 400)
      if (file.size > MAX_ATTACHMENT_BYTES) throw new BackendError('ATTACHMENT_TOO_LARGE', 413)
      if (!file.size) throw new BackendError('INVALID_ATTACHMENT_CONTENT', 400)
      return serialized(sessionId, async () => {
        const bytes = Buffer.from(await file.arrayBuffer())
        if (bytes.length > MAX_ATTACHMENT_BYTES) throw new BackendError('ATTACHMENT_TOO_LARGE', 413)
        if (!bytes.length) throw new BackendError('INVALID_ATTACHMENT_CONTENT', 400)
        const mediaType = await validateImage(bytes)
        const id = randomUUID()
        const suppliedName = file.name.replace(/\\/g, '/').split('/').at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
        const attachment: Attachment = { id, url: `/api/attachments/${id}`, name: suppliedName || `image.${mediaType.slice(6)}`, mediaType, purpose }
        const sessionPath = join(root, sessionId)
        const epochPath = join(sessionPath, String(epoch))
        await privateDirectory(root, true, true)
        await privateDirectory(sessionPath, true)
        await privateDirectory(epochPath, true)
        const staging = join(epochPath, `.pending-${id}`)
        await privateDirectory(staging, true)
        try {
          await writePrivateFile(join(staging, 'image.bin'), bytes)
          await writePrivateFile(join(staging, 'metadata.json'), JSON.stringify({ sessionId, resetEpoch: epoch, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), attachment }))
          // Rename the complete private directory as the single visibility/commit point.
          await rename(staging, join(epochPath, id))
        } finally { await rm(staging, { recursive: true, force: true }) }
        return attachment
      })
    },

    async read(sessionId, epoch, id) {
      validateSession(sessionId)
      if (!epochSchema.safeParse(epoch).success || !attachmentIdSchema.safeParse(id).success) throw new BackendError('INVALID_INPUT', 400)
      return serialized(sessionId, async () => {
        try {
          const sessionPath = join(root, sessionId)
          const epochPath = join(sessionPath, String(epoch))
          const directory = join(epochPath, id)
          for (const path of [root, sessionPath, epochPath, directory]) await privateDirectory(path)
          const raw = await readPrivateFile(join(directory, 'metadata.json'), 16 * 1024)
          let metadata: z.infer<typeof metadataSchema>
          try { metadata = metadataSchema.parse(JSON.parse(raw.toString('utf8'))) } catch { throw new BackendError('ATTACHMENT_STORAGE_INVALID', 500) }
          if (metadata.sessionId !== sessionId || metadata.resetEpoch !== epoch || metadata.attachment.id !== id || metadata.attachment.url !== `/api/attachments/${id}`) throw new BackendError('ATTACHMENT_NOT_FOUND', 404)
          const bytes = await readPrivateFile(join(directory, 'image.bin'), MAX_ATTACHMENT_BYTES)
          if (bytes.length !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new BackendError('ATTACHMENT_STORAGE_INVALID', 500)
          return { attachment: metadata.attachment, bytes, mediaType: metadata.attachment.mediaType }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BackendError('ATTACHMENT_NOT_FOUND', 404)
          if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new BackendError('ATTACHMENT_STORAGE_INVALID', 500)
          throw error
        }
      })
    },

    async reset(sessionId, throughEpoch) {
      validateSession(sessionId)
      if (throughEpoch !== undefined && !epochSchema.safeParse(throughEpoch).success) throw new BackendError('INVALID_INPUT', 400)
      return serialized(sessionId, async () => {
        try { await privateDirectory(root); await privateDirectory(join(root, sessionId)) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        if (throughEpoch === undefined) await rm(join(root, sessionId), { recursive: true, force: true })
        else for (const name of await readdir(join(root, sessionId))) {
          if (/^[1-9]\d*$/.test(name) && Number(name) <= throughEpoch) await rm(join(root, sessionId, name), { recursive: true, force: true })
        }
      })
    },
  }
}
