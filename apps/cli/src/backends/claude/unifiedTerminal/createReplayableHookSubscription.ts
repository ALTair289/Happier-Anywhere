import type { SessionHookData } from '../utils/startHookServer';
import type { ClaudeUnifiedSessionHookSubscription } from './createClaudeUnifiedHookLifecycleBridge';

const CLAUDE_SESSION_IDENTITY_REPORTED = Symbol('happier.claudeSessionIdentityReported');

type ClaudeSessionHookWithIdentityOwnership = SessionHookData & Readonly<{
  [CLAUDE_SESSION_IDENTITY_REPORTED]?: true;
}>;

export function markClaudeSessionHookIdentityReported(data: SessionHookData): SessionHookData {
  const markedData = Object.isExtensible(data) ? data : { ...data };
  Object.defineProperty(markedData, CLAUDE_SESSION_IDENTITY_REPORTED, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return markedData;
}
export function wasClaudeSessionHookIdentityReported(data: SessionHookData): boolean {
  return (data as ClaudeSessionHookWithIdentityOwnership)[CLAUDE_SESSION_IDENTITY_REPORTED] === true;
}

export function createReplayableHookSubscription(
  subscribe: ClaudeUnifiedSessionHookSubscription | undefined,
): Readonly<{
  subscribe: ClaudeUnifiedSessionHookSubscription | undefined;
  dispose: () => void;
}> {
  if (!subscribe) {
    return {
      subscribe: undefined,
      dispose: () => {},
    };
  }

  const bufferedEvents: SessionHookData[] = [];
  const subscribers = new Set<(data: SessionHookData) => void>();
  let replayWindowOpen = true;
  let drainReplayWindowScheduled = false;
  let disposed = false;
  const drainReplayWindow = (): void => {
    bufferedEvents.length = 0;
    replayWindowOpen = false;
    drainReplayWindowScheduled = false;
  };
  const scheduleReplayWindowDrain = (): void => {
    if (!replayWindowOpen || drainReplayWindowScheduled) return;
    drainReplayWindowScheduled = true;
    // Startup bridges subscribe together during controller startup; keep the replay window
    // through the current turn, then stop retaining hook payloads for the rest of the session.
    queueMicrotask(() => {
      if (disposed) return;
      drainReplayWindow();
    });
  };
  const unsubscribeUpstream = subscribe((data) => {
    if (replayWindowOpen) {
      bufferedEvents.push(data);
    }
    for (const subscriber of [...subscribers]) {
      subscriber(data);
    }
  });

  return {
    subscribe: (callback) => {
      subscribers.add(callback);
      if (replayWindowOpen) {
        for (const event of bufferedEvents) {
          callback(event);
        }
        scheduleReplayWindowDrain();
      }
      return () => {
        subscribers.delete(callback);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      drainReplayWindow();
      subscribers.clear();
      unsubscribeUpstream?.();
    },
  };
}
