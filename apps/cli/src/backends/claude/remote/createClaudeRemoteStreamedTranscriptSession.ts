import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

export type ClaudeRemoteStreamedTranscriptEphemeralOptions = Readonly<{
    localId: string;
    createdAt: number;
    updatedAt?: number;
    meta?: Record<string, unknown>;
    tick?: number;
}>;

export type ClaudeRemoteStreamedTranscriptEphemeralDeltaOptions = Readonly<{
    localId: string;
    tick: number;
    baseLength: number;
    createdAt: number;
    updatedAt?: number;
    meta?: Record<string, unknown>;
}>;

export type ClaudeRemoteStreamedTranscriptClient = Readonly<{
    sendAgentMessage: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) => void;
    sendAgentMessageCommitted?: (
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
        opts: ClaudeRemoteStreamedTranscriptEphemeralOptions,
    ) => void | Promise<void>;
    sendAgentMessageEphemeralDelta?: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: ClaudeRemoteStreamedTranscriptEphemeralDeltaOptions,
    ) => void | Promise<void>;
    getEphemeralStreamConnectionEpoch?: () => number;
}>;

export type ClaudeRemoteStreamedTranscriptSession = StreamedTranscriptWriterSession & Readonly<{
    sendAgentMessageEphemeral?: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: ClaudeRemoteStreamedTranscriptEphemeralOptions,
    ) => void | Promise<void>;
}>;

export function createClaudeRemoteStreamedTranscriptSession(
    client: ClaudeRemoteStreamedTranscriptClient,
): ClaudeRemoteStreamedTranscriptSession {
    return {
        sendAgentMessage: (provider, body, opts) => client.sendAgentMessage(provider, body, opts),
        ...(typeof client.sendAgentMessageCommitted === 'function'
            ? {
                sendAgentMessageCommitted: (provider, body, opts) =>
                    client.sendAgentMessageCommitted?.(provider, body, opts) ?? Promise.resolve(),
            }
            : {}),
        ...(typeof client.enqueueAgentMessageCommitted === 'function'
            ? {
                enqueueAgentMessageCommitted: (provider, body, opts) =>
                    client.enqueueAgentMessageCommitted?.(provider, body, opts)
                    ?? Promise.resolve({ persisted: false, delivered: false }),
            }
            : {}),
        ...(typeof client.sendAgentMessageEphemeral === 'function'
            ? {
                sendAgentMessageEphemeral: (provider, body, opts) =>
                    client.sendAgentMessageEphemeral?.(provider, body, opts),
            }
            : {}),
        ...(typeof client.sendAgentMessageEphemeralDelta === 'function'
            ? {
                sendAgentMessageEphemeralDelta: (
                    provider: ACPProvider,
                    body: ACPMessageData,
                    opts: ClaudeRemoteStreamedTranscriptEphemeralDeltaOptions,
                ) => void client.sendAgentMessageEphemeralDelta?.(provider, body, opts),
            }
            : {}),
        ...(typeof client.getEphemeralStreamConnectionEpoch === 'function'
            ? {
                getEphemeralStreamConnectionEpoch: () => client.getEphemeralStreamConnectionEpoch?.() ?? 0,
            }
            : {}),
    };
}
