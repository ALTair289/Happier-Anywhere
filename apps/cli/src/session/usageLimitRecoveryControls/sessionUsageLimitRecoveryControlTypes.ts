import type { AgentId } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type SessionUsageLimitRecoveryControlAdapterParams = Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  currentMachineId: string | null;
  sessionMachineId: string | null;
  cwd: string | null;
  ctx: SessionEncryptionContext;
  mode: SessionStoredContentEncryptionMode;
  resumePromptMode?: 'standard' | 'off' | 'custom';
}>;

export type SessionUsageLimitRecoveryControlAdapter = Readonly<{
  checkNow?: (params: SessionUsageLimitRecoveryControlAdapterParams) => Promise<unknown>;
  consumeResetCredit?: (params: SessionUsageLimitRecoveryControlAdapterParams) => Promise<unknown>;
}>;

export type ResolveSessionUsageLimitRecoveryControlAdapter = (
  agentId?: AgentId | null,
) => Promise<SessionUsageLimitRecoveryControlAdapter | null>;
