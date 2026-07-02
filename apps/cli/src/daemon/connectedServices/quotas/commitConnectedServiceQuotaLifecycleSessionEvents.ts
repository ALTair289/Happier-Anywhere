import {
  TranscriptRawAgentEventV1Schema,
  type SessionStoredMessageContent,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import {
  encryptSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  commitSessionStoredMessage,
  fetchSessionById,
} from '@/session/transport/http/sessionsHttp';

import type { ConnectedServiceQuotaLifecycleTransition } from './ConnectedServiceQuotasCoordinator';
import { buildQuotaLifecycleTranscriptEventId } from './quotaLifecycleEventIdentity';

function buildStoredContent(params: Readonly<{
  credentials: Credentials;
  rawSession: Awaited<ReturnType<typeof fetchSessionById>>;
  payload: unknown;
}>): SessionStoredMessageContent {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession ?? undefined);
  if (mode === 'plain') {
    return { t: 'plain', v: params.payload };
  }
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession ?? undefined);
  return {
    t: 'encrypted',
    c: encryptSessionPayload({ ctx, payload: params.payload }),
  };
}

function buildQuotaLifecycleTranscriptEvent(
  transition: ConnectedServiceQuotaLifecycleTransition,
): unknown | null {
  if (transition.phase === 'blocked') {
    // `provider-quota-wait` carries a required reset time the UI renders as a wall-clock
    // value; a timing-less blocked edge has nothing truthful to render, so the transcript
    // marker is skipped (the quota-blocked notification still fires for the session).
    if (typeof transition.resetAtMs !== 'number' || !Number.isFinite(transition.resetAtMs) || transition.resetAtMs < 0) {
      return null;
    }
    return {
      type: 'provider-quota-wait',
      serviceId: transition.serviceId,
      ...(transition.activeProfileId ? { profileId: transition.activeProfileId } : {}),
      groupId: transition.groupId,
      resetAtMs: Math.trunc(transition.resetAtMs),
      reason: transition.reason,
    };
  }
  return {
    type: 'provider-quota-recovered',
    serviceId: transition.serviceId,
    ...(transition.activeProfileId ? { profileId: transition.activeProfileId } : {}),
    groupId: transition.groupId,
    reason: transition.reason,
  };
}

/**
 * RD-QUO-13: transcript producer for the quota lifecycle edges. Commits a
 * `provider-quota-wait` / `provider-quota-recovered` raw agent event into every
 * affected group-bound session so the (already-rendered) UI transcript rows become
 * reachable. Best-effort per session: one failing session never blocks the rest.
 */
export async function commitConnectedServiceQuotaLifecycleSessionEvents(params: Readonly<{
  credentials: Credentials;
  transition: ConnectedServiceQuotaLifecycleTransition;
}>): Promise<void> {
  const rawEvent = buildQuotaLifecycleTranscriptEvent(params.transition);
  if (rawEvent === null) return;
  const parsedEvent = TranscriptRawAgentEventV1Schema.safeParse(rawEvent);
  if (!parsedEvent.success) return;

  for (const sessionId of params.transition.sessionIds) {
    try {
      const rawSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId,
      });
      if (!rawSession) continue;
      const eventId = buildQuotaLifecycleTranscriptEventId({
        eventType: parsedEvent.data.type,
        issueFingerprint: params.transition.issueFingerprint || `${params.transition.serviceId}:${params.transition.groupId}`,
        resetAtMs: params.transition.resetAtMs,
        cycleId: params.transition.cycleId,
        reason: params.transition.reason,
      });
      await commitSessionStoredMessage({
        token: params.credentials.token,
        sessionId,
        localId: eventId,
        messageRole: 'event',
        content: buildStoredContent({
          credentials: params.credentials,
          rawSession,
          payload: {
            role: 'agent',
            content: {
              type: 'event',
              id: eventId,
              data: parsedEvent.data,
            },
          },
        }),
      });
    } catch {
      // Transcript markers are best-effort; never fail the quota lifecycle path.
    }
  }
}
