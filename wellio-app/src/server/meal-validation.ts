import { z } from 'zod'

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const localized = z.strictObject({ en: z.string().trim().min(1).max(200), 'zh-CN': z.string().trim().min(1).max(200) })
export const baselineSchema = z.strictObject({
  portion: localized,
  originalPortion: z.strictObject({ quantity: z.number().positive().max(100_000), unit: z.enum(['g', 'ml', 'piece', 'serving']) }),
  base: z.strictObject({ kcal: z.number().min(0).max(10_000), protein: z.number().min(0).max(2_000), carbs: z.number().min(0).max(2_000), fat: z.number().min(0).max(2_000) }),
  nutrientUnits: z.strictObject({ energy: z.literal('kcal'), mass: z.literal('g') }),
})
export const mealItemInputSchema = baselineSchema.extend({ name: localized, consumedFraction: z.number().min(0).max(1), estimated: z.boolean() })
export const mealChangesSchema = z.union([
  z.strictObject({ consumedFraction: z.number().min(0).max(1) }),
  z.strictObject({ baseline: baselineSchema }),
])
const common = { kind: z.literal('mutate_meal_log'), requestId: id, resetEpoch: version, runId: id, authorizationId: id, expectedMealRevision: version }
export const mutateMealLogSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...common, action: z.literal('add'), meal: z.strictObject({ period: z.enum(['breakfast', 'lunch', 'dinner', 'snack']), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), items: z.array(mealItemInputSchema).min(1).max(30) }) }),
  z.strictObject({ ...common, action: z.literal('update'), mealId: id, mealItemId: id, expectedMealVersion: version, changes: mealChangesSchema }),
  z.strictObject({ ...common, action: z.literal('delete'), mealId: id, mealItemId: id.optional(), expectedMealVersion: version }),
])
export type MealChanges = z.infer<typeof mealChangesSchema>
export type MutateMealLogInput = z.infer<typeof mutateMealLogSchema>
