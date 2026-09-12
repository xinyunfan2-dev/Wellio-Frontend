import { z } from 'zod'
import type { ActionRequest } from '../lib/contracts'
import { BackendError } from './errors'

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const envelope = { requestId: id, resetEpoch: version, source: z.enum(['today', 'agent', 'workout', 'profile', 'app_open']) }
const workout = { workoutId: id, expectedWorkoutVersion: version }
export const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...envelope, kind: z.literal('set_locale'), locale: z.enum(['en', 'zh-CN']) }),
  z.strictObject({ ...envelope, kind: z.literal('reset_demo'), scenario: z.enum(['normal', 'low_recovery']) }),
  z.strictObject({ ...envelope, kind: z.literal('start_workout'), ...workout }),
  z.strictObject({ ...envelope, kind: z.literal('complete_exercise'), ...workout, exerciseId: id }),
  z.strictObject({ ...envelope, kind: z.literal('undo_exercise'), ...workout, exerciseId: id }),
  z.strictObject({ ...envelope, kind: z.literal('finish_workout'), ...workout, actualMinutes: z.number().int().min(1).max(1440), confirmIncomplete: z.boolean() }),
  z.strictObject({ ...envelope, kind: z.literal('apply_proposal'), proposalId: id, startAfterApply: z.boolean() }),
  z.strictObject({ ...envelope, kind: z.literal('dismiss_proposal'), proposalId: id }),
  z.strictObject({ ...envelope, kind: z.literal('undo_meal'), operationId: id }),
  z.strictObject({ ...envelope, kind: z.literal('check_readiness'), retry: z.boolean().optional() }),
  z.strictObject({ ...envelope, kind: z.literal('request_proposal'), gymId: z.enum(['gym-a', 'gym-b']).optional() }),
]) satisfies z.ZodType<ActionRequest>

export function parseAction(input: unknown): ActionRequest {
  const parsed = actionSchema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  return parsed.data
}

/** Key order is irrelevant; every validated payload field participates in deduplication. */
export function canonicalJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`
  if (input !== null && typeof input === 'object') {
    return `{${Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`).join(',')}}`
  }
  return JSON.stringify(input)
}
