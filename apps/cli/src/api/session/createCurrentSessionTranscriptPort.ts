import type { ACPMessageData, ACPProvider } from './sessionMessageTypes';

type TranscriptPortSession = Readonly<{
  sendAgentMessage?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: { localId?: string; meta?: Record<string, unknown> },
  ) => void;
  sendAgentMessageCommitted: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  enqueueAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
  ) => void;
  sendAgentMessageEphemeralDelta?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
  ) => void;
  getEphemeralStreamConnectionEpoch?: () => number;
}>;

export function createCurrentSessionTranscriptPort(
  getSession: () => TranscriptPortSession,
): TranscriptPortSession {
  return {
    sendAgentMessage: (provider, body, opts) => getSession().sendAgentMessage?.(provider, body, opts),
    sendAgentMessageCommitted: (provider, body, opts) => getSession().sendAgentMessageCommitted(provider, body, opts),
    get enqueueAgentMessageCommitted() {
      if (typeof getSession().enqueueAgentMessageCommitted !== 'function') return undefined;
      return (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
      ) => getSession().enqueueAgentMessageCommitted?.(provider, body, opts) ?? Promise.resolve({ persisted: false, delivered: false });
    },
    get sendAgentMessageEphemeral() {
      if (typeof getSession().sendAgentMessageEphemeral !== 'function') return undefined;
      return (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
      ) => getSession().sendAgentMessageEphemeral?.(provider, body, opts);
    },
    get sendAgentMessageEphemeralDelta() {
      if (typeof getSession().sendAgentMessageEphemeralDelta !== 'function') return undefined;
      return (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
      ) => getSession().sendAgentMessageEphemeralDelta?.(provider, body, opts);
    },
    get getEphemeralStreamConnectionEpoch() {
      if (typeof getSession().getEphemeralStreamConnectionEpoch !== 'function') return undefined;
      return () => getSession().getEphemeralStreamConnectionEpoch?.() ?? 0;
    },
  };
}
