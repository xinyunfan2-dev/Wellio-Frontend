import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Snapshot } from '../../src/lib/contracts'
import { WellioDatabase } from '../../src/server/database'
import { getGymEquipment, lookupEquipment } from '../../src/server/equipment'
import { calculateDailyTotals, getDayContext, queryHistory } from '../../src/server/read-services'

describe('authoritative equipment catalog', () => {
  it('contains only documented equipment and the exact machine-specific increments', () => {
    const a = getGymEquipment('gym-a')
    const b = getGymEquipment('gym-b')
    expect(a.equipment.map(entry => entry.equipmentId)).toEqual(['gym-a-dumbbells', 'gym-a-bench', 'gym-a-cable', 'gym-a-pullup-bar'])
    expect(b.equipment.map(entry => entry.equipmentId)).toEqual(['gym-b-dumbbells', 'gym-b-bench', 'gym-b-cable'])
    expect(lookupEquipment('gym-a-dumbbells')?.load).toEqual({ basis: 'per_hand', unit: 'kg', minKg: 5, maxKg: 30, stepKg: 2.5, allowedKg: [5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30] })
    expect(lookupEquipment('gym-b-dumbbells')?.load).toMatchObject({ maxKg: 25, stepKg: 2.5, allowedKg: [5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25] })
    expect(lookupEquipment('gym-a-cable')?.load).toMatchObject({ basis: 'machine_stack', minKg: 5, maxKg: 60, stepKg: 5, allowedKg: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] })
    expect(lookupEquipment('gym-b-cable')?.load).toMatchObject({ basis: 'machine_stack', maxKg: 50, stepKg: 5, allowedKg: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50] })
    expect(lookupEquipment('gym-a-pullup-bar')?.load).toEqual({ basis: 'bodyweight', allowsAdditionalLoad: false })
    expect(lookupEquipment('gym-a-bench')).not.toHaveProperty('load')
    expect(lookupEquipment('gym-b-bench')).not.toHaveProperty('load')
    expect(lookupEquipment('gym-b-pullup-bar')).toBeUndefined()
  })

  it('applies validated status overrides and isolates returned catalog copies', () => {
    const result = getGymEquipment('gym-b', { 'gym-b-cable': 'temporarily_occupied', 'gym-b-bench': 'unavailable' })
    expect(result.equipment.map(entry => entry.status)).toEqual(['available', 'unavailable', 'temporarily_occupied'])
    const cable = result.equipment.find(entry => entry.kind === 'cable')!
    if (cable.kind === 'cable') cable.load.allowedKg.push(999)
    expect(getGymEquipment('gym-b').equipment.every(entry => entry.status === 'available')).toBe(true)
    expect(lookupEquipment('gym-b-cable')?.load).toMatchObject({ maxKg: 50, allowedKg: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50] })
    expect(() => getGymEquipment('gym-c')).toThrow('GYM_NOT_FOUND')
    expect(() => getGymEquipment('gym-b', { 'gym-b-barbell': 'available' })).toThrow('INVALID_INPUT')
    expect(() => getGymEquipment('gym-b', { 'gym-b-cable': 'broken' })).toThrow('INVALID_INPUT')
  })
})

describe('read-only domain services', () => {
  let directory: string
  let database: WellioDatabase
  let snapshot: Snapshot

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wellio-reads-test-'))
    database = new WellioDatabase(join(directory, 'sessions.sqlite'))
    snapshot = database.createSession(Date.now() + 60_000)
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('captures the context and readiness used to compute current intake without changing the session', () => {
    const context = getDayContext(database, snapshot.sessionId, { runId: 'run-context', requestId: 'request-context', resetEpoch: snapshot.resetEpoch })
    expect(context.contextReadId).toBe(context.id)
    expect(context.snapshot).toEqual(snapshot)
    expect(context.readiness).toEqual(snapshot.readiness)
    expect(context).toMatchObject({ runId: 'run-context', requestId: 'request-context', resetEpoch: snapshot.resetEpoch, dayKey: '2026-09-12', readinessSnapshotId: snapshot.readiness.id })
    expect(context.versions).toEqual({ meal: 1, plan: 1, workout: 1, conditions: 1, readiness: 1 })
    expect(context.totals).toEqual({ consumed: { kcal: 1650, protein: 90, carbs: 210, fat: 50 }, remaining: { kcal: 750, protein: 50, carbs: 70, fat: 30 }, expenditure: 2500, energyDeficit: 850, mealCount: 2, estimated: true, intakeStatus: 'recorded_so_far' })
    expect(database.getSnapshot(snapshot.sessionId)).toEqual(snapshot)
  })

  it('rejects malformed context envelopes and lets storage reject stale epochs', () => {
    const input = { runId: 'run-context', requestId: 'request-context', resetEpoch: snapshot.resetEpoch }
    expect(() => getDayContext(database, snapshot.sessionId, { ...input, sql: 'SELECT *' })).toThrow('INVALID_INPUT')
    expect(() => getDayContext(database, snapshot.sessionId, { ...input, runId: 'run; DROP TABLE sessions' })).toThrow('INVALID_INPUT')
    expect(() => getDayContext(database, snapshot.sessionId, { ...input, resetEpoch: snapshot.resetEpoch + 1 })).toThrow('STALE_EPOCH')
  })

  it('uses saved fractions, preserves signed balances, and leaves missing intake unknown', () => {
    snapshot.meals[1].items[0].consumedFraction = 0.5
    expect(calculateDailyTotals(snapshot)).toMatchObject({ consumed: { kcal: 1125, protein: 60, carbs: 142.5, fat: 35 }, energyDeficit: 1375 })
    snapshot.meals[1].items[0].consumedFraction = 2
    expect(calculateDailyTotals(snapshot)).toMatchObject({ remaining: { kcal: -300 }, energyDeficit: -200 })
    snapshot.meals = []
    expect(calculateDailyTotals(snapshot)).toMatchObject({ consumed: null, remaining: null, energyDeficit: null, expenditure: 2500, intakeStatus: 'missing' })
  })

  it('computes the documented 14-day and 7-day weight, training and nutrition summaries', () => {
    for (const [from, changeKg, sessionCount, totalMinutes, energyDeficit] of [
      ['2026-08-29', 0.4, 7, 270, 2568],
      ['2026-09-05', 0.2, 3, 115, 999],
    ] as const) {
      const input = { from, to: '2026-09-11' }
      expect(queryHistory(database, snapshot.sessionId, { ...input, metric: 'weight' }).summary).toMatchObject({ latestKg: 70.4, changeKg })
      expect(queryHistory(database, snapshot.sessionId, { ...input, metric: 'training' }).summary).toMatchObject({ sessionCount, totalMinutes })
      expect(queryHistory(database, snapshot.sessionId, { ...input, metric: 'nutrition' }).summary).toMatchObject({ energyDeficit })
    }
    expect(database.getSnapshot(snapshot.sessionId)).toEqual(snapshot)
  })

  it('keeps exercise history on the requested machine and load basis', () => {
    const input = { metric: 'exercise_load', from: '2026-08-29', to: '2026-09-11', exerciseId: 'lat-pulldown' }
    const a = queryHistory(database, snapshot.sessionId, { ...input, equipmentId: 'gym-a-cable' })
    const b = queryHistory(database, snapshot.sessionId, { ...input, equipmentId: 'gym-b-cable' })
    expect(a.summary).toMatchObject({ recordCount: 1, latestKg: 45, changeKg: 0, equipmentId: 'gym-a-cable', basis: 'machine_stack' })
    expect(b.summary).toMatchObject({ recordCount: 3, latestKg: 40, changeKg: 5, equipmentId: 'gym-b-cable', basis: 'machine_stack' })
    if (b.metric === 'exercise_load') expect(b.data.every(record => record.equipmentId === 'gym-b-cable' && record.basis === 'machine_stack')).toBe(true)
    expect(() => queryHistory(database, snapshot.sessionId, { ...input, equipmentId: 'gym-b-bench' })).toThrow('EQUIPMENT_HAS_NO_LOAD')
    expect(() => queryHistory(database, snapshot.sessionId, { ...input, equipmentId: 'gym-b-barbell' })).toThrow('EQUIPMENT_NOT_FOUND')
  })

  it('filters incompatible basis records and does not expose mutable snapshot history', () => {
    snapshot.history.load.push({ id: 'bad-basis', date: '2026-09-11', exerciseId: 'lat-pulldown', name: { en: 'Lat pulldown', 'zh-CN': '高位下拉' }, equipmentId: 'gym-b-cable', kg: 999, basis: 'per_hand', source: 'mock_history' })
    const source = { getSnapshot: () => snapshot }
    const result = queryHistory(source, snapshot.sessionId, { metric: 'exercise_load', exerciseId: 'lat-pulldown', equipmentId: 'gym-b-cable', from: '2026-08-29', to: '2026-09-12' })
    expect(result.summary).toMatchObject({ recordCount: 3, latestKg: 40 })
    if (result.metric === 'exercise_load') result.data[0].name.en = 'Changed by caller'
    expect(snapshot.history.load.some(record => record.name.en === 'Changed by caller')).toBe(false)
  })

  it('returns empty data with unknown numeric values instead of fabricated records', () => {
    const input = { from: '2026-08-01', to: '2026-08-02' }
    expect(queryHistory(database, snapshot.sessionId, { ...input, metric: 'weight' })).toMatchObject({ data: [], summary: { recordCount: 0, latestKg: null, changeKg: null } })
    expect(queryHistory(database, snapshot.sessionId, { ...input, metric: 'nutrition' })).toMatchObject({ data: [], summary: { recordCount: 0, consumed: null, expenditure: null, energyDeficit: null, averageDaily: null } })
    expect(queryHistory(database, snapshot.sessionId, { ...input, metric: 'exercise_load', exerciseId: 'pullup', equipmentId: 'gym-a-pullup-bar' })).toMatchObject({ data: [], summary: { basis: 'bodyweight', latestKg: null, changeKg: null } })
  })

  it('strictly rejects SQL, unknown fields, invalid calendar dates, missing filters, and stale epochs', () => {
    const input = { metric: 'weight', from: '2026-09-01', to: '2026-09-11' }
    const invalidInputs = [
      'SELECT * FROM sessions',
      { ...input, sql: 'SELECT * FROM sessions' },
      { ...input, metric: 'sleep' },
      { ...input, from: '2026-9-01' },
      { ...input, from: '2026-02-30' },
      { ...input, to: '2026-09-11T00:00:00Z' },
      { ...input, exerciseId: 'lat-pulldown' },
      { ...input, metric: 'exercise_load', exerciseId: 'lat-pulldown' },
      { ...input, metric: 'exercise_load', exerciseId: 'lat-pulldown', equipmentId: 'gym-b-cable; DROP TABLE sessions' },
    ]
    for (const invalid of invalidInputs) expect(() => queryHistory(database, snapshot.sessionId, invalid)).toThrow('INVALID_INPUT')
    expect(() => queryHistory(database, snapshot.sessionId, { ...input, resetEpoch: snapshot.resetEpoch + 1 })).toThrow('STALE_EPOCH')
    expect(() => queryHistory(database, 'absent-session', input)).toThrow('INVALID_SESSION')
  })

  it('uses inclusive date boundaries, allows 31 days, and rejects future or reversed ranges', () => {
    expect(queryHistory(database, snapshot.sessionId, { metric: 'weight', from: '2026-08-13', to: '2026-09-12' }).data).toHaveLength(14)
    expect(queryHistory(database, snapshot.sessionId, { metric: 'weight', from: '2026-09-11', to: '2026-09-11' }).data).toEqual([{ date: '2026-09-11', kg: 70.4 }])
    for (const [from, to] of [['2026-08-12', '2026-09-12'], ['2026-09-12', '2026-09-13'], ['2026-09-12', '2026-09-11']]) {
      expect(() => queryHistory(database, snapshot.sessionId, { metric: 'weight', from, to })).toThrow('INVALID_DATE_RANGE')
    }
  })
})
