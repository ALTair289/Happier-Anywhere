import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionsPage as fetchSessionsPageDefault, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { routeSessionUsageLimitRecoveryCheckNow } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter';

type FetchSessionsPage = typeof fetchSessionsPageDefault;
type RouteCheckNow = typeof routeSessionUsageLimitRecoveryCheckNow;

type HydrateInactiveUsageLimitRecoveryResult = Readonly<{
  scanned: number;
  observed: number;
}>;

function readSessionId(rawSession: RawSessionRecord): string {
  const raw = (rawSession as Readonly<{ id?: unknown }>).id;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Persisted recovery intents may only be re-armed while the session's latest
 * turn is still interrupted. A completed/cancelled latest turn supersedes the
 * intent: rehydrating it would schedule an involuntary time-based resume into
 * a session that already moved on. Unknown turn status keeps the intent.
 */
function hasInterruptedTurnEvidence(rawSession: RawSessionRecord): boolean {
  const status = (rawSession as Readonly<{ latestTurnStatus?: unknown }>).latestTurnStatus;
  return status == null || status === 'failed';
}

function readActiveRecoveryIntent(metadata: Record<string, unknown> | null): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    metadata?.[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  if (!parsed.success) return null;
  const recovery = parsed.data;
  if (
    recovery.status !== 'waiting'
    && recovery.status !== 'armed'
    && recovery.status !== 'checking'
  ) {
    return null;
  }
  if (typeof (recovery.nextCheckAtMs ?? recovery.resetAtMs) !== 'number') return null;
  return recovery;
}

export async function hydrateInactiveUsageLimitRecoveryFromSessionMetadata(params: Readonly<{
  credentials: Credentials;
  currentMachineId: string | null;
  currentMachineHost: string | null;
  currentMachineHomeDir: string | null;
  fetchSessionsPage?: FetchSessionsPage;
  decryptMetadata?: (input: Readonly<{
    credentials: Credentials;
    rawSession: RawSessionRecord;
  }>) => Record<string, unknown> | null;
  routeCheckNow?: RouteCheckNow;
  observe(input: Readonly<{
    sessionId: string;
    recovery: SessionUsageLimitRecoveryV1;
    runCheckNow: () => Promise<unknown>;
  }>): void | Promise<void>;
  maxPages?: number;
}>): Promise<HydrateInactiveUsageLimitRecoveryResult> {
  const fetchSessionsPage = params.fetchSessionsPage ?? fetchSessionsPageDefault;
  const decryptMetadata = params.decryptMetadata ?? ((input) => tryDecryptSessionMetadata(input));
  const routeCheckNow = params.routeCheckNow ?? routeSessionUsageLimitRecoveryCheckNow;
  const maxPages = Math.max(1, Math.trunc(params.maxPages ?? 50));
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let scanned = 0;
  let observed = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchSessionsPage({
      token: params.credentials.token,
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    for (const rawSession of result.sessions as ReadonlyArray<RawSessionRecord>) {
      scanned += 1;
      if (rawSession.active === true) continue;
      const sessionId = readSessionId(rawSession);
      if (!sessionId) continue;
      if (!hasInterruptedTurnEvidence(rawSession)) continue;
      const metadata = decryptMetadata({
        credentials: params.credentials,
        rawSession,
      });
      const recovery = readActiveRecoveryIntent(metadata);
      if (!metadata || !recovery) continue;
      await params.observe({
        sessionId,
        recovery,
        runCheckNow: async () => {
          const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, rawSession);
          const mode = resolveSessionStoredContentEncryptionMode(rawSession);
          return await routeCheckNow({
            token: params.credentials.token,
            credentials: params.credentials,
            sessionId,
            rawSession,
            metadata,
            currentMachineId: params.currentMachineId,
            currentMachineHost: params.currentMachineHost,
            currentMachineHomeDir: params.currentMachineHomeDir,
            ctx,
            mode,
            request: { sessionId },
            callLiveSessionRpc: async () => ({
              ok: false,
              errorCode: 'session_rpc_unavailable',
              error: 'session_rpc_unavailable',
            }),
          });
        },
      });
      observed += 1;
    }
    if (!result.hasNext || !result.nextCursor) break;
    if (seenCursors.has(result.nextCursor)) break;
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  return { scanned, observed };
}
