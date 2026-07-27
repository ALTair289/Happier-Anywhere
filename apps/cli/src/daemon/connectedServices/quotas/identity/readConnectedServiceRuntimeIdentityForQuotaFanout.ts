import {
  ConnectedServiceCredentialRevisionV1Schema,
  SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { callSessionRpc as defaultCallSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { resolveSessionTransportContext as defaultResolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { Credentials } from '@/persistence';
import type {
  RuntimeAccountIdentityProbeResult,
  RuntimeAccountIdentityStrategy,
} from './runtimeAccountIdentityTypes';

const DEFAULT_RUNTIME_IDENTITY_RPC_TIMEOUT_MS = 2_000;

type CallSessionRpc = typeof defaultCallSessionRpc;
type ResolveSessionTransportContext = (params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
}>) => Promise<
  | Readonly<{
      ok: true;
      sessionId: string;
      mode: SessionStoredContentEncryptionMode;
      ctx: SessionEncryptionContext;
    }>
  | Readonly<{
      ok: false;
      code: string;
    }>
>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readGeneration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function buildExpected(input: Readonly<{
  groupId: string | null;
  profileId: string;
  expectedGroupGeneration: number | null;
  credentialRevision?: string | null;
}>): Readonly<{
  groupId?: string;
  profileId?: string;
  generation?: number;
  credentialRevision?: string;
}> {
  return {
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.expectedGroupGeneration === null ? {} : { generation: input.expectedGroupGeneration }),
    ...(input.credentialRevision ? { credentialRevision: input.credentialRevision } : {}),
  };
}

export async function readConnectedServiceRuntimeIdentityForQuotaFanout(input: Readonly<{
  credentials: Credentials;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string;
  expectedGroupGeneration: number | null;
  credentialRevision?: string | null;
  callSessionRpc?: CallSessionRpc;
  resolveSessionTransportContext?: ResolveSessionTransportContext;
  timeoutMs?: number;
}>): Promise<RuntimeAccountIdentityProbeResult> {
  const token = input.credentials.token.trim();
  if (!token) return { status: 'unavailable', reason: 'missing_token' };

  const resolveSessionTransportContext = input.resolveSessionTransportContext ?? defaultResolveSessionTransportContext;
  const callSessionRpc = input.callSessionRpc ?? defaultCallSessionRpc;
  const transport = await resolveSessionTransportContext({
    credentials: input.credentials,
    idOrPrefix: input.sessionId,
  });
  if (!transport.ok) {
    return { status: 'unavailable', reason: transport.code };
  }
  if (transport.sessionId !== input.sessionId) {
    return { status: 'unavailable', reason: 'session_id_mismatch' };
  }

  const rawResponse = await callSessionRpc({
    token,
    sessionId: input.sessionId,
    mode: transport.mode,
    ctx: transport.ctx,
    method: `${input.sessionId}:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY}`,
    timeoutMs: input.timeoutMs ?? DEFAULT_RUNTIME_IDENTITY_RPC_TIMEOUT_MS,
    request: {
      serviceId: input.serviceId,
      reason: 'same_provider_account_exhausted',
      requireExactProof: true,
      expected: buildExpected(input),
    },
  });
  const parsed = SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema.safeParse(rawResponse);
  if (!parsed.success) {
    return { status: 'unavailable', reason: 'invalid_runtime_identity_response' };
  }
  if (parsed.data.ok !== true) {
    return { status: 'unavailable', reason: parsed.data.errorCode ?? parsed.data.error };
  }
  if (parsed.data.serviceId !== input.serviceId) {
    return { status: 'unavailable', reason: 'runtime_identity_probe_account_mismatch' };
  }

  const strategy = parsed.data.identity.strategy as RuntimeAccountIdentityStrategy | 'none';
  const providerAccountId = readNonEmptyString(parsed.data.identity.providerAccountId);
  const sharedAuthSurfaceId = readNonEmptyString(parsed.data.identity.sharedAuthSurfaceId);
  if (parsed.data.identity.proofStrength !== 'exact') {
    return { status: 'inexact', reason: 'runtime_identity_probe_missing_exact_identity' };
  }
  if (strategy === 'provider_account_id' && !providerAccountId) {
    return { status: 'inexact', reason: 'runtime_identity_probe_missing_exact_identity' };
  }
  if (strategy === 'shared_group_auth_surface' && !sharedAuthSurfaceId) {
    return { status: 'inexact', reason: 'runtime_identity_probe_missing_exact_identity' };
  }
  if (strategy !== 'provider_account_id' && strategy !== 'shared_group_auth_surface') {
    return { status: 'inexact', reason: 'runtime_identity_probe_missing_exact_identity' };
  }

  const profileId = readNonEmptyString(parsed.data.runtime?.profileId);
  const groupId = readNonEmptyString(parsed.data.runtime?.groupId);
  const groupGeneration = readGeneration(parsed.data.runtime?.generation);
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
    parsed.data.runtime?.credentialRevision,
  );

  return {
    status: 'verified',
    strategy,
    ...(providerAccountId ? { providerAccountId } : {}),
    ...(sharedAuthSurfaceId ? { sharedAuthSurfaceId } : {}),
    accountLabel: readNonEmptyString(parsed.data.identity.accountLabel),
    proofStrength: 'exact',
    source: 'runtime_identity_probe',
    ...(profileId ? { profileId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(groupGeneration === null ? {} : { groupGeneration }),
    ...(credentialRevision.success ? { credentialRevision: credentialRevision.data } : {}),
    runtime: {
      safeToApply: readBoolean(parsed.data.runtime?.safeToApply),
      inProviderTurn: readBoolean(parsed.data.runtime?.inProviderTurn),
    },
  };
}
