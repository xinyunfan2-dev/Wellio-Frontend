import { z } from 'zod'
import type { ChatRequest } from '../lib/contracts'
import { BackendError } from './errors'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const common = { requestId: id, resetEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), conversationId: id, locale: z.enum(['en', 'zh-CN']) }
export const chatSchema = z.discriminatedUnion('source', [
  z.strictObject({ ...common, source: z.literal('user'), message: z.string().max(4_000), attachmentIds: z.array(id).max(4), purpose: z.enum(['food', 'menu']).optional(), targetMealId: id.optional(), targetMealItemId: id.optional(), targetWorkoutId: id.optional(), targetExerciseId: id.optional(), targetOperationId: id.optional() }).refine(value => value.message.trim().length > 0 || value.attachmentIds.length > 0),
  z.strictObject({ ...common, source: z.literal('app_open'), message: z.literal(''), attachmentIds: z.array(id).max(0), checkMode: z.enum(['auto', 'retry']).optional() }),
])
export function parseChat(input: unknown): ChatRequest {
  const parsed = chatSchema.safeParse(input)
  if (!parsed.success) throw new BackendError('INVALID_INPUT', 400)
  return parsed.data
}
