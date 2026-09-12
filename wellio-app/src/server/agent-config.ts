import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

export interface AgentConfiguration { model: LanguageModel; maxSteps?: number; timeoutMs?: number; maxOutputTokens?: number }
export interface MenuConfiguration { endpoint?: string; token?: string; fetch?: typeof fetch }

/** Explicit server configuration only; never infer a model or scan secret stores. */
export function loadAgentConfiguration(env: NodeJS.ProcessEnv = process.env): AgentConfiguration | undefined {
  const modelId = env.WELLIO_AI_MODEL?.trim()
  const apiKey = env.LOVABLE_API_KEY?.trim()
  const protocol = env.WELLIO_AI_PROTOCOL
  if (!modelId || !apiKey || !['responses', 'chat'].includes(protocol ?? '')) return undefined
  const baseURL = env.WELLIO_AI_BASE_URL?.trim() || 'https://ai.gateway.lovable.dev/v1'
  try { if (new URL(baseURL).protocol !== 'https:') return undefined } catch { return undefined }
  const provider = createOpenAI({ baseURL, apiKey, headers: { 'Lovable-API-Key': apiKey } })
  return { model: protocol === 'responses' ? provider.responses(modelId) : provider.chat(modelId), maxSteps: 6, timeoutMs: 20_000, maxOutputTokens: 4_096 }
}

export function loadMenuConfiguration(env: NodeJS.ProcessEnv = process.env): MenuConfiguration {
  return { endpoint: env.WELLIO_LOVABLE_FIRECRAWL_ENDPOINT, token: env.WELLIO_LOVABLE_FIRECRAWL_TOKEN }
}
