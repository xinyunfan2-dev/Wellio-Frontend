import type { ActionRequest, ChatRequest, ContextVersions, ReadinessCheck } from '../lib/contracts'
import type { UserIntent } from './user-intent'

export interface AgentRun {
  id: string; sessionId: string; requestId: string; resetEpoch: number; payloadHash: string;
  request: ChatRequest; source: 'user' | 'app_open' | 'ui_proposal'; messageId: string; sourceMessageId?: string;
  status: 'pending' | 'completed' | 'failed' | 'stopped'; leaseExpiresAt: number;
  checkKey?: string; checkAttemptId?: string; lastContextReadId?: string; lastVersions?: ContextVersions;
  searchUsed: boolean; errorCode?: string; proposalId?: string; toolIds: string[];
  requestedGymId?: 'gym-a' | 'gym-b'; intentConsumedBy?: string;
  preparedIntent?: UserIntent;
  actionRequest?: Extract<ActionRequest, { kind: 'request_proposal' }>;
}
export interface CheckRecord extends ReadinessCheck { sessionId: string; resetEpoch: number; attemptId?: string; runId?: string; leaseExpiresAt?: number }
export interface RuntimeCapabilities { agent: boolean; menuSearch: boolean }
