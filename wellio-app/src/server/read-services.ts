import { z } from 'zod'
import type { DailyNutritionTotals, History, LoadBasis, Meal, MealNutritionTotals, Nutrients, Readiness, Snapshot } from '../lib/contracts'
import type { ContextRead, WellioDatabase } from './database'
import { lookupEquipment } from './equipment'
import { BackendError } from './errors'

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
const epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const isoDate = z.iso.date()
const range = { from: isoDate, to: isoDate, resetEpoch: epoch.optional() }
export const dayContextInputSchema = z.strictObject({ runId: id, requestId: id, resetEpoch: epoch })
export const historyQuerySchema = z.discriminatedUnion('metric', [
  z.strictObject({ metric: z.literal('weight'), ...range }),
  z.strictObject({ metric: z.literal('training'), ...range }),
  z.strictObject({ metric: z.literal('nutrition'), ...range }),
  z.strictObject({ metric: z.literal('exercise_load'), ...range, exerciseId: id, equipmentId: id }),
])
export type DayContextInput = z.infer<typeof dayContextInputSchema>
export type HistoryQuery = z.infer<typeof historyQuerySchema>
export type DailyTotals = DailyNutritionTotals
export type DayContext = ContextRead & { contextReadId: string; readiness: Readiness; totals: DailyTotals }

const nutrientKeys = ['kcal', 'protein', 'carbs', 'fat'] as const
const zeroNutrients = (): Nutrients => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 })
const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
function mapNutrients(calculate: (key: keyof Nutrients) => number): Nutrients {
  return Object.fromEntries(nutrientKeys.map(key => [key, round(calculate(key))])) as unknown as Nutrients
}

export function calculateMealTotals(meal: Meal): MealNutritionTotals {
  const items = meal.items.map(item => ({ mealItemId: item.id, total: mapNutrients(key => item.base[key] * item.consumedFraction) }))
  return { mealId: meal.id, total: mapNutrients(key => meal.items.reduce((sum, item) => sum + item.base[key] * item.consumedFraction, 0)), items }
}

/** Recorded intake is partial throughout the day; no meals is missing intake, not zero. */
export function calculateDailyTotals(snapshot: Snapshot): DailyTotals {
  const items = snapshot.meals.flatMap(meal => meal.items)
  const consumed = items.length ? mapNutrients(key => items.reduce((sum, item) => sum + item.base[key] * item.consumedFraction, 0)) : null
  return {
    consumed,
    remaining: consumed ? mapNutrients(key => snapshot.profile.targets[key] - consumed[key]) : null,
    expenditure: snapshot.profile.expenditure,
    energyDeficit: consumed ? round(snapshot.profile.expenditure - consumed.kcal) : null,
    mealCount: snapshot.meals.length,
    estimated: items.some(item => item.estimated),
    intakeStatus: consumed ? 'recorded_so_far' : 'missing',
  }
}

export function getDayContext(database: Pick<WellioDatabase, 'captureContext'>, sessionId: string, input: unknown): DayContext {
  const parsed = dayContextInputSchema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  const context = database.captureContext(sessionId, parsed.data)
  return { ...context, contextReadId: context.id, readiness: context.snapshot.readiness, totals: calculateDailyTotals(context.snapshot) }
}

interface HistoryResultBase { from: string; to: string; dayKey: string; resetEpoch: number }
interface NumericSummary { recordCount: number; latestDate: string | null; latestKg: number | null; changeKg: number | null; minKg: number | null; maxKg: number | null }
type NutritionRecord = History['nutrition'][number] & { energyDeficit: number }
export type HistoryResult = HistoryResultBase & (
  | { metric: 'weight'; data: History['weight']; summary: NumericSummary }
  | { metric: 'training'; data: History['training']; summary: { recordCount: number; sessionCount: number; totalMinutes: number } }
  | { metric: 'nutrition'; data: NutritionRecord[]; summary: { recordCount: number; consumed: Nutrients | null; expenditure: number | null; energyDeficit: number | null; averageDaily: (Nutrients & { expenditure: number; energyDeficit: number }) | null } }
  | { metric: 'exercise_load'; data: History['load']; summary: NumericSummary & { exerciseId: string; equipmentId: string; basis: LoadBasis } }
)

function numericSummary(records: { date: string; kg: number }[]): NumericSummary {
  const first = records[0]
  const latest = records.at(-1)
  return {
    recordCount: records.length,
    latestDate: latest?.date ?? null,
    latestKg: latest?.kg ?? null,
    changeKg: first && latest ? round(latest.kg - first.kg) : null,
    minKg: records.length ? Math.min(...records.map(record => record.kg)) : null,
    maxKg: records.length ? Math.max(...records.map(record => record.kg)) : null,
  }
}

/** Bounded structured queries only; all records come from the authenticated session. */
export function queryHistory(database: Pick<WellioDatabase, 'getSnapshot'>, sessionId: string, input: unknown): HistoryResult {
  const parsed = historyQuerySchema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  const query = parsed.data
  const snapshot = database.getSnapshot(sessionId)
  if (query.resetEpoch !== undefined && query.resetEpoch !== snapshot.resetEpoch) throw new BackendError('STALE_EPOCH', 409)
  const inclusiveDays = (Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / 86_400_000 + 1
  if (inclusiveDays < 1 || inclusiveDays > 31 || query.to > snapshot.dayKey) throw new BackendError('INVALID_DATE_RANGE', 400)
  const base = { from: query.from, to: query.to, dayKey: snapshot.dayKey, resetEpoch: snapshot.resetEpoch }
  const withinRange = <T extends { date: string }>(records: T[]): T[] => structuredClone(records.filter(record => record.date >= query.from && record.date <= query.to).sort((a, b) => a.date.localeCompare(b.date)))

  switch (query.metric) {
    case 'weight': {
      const data = withinRange(snapshot.history.weight)
      return { ...base, metric: query.metric, data, summary: numericSummary(data) }
    }
    case 'training': {
      const data = withinRange(snapshot.history.training)
      return { ...base, metric: query.metric, data, summary: { recordCount: data.length, sessionCount: data.filter(record => record.minutes > 0).length, totalMinutes: round(data.reduce((sum, record) => sum + record.minutes, 0)) } }
    }
    case 'nutrition': {
      const data = withinRange(snapshot.history.nutrition).map(record => ({ ...record, energyDeficit: round(record.expenditure - record.kcal) }))
      const consumed = data.length ? data.reduce((sum, record) => mapNutrients(key => sum[key] + record[key]), zeroNutrients()) : null
      const expenditure = data.length ? round(data.reduce((sum, record) => sum + record.expenditure, 0)) : null
      const energyDeficit = consumed && expenditure !== null ? round(expenditure - consumed.kcal) : null
      const averageDaily = consumed && expenditure !== null && energyDeficit !== null ? { ...mapNutrients(key => consumed[key] / data.length), expenditure: round(expenditure / data.length), energyDeficit: round(energyDeficit / data.length) } : null
      return { ...base, metric: query.metric, data, summary: { recordCount: data.length, consumed, expenditure, energyDeficit, averageDaily } }
    }
    case 'exercise_load': {
      const equipment = lookupEquipment(query.equipmentId)
      if (!equipment) throw new BackendError('EQUIPMENT_NOT_FOUND', 404)
      if (!equipment.load) throw new BackendError('EQUIPMENT_HAS_NO_LOAD', 400)
      const basis = equipment.load.basis
      const data = withinRange(snapshot.history.load).filter(record => record.exerciseId === query.exerciseId && record.equipmentId === query.equipmentId && record.basis === basis)
      const numeric = numericSummary(data)
      // Bodyweight is not displayed as a fabricated zero-kilogram load.
      if (basis === 'bodyweight') Object.assign(numeric, { latestKg: null, changeKg: null, minKg: null, maxKg: null })
      return { ...base, metric: query.metric, data, summary: { ...numeric, exerciseId: query.exerciseId, equipmentId: query.equipmentId, basis } }
    }
  }
}
