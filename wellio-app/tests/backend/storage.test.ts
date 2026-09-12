import {mkdtempSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {ActionRequest, ContextVersions, Snapshot} from '../../src/lib/contracts'
import {assertContextVersions, contextVersions, WellioDatabase} from '../../src/server/database'
import type {MutationOutcome} from '../../src/server/database'
import {SCHEMA_VERSION} from '../../src/server/migrations'

describe('SQLite mutation and migration boundaries', () => {
  let directory: string
  let databasePath: string
  let database: WellioDatabase
  let snapshot: Snapshot
  let request: ActionRequest
  const opened = new Set<WellioDatabase>()

  function open() {
    const instance = new WellioDatabase(databasePath)
    opened.add(instance)
    return instance
  }

  function close(instance: WellioDatabase) {
    instance.close()
    opened.delete(instance)
  }

  function inspect<T>(run: (connection: DatabaseSync) => T): T {
    const connection = new DatabaseSync(databasePath)
    try { return run(connection) } finally { connection.close() }
  }

  function saveLocale(current: Snapshot): MutationOutcome {
    current.locale = 'zh-CN'
    current.revision += 1
    return {httpStatus: 200, result: {requestId: request.requestId, status: 'succeeded'}, snapshot: current}
  }

  function requestCount(): number {
    return inspect(connection => Number(connection.prepare('SELECT COUNT(*) AS count FROM action_requests').get()?.count))
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-storage-test-'))
    databasePath = join(directory, 'sessions.sqlite')
    database = open()
    snapshot = database.createSession(Date.now() + 60_000)
    request = {kind: 'set_locale', locale: 'zh-CN', requestId: 'mutation-request', resetEpoch: snapshot.resetEpoch, source: 'profile'}
  })

  afterEach(() => {
    for (const instance of opened) instance.close()
    opened.clear()
    rmSync(directory, {recursive: true, force: true})
  })

  it('rolls back a callback failure and permits retry with the same request ID', () => {
    const failure = new Error('service rejected the staged change')
    expect(() => database.mutate(snapshot.sessionId, request, current => {
      current.locale = 'zh-CN'
      current.meals[0].items[0].consumedFraction = 0.5
      current.revision += 1
      throw failure
    })).toThrow(failure)
    expect(database.getSnapshot(snapshot.sessionId)).toEqual(snapshot)
    expect(requestCount()).toBe(0)

    const retried = database.mutate(snapshot.sessionId, request, saveLocale)
    expect(retried.result.snapshot?.locale).toBe('zh-CN')
    expect(retried.result.snapshot?.revision).toBe(snapshot.revision + 1)
    expect(requestCount()).toBe(1)
  })

  it('rolls back the state UPDATE when persisting its request receipt fails', () => {
    // The trigger fails the second SQL write, after the session UPDATE has run.
    inspect(connection => connection.exec(`CREATE TRIGGER reject_request_receipt BEFORE INSERT ON action_requests
      BEGIN SELECT RAISE(ABORT, 'forced receipt write failure'); END;`))
    expect(() => database.mutate(snapshot.sessionId, request, saveLocale)).toThrow('forced receipt write failure')
    close(database)
    database = open()
    expect(database.getSnapshot(snapshot.sessionId)).toEqual(snapshot)
    expect(requestCount()).toBe(0)
    inspect(connection => connection.exec('DROP TRIGGER reject_request_receipt'))

    const retried = database.mutate(snapshot.sessionId, request, saveLocale)
    expect(database.getSnapshot(snapshot.sessionId)).toEqual(retried.result.snapshot)
    expect(requestCount()).toBe(1)
  })

  it('rejects asynchronous mutation callbacks without reserving a request or writing later', async () => {
    const callback = async (current: Snapshot): Promise<MutationOutcome> => {
      current.locale = 'zh-CN'
      await Promise.resolve()
      current.revision += 1
      return {httpStatus: 200, result: {requestId: request.requestId, status: 'succeeded'}, snapshot: current}
    }
    expect(() => database.mutate(snapshot.sessionId, request, callback as unknown as Parameters<WellioDatabase['mutate']>[2])).toThrow('ASYNC_MUTATION_NOT_ALLOWED')
    await Promise.resolve()
    expect(database.getSnapshot(snapshot.sessionId)).toEqual(snapshot)
    expect(requestCount()).toBe(0)
    expect(database.mutate(snapshot.sessionId, request, saveLocale).result.status).toBe('succeeded')
  })

  it('rejects callbacks that change session identity or skip the required version increment', () => {
    for (const changes of [
      {sessionId: 'another-session'}, {resetEpoch: snapshot.resetEpoch + 1}, {revision: snapshot.revision}, {revision: snapshot.revision + 2},
    ]) {
      expect(() => database.mutate(snapshot.sessionId, request, current => {
        const outcome = saveLocale(current)
        Object.assign(outcome.snapshot!, changes)
        return outcome
      })).toThrow('INVALID_MUTATION_VERSION')
      expect(database.getSnapshot(snapshot.sessionId)).toEqual(snapshot)
      expect(requestCount()).toBe(0)
    }
  })

  it('accepts matching partial contexts and rejects stale versions in every context dimension', () => {
    const expected = contextVersions(snapshot)
    expect(() => assertContextVersions(snapshot, expected)).not.toThrow()
    expect(() => assertContextVersions(snapshot, {meal: snapshot.mealRevision})).not.toThrow()
    for (const key of ['meal', 'plan', 'workout', 'conditions', 'readiness'] as (keyof ContextVersions)[]) {
      expect(() => assertContextVersions(snapshot, {...expected, [key]: expected[key] + 1})).toThrow('VERSION_CONFLICT')
    }
    const noWorkout = {...snapshot, workout: null}
    expect(() => assertContextVersions(noWorkout, {workout: 0})).not.toThrow()
    expect(() => assertContextVersions(noWorkout, {workout: expected.workout})).toThrow('VERSION_CONFLICT')
  })

  it('rejects a stale context inside the transaction without changing state or consuming its request ID', () => {
    const previousContext = contextVersions(snapshot)
    const mealRequest = {...request, requestId: 'earlier-meal-edit'}
    const changed = database.mutate(snapshot.sessionId, mealRequest, current => {
      current.mealRevision += 1
      current.meals[0].version += 1
      current.meals[0].items[0].consumedFraction = 0.5
      current.revision += 1
      return {httpStatus: 200, result: {requestId: mealRequest.requestId, status: 'succeeded'}, snapshot: current}
    })
    expect(() => database.mutate(snapshot.sessionId, request, current => {
      assertContextVersions(current, previousContext)
      return saveLocale(current)
    })).toThrow('VERSION_CONFLICT')
    expect(database.getSnapshot(snapshot.sessionId)).toEqual(changed.result.snapshot)
    expect(requestCount()).toBe(1)

    const freshContext = contextVersions(changed.result.snapshot!)
    const retried = database.mutate(snapshot.sessionId, request, current => {
      assertContextVersions(current, freshContext)
      return saveLocale(current)
    })
    expect(retried.result.status).toBe('succeeded')
    expect(retried.result.snapshot?.meals).toEqual(changed.result.snapshot?.meals)
    expect(requestCount()).toBe(2)
  })

  it('preserves an existing database when its schema is newer than this application', () => {
    close(database)
    inspect(connection => connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`))
    expect(() => open()).toThrow('DATABASE_SCHEMA_TOO_NEW')
    expect(inspect(connection => connection.prepare('PRAGMA user_version').get()?.user_version)).toBe(SCHEMA_VERSION + 1)
    const stored = inspect(connection => connection.prepare('SELECT snapshot_json FROM sessions WHERE id = ?').get(snapshot.sessionId)?.snapshot_json)
    expect(JSON.parse(String(stored))).toEqual(snapshot)
  })

  it('refuses an unsupported snapshot schema and inconsistent persisted identity versions', () => {
    inspect(connection => connection.prepare('UPDATE sessions SET schema_version = ? WHERE id = ?').run(SCHEMA_VERSION + 1, snapshot.sessionId))
    expect(() => database.getSnapshot(snapshot.sessionId)).toThrow('SNAPSHOT_SCHEMA_UNSUPPORTED')
    inspect(connection => connection.prepare('UPDATE sessions SET schema_version = ?, revision = revision + 1 WHERE id = ?').run(SCHEMA_VERSION, snapshot.sessionId))
    expect(() => database.getSnapshot(snapshot.sessionId)).toThrow('CORRUPT_SESSION_STATE')
  })

  it('rejects a forged JSON schema version even when the database and row schemas match', () => {
    inspect(connection => connection.prepare('UPDATE sessions SET snapshot_json = ? WHERE id = ?').run(
      JSON.stringify({...snapshot, schemaVersion: SCHEMA_VERSION + 1}), snapshot.sessionId,
    ))
    expect(inspect(connection => connection.prepare('PRAGMA user_version').get()?.user_version)).toBe(SCHEMA_VERSION)
    expect(inspect(connection => connection.prepare('SELECT schema_version FROM sessions WHERE id = ?').get(snapshot.sessionId)?.schema_version)).toBe(SCHEMA_VERSION)
    expect(() => database.getSnapshot(snapshot.sessionId)).toThrow('CORRUPT_SESSION_STATE')
  })

  it('refuses expired or absent database sessions', () => {
    const expired = database.createSession(Date.now() - 1)
    expect(() => database.getSnapshot(expired.sessionId)).toThrow('INVALID_SESSION')
    expect(() => database.getSnapshot('absent-session')).toThrow('INVALID_SESSION')
    expect(() => database.mutate(expired.sessionId, request, saveLocale)).toThrow('INVALID_SESSION')
    expect(requestCount()).toBe(0)
  })

  it('uses a private persistent file and retains its signing key on reopen', () => {
    const signingKey = Buffer.from(database.signingKey)
    expect(statSync(databasePath).mode & 0o777).toBe(0o600)
    expect(signingKey.byteLength).toBe(32)
    close(database)
    database = open()
    expect(database.signingKey.equals(signingKey)).toBe(true)
    expect(database.getSnapshot(snapshot.sessionId)).toEqual(snapshot)
    for (const invalid of ['', ':memory:', 'file:temporary']) {
      expect(() => new WellioDatabase(invalid)).toThrow('PERSISTENT_DATABASE_PATH_REQUIRED')
    }
  })
})
