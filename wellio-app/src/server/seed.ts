import { randomUUID } from 'node:crypto'
import type { Locale, Scenario, Snapshot } from '../lib/contracts'
import { createFixture } from '../lib/fixtures'
import { SCHEMA_VERSION } from './migrations'

export const SEED_SOURCE = 'demo_fixture_v1'
export const DEMO_DAY_KEY = '2026-09-12'
export const DEMO_TIME_ZONE = 'Asia/Hong_Kong'

/** Initial Pull is a documented demo preset, never an AI-generated proposal. */
export function createSeed(sessionId: string, scenario: Scenario = 'normal', locale: Locale = 'en'): Snapshot {
  const snapshot = createFixture(scenario)
  snapshot.schemaVersion = SCHEMA_VERSION
  snapshot.sessionId = sessionId
  snapshot.conversationId = randomUUID()
  snapshot.locale = locale
  snapshot.dayKey = DEMO_DAY_KEY
  snapshot.timeZone = DEMO_TIME_ZONE
  snapshot.capabilities = { agent: false, menuSearch: false, persistence: 'server' }
  snapshot.readiness.id = scenario === 'normal' ? 'readiness-normal-0912' : 'readiness-low-0912'
  if (snapshot.sleep) snapshot.sleep.id = scenario === 'normal' ? 'sleep-normal-0912' : 'sleep-low-0912'
  snapshot.readiness.sleepRecordId = snapshot.sleep?.id
  snapshot.readiness.reasons = scenario === 'normal' ? ['sleep_near_baseline', 'resting_hr_near_baseline'] : ['sleep_below_baseline', 'resting_hr_above_baseline']
  if (snapshot.workout) snapshot.workout.source = 'demo_preset'

  // DEMO_DATA §5 stable history IDs must resolve from every preset suggestedLoad.
  // §6 trend points keep their dates/values; overlapping §5 points are deduplicated.
  for (const record of snapshot.history.load) {
    if (record.date === '2026-09-10' && record.exerciseId === 'seated-cable-row') record.id = 'load-b-0910-cable-row'
    if (record.date === '2026-09-10' && record.exerciseId === 'lat-pulldown') record.id = 'load-b-0910-pulldown'
  }
  snapshot.history.load.push(
    { id: 'load-a-0902-row', date: '2026-09-02', exerciseId: 'one-arm-dumbbell-row', name: { en: 'One-arm dumbbell row', 'zh-CN': '单臂哑铃划船' }, equipmentId: 'gym-a-dumbbells', kg: 22.5, basis: 'per_hand', source: 'mock_history' },
    { id: 'load-a-0902-pulldown', date: '2026-09-02', exerciseId: 'lat-pulldown', name: { en: 'Lat pulldown', 'zh-CN': '高位下拉' }, equipmentId: 'gym-a-cable', kg: 45, basis: 'machine_stack', source: 'mock_history' },
    { id: 'load-b-0910-row', date: '2026-09-10', exerciseId: 'one-arm-dumbbell-row', name: { en: 'One-arm dumbbell row', 'zh-CN': '单臂哑铃划船' }, equipmentId: 'gym-b-dumbbells', kg: 20, basis: 'per_hand', source: 'mock_history' },
    { id: 'load-b-0910-curl', date: '2026-09-10', exerciseId: 'dumbbell-curl', name: { en: 'Dumbbell curl', 'zh-CN': '哑铃弯举' }, equipmentId: 'gym-b-dumbbells', kg: 10, basis: 'per_hand', source: 'mock_history' },
  )
  snapshot.history.load.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  for (const record of snapshot.history.load) {
    if (record.id.startsWith('load-')) {
      record.sets = 3
      record.reps = record.exerciseId === 'one-arm-dumbbell-row' || record.exerciseId === 'dumbbell-curl' ? 10 : 12
    }
    if (record.date === '2026-09-10' && record.exerciseId === 'lateral-raise') { record.sets = 2; record.reps = 15 }
  }
  return snapshot
}
