import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod, symlink, unlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAttachmentStore, MAX_ATTACHMENT_BYTES, type AttachmentStore } from '../../src/server/attachments'

const makeImage = (format: 'jpeg' | 'png' | 'webp') => sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 20, g: 130, b: 75 } } }).toFormat(format).toBuffer()
const file = (bytes: Uint8Array, name = 'photo.png', type = 'image/png') => new File([Uint8Array.from(bytes)], name, { type })

describe('Stage 4 private attachment storage', () => {
  let directory: string
  let root: string
  let store: AttachmentStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wellio-attachments-test-'))
    root = join(directory, 'attachments')
    store = createAttachmentStore(root)
  })

  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it.each(['jpeg', 'png', 'webp'] as const)('decodes actual %s content and persists original bytes with private permissions', async format => {
    const bytes = await makeImage(format)
    const attachment = await store.upload('session-a', 2, file(bytes, '../../name.dat', 'application/octet-stream'), 'food')
    expect(attachment).toMatchObject({ name: 'name.dat', mediaType: `image/${format}`, purpose: 'food' })
    expect(attachment.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(attachment.url).toBe(`/api/attachments/${attachment.id}`)
    const read = await createAttachmentStore(root).read('session-a', 2, attachment.id)
    expect(read.attachment).toEqual(attachment)
    expect(Buffer.from(read.bytes)).toEqual(bytes)
    expect(read.mediaType).toBe(`image/${format}`)
    const paths = [root, join(root, 'session-a'), join(root, 'session-a', '2'), join(root, 'session-a', '2', attachment.id)]
    for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o700)
    for (const name of ['metadata.json', 'image.bin']) expect((await stat(join(paths[3], name))).mode & 0o777).toBe(0o600)
    expect(await readdir(join(root, 'session-a', '2'))).toEqual([attachment.id])
    expect(await readdir(paths[3])).toEqual(['image.bin', 'metadata.json'])
  })

  it('rejects MIME spoofing, header-only and truncated files before committing any attachment', async () => {
    const png = await makeImage('png')
    const jpeg = await makeImage('jpeg')
    const webp = await makeImage('webp')
    for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('not an image'), png.subarray(0, 8), jpeg.subarray(0, 3), webp.subarray(0, 12), png.subarray(0, Math.floor(png.length / 2)), jpeg.subarray(0, Math.floor(jpeg.length / 2)), webp.subarray(0, Math.floor(webp.length / 2))]) {
      await expect(store.upload('session-a', 1, file(bytes), 'food')).rejects.toMatchObject({ code: expect.stringMatching(/UNSUPPORTED_ATTACHMENT_FORMAT|INVALID_ATTACHMENT_CONTENT/) })
    }
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces the byte limit and validates purpose, namespace and opaque IDs', async () => {
    const png = await makeImage('png')
    await expect(store.upload('session-a', 1, file(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)), 'food')).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE', httpStatus: 413 })
    await expect(store.upload('session-a', 1, file(new Uint8Array()), 'food')).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_CONTENT' })
    await expect(store.upload('session-a', 1, file(png), 'profile' as 'food')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.upload('session-a', 1, 'https://example.com/photo.png' as unknown as File, 'food')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    for (const sessionId of ['../escape', 'a/b', 'a\\b', 'https://example.com', '']) {
      await expect(store.upload(sessionId, 1, file(png), 'food')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(store.reset(sessionId)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    for (const epoch of [0, -1, 1.5, undefined]) await expect(store.upload('session-a', epoch as number, file(png), 'food')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    for (const id of ['../metadata.json', '/etc/passwd', 'file:///etc/passwd', 'https://example.com/image', '/api/attachments/id', '']) await expect(store.read('session-a', 1, id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('isolates sessions and epochs, and reset deletes all epochs for only that session', async () => {
    const png = await makeImage('png')
    const first = await store.upload('session-a', 1, file(png), 'food')
    const later = await store.upload('session-a', 2, file(png), 'menu')
    const other = await store.upload('session-b', 1, file(png), 'food')
    await expect(store.read('session-b', 1, first.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await expect(store.read('session-a', 2, first.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    expect((await store.read('session-a', 2, later.id)).attachment.purpose).toBe('menu')
    await store.reset('session-a')
    for (const [epoch, id] of [[1, first.id], [2, later.id]] as const) await expect(store.read('session-a', epoch, id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    expect((await store.read('session-b', 1, other.id)).attachment).toEqual(other)
    await store.reset('session-a')
    const next = await store.upload('session-a', 3, file(png), 'food')
    expect((await store.read('session-a', 3, next.id)).attachment).toEqual(next)
  })

  it('serializes an in-flight upload before reset so no late attachment survives it', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    class DelayedFile extends File { override async arrayBuffer(): Promise<ArrayBuffer> { await barrier; return super.arrayBuffer() } }
    const png = await makeImage('png')
    const upload = store.upload('session-a', 1, new DelayedFile([Uint8Array.from(png)], 'photo.png', { type: 'image/png' }), 'food')
    const reset = store.reset('session-a')
    release()
    const attachment = await upload
    await reset
    await expect(store.read('session-a', 1, attachment.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await expect(readdir(join(root, 'session-a'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects corrupted bytes, altered metadata ownership and widened file permissions', async () => {
    const png = await makeImage('png')
    const attachment = await store.upload('session-a', 1, file(png), 'food')
    const path = join(root, 'session-a', '1', attachment.id)
    await writeFile(join(path, 'image.bin'), Buffer.from('corrupted'))
    await expect(store.read('session-a', 1, attachment.id)).rejects.toMatchObject({ code: 'ATTACHMENT_STORAGE_INVALID' })
    await writeFile(join(path, 'image.bin'), png)
    const metadata = JSON.parse(await readFile(join(path, 'metadata.json'), 'utf8'))
    await writeFile(join(path, 'metadata.json'), JSON.stringify({ ...metadata, sessionId: 'session-b' }))
    await expect(store.read('session-a', 1, attachment.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await writeFile(join(path, 'metadata.json'), JSON.stringify(metadata))
    await chmod(join(path, 'image.bin'), 0o644)
    await expect(store.read('session-a', 1, attachment.id)).rejects.toMatchObject({ code: 'ATTACHMENT_STORAGE_INVALID' })
  })

  it('does not follow file or namespace symlinks outside private storage', async () => {
    const png = await makeImage('png')
    const attachment = await store.upload('session-a', 1, file(png), 'food')
    const outside = join(directory, 'outside.bin')
    await writeFile(outside, png, { mode: 0o600 })
    const imagePath = join(root, 'session-a', '1', attachment.id, 'image.bin')
    await unlink(imagePath)
    await symlink(outside, imagePath)
    await expect(store.read('session-a', 1, attachment.id)).rejects.toMatchObject({ code: 'ATTACHMENT_STORAGE_INVALID' })
    const outsideDirectory = join(directory, 'outside-directory')
    await mkdir(outsideDirectory, { mode: 0o700 })
    await symlink(outsideDirectory, join(root, 'session-c'))
    await expect(store.upload('session-c', 1, file(png), 'food')).rejects.toMatchObject({ code: 'ATTACHMENT_STORAGE_INVALID' })
    await expect(store.reset('session-c')).rejects.toMatchObject({ code: 'ATTACHMENT_STORAGE_INVALID' })
    expect(await readdir(outsideDirectory)).toEqual([])
    expect(await readFile(outside)).toEqual(png)
  })
})
