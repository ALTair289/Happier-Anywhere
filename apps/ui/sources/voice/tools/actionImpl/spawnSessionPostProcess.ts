import { sync } from '@/sync/sync';
import { followUpSpawnedSessionWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';

function normalizeNonEmptyString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
}

export async function postprocessSpawnedSession(params: Readonly<{
  sessionId: string | null;
  serverId?: string | null;
  tag?: string | null;
  initialMessage?: string | null;
  firstTurnLocalId?: string | null;
}>): Promise<void> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  if (!sessionId) return;
  const tag = normalizeNonEmptyString(params.tag);
  const initialMessage = normalizeNonEmptyString(params.initialMessage);

  if (tag) {
    try {
      await sync.refreshSessions();
      await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => ({
        ...metadata,
        summary: { text: metadata?.summary?.text ?? `Session ${tag}`, updatedAt: Date.now() },
      }));
    } catch {
      // best-effort
    }
  }

  if (initialMessage) {
    await followUpSpawnedSessionWithServerScope({
      sessionId,
      targetServerId: params.serverId ?? null,
      initialMessageText: initialMessage,
      messageLocalId: normalizeNonEmptyString(params.firstTurnLocalId),
    });
  }
}
