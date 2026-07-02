import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import { createClaudeRemoteStreamedTranscriptSession } from './createClaudeRemoteStreamedTranscriptSession';

async function flushTranscriptCommitMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
}

describe('createClaudeRemoteStreamedTranscriptSession', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('proxies optional ephemeral agent messages when the session client supports them', () => {
        const ephemeralCalls: Array<{
            provider: ACPProvider;
            body: ACPMessageData;
            opts: {
                localId: string;
                createdAt: number;
                updatedAt?: number;
                meta?: Record<string, unknown>;
            };
        }> = [];

        const session = createClaudeRemoteStreamedTranscriptSession({
            sendAgentMessage: () => {},
            sendAgentMessageCommitted: async () => {},
            sendAgentMessageEphemeral: (provider, body, opts) => {
                ephemeralCalls.push({ provider, body, opts });
            },
        });

        expect(session.sendAgentMessageEphemeral).toBeTypeOf('function');

        session.sendAgentMessageEphemeral?.(
            'claude',
            { type: 'message', message: 'Hello' },
            {
                localId: 'segment-1',
                createdAt: 10,
                updatedAt: 20,
                meta: {
                    happierStreamSegmentV1: {
                        v: 1,
                        segmentKind: 'assistant',
                        segmentLocalId: 'segment-1',
                        segmentState: 'streaming',
                        updatedAtMs: 20,
                    },
                },
            },
        );

        expect(ephemeralCalls).toEqual([
            {
                provider: 'claude',
                body: { type: 'message', message: 'Hello' },
                opts: {
                    localId: 'segment-1',
                    createdAt: 10,
                    updatedAt: 20,
                    meta: {
                        happierStreamSegmentV1: {
                            v: 1,
                            segmentKind: 'assistant',
                            segmentLocalId: 'segment-1',
                            segmentState: 'streaming',
                            updatedAtMs: 20,
                        },
                    },
                },
            },
        ]);
    });

    it('keeps ephemeral sends unavailable when the session client does not support them', () => {
        const session = createClaudeRemoteStreamedTranscriptSession({
            sendAgentMessage: () => {},
            sendAgentMessageCommitted: async () => {},
        });

        expect(session.sendAgentMessageEphemeral).toBeUndefined();
    });

    it('routes streamed committed snapshots through the durable enqueue hook when available', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(0));

        const enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true as const, delivered: false }));
        const sendAgentMessageCommitted = vi.fn(async () => {});
        const session = createClaudeRemoteStreamedTranscriptSession({
            sendAgentMessage: vi.fn(),
            sendAgentMessageCommitted,
            enqueueAgentMessageCommitted,
        } as any);
        const writer = createStreamedTranscriptWriter({
            provider: 'claude' as any,
            session,
            makeLocalId: () => 'segment-1',
            initialCheckpointDelayMs: 10_000,
            checkpointIntervalMs: 10_000,
            checkpointMinChars: 999,
        });

        writer.appendAssistantDelta('Claude final');
        await writer.flushAll({ reason: 'turn-end' });
        await flushTranscriptCommitMicrotasks();

        expect(sendAgentMessageCommitted).not.toHaveBeenCalled();
        expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
            'claude',
            { type: 'message', message: 'Claude final' },
            expect.objectContaining({ localId: 'segment-1' }),
        );
    });

    it('proxies optional ephemeral delta sends and connection epochs when the session client supports them', () => {
        const sendAgentMessageEphemeralDelta = vi.fn();
        const getEphemeralStreamConnectionEpoch = vi.fn(() => 3);

        const session = createClaudeRemoteStreamedTranscriptSession({
            sendAgentMessage: () => {},
            sendAgentMessageCommitted: async () => {},
            sendAgentMessageEphemeral: () => {},
            sendAgentMessageEphemeralDelta,
            getEphemeralStreamConnectionEpoch,
        });

        expect(session.sendAgentMessageEphemeralDelta).toBeTypeOf('function');
        session.sendAgentMessageEphemeralDelta?.(
            'claude',
            { type: 'message', message: ' delta' },
            { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 10, updatedAt: 20 },
        );

        expect(sendAgentMessageEphemeralDelta).toHaveBeenCalledWith(
            'claude',
            { type: 'message', message: ' delta' },
            { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 10, updatedAt: 20 },
        );
        expect(session.getEphemeralStreamConnectionEpoch?.()).toBe(3);
    });

    it('keeps delta sends unavailable when the session client does not support them', () => {
        const session = createClaudeRemoteStreamedTranscriptSession({
            sendAgentMessage: () => {},
            sendAgentMessageCommitted: async () => {},
            sendAgentMessageEphemeral: () => {},
        });

        expect(session.sendAgentMessageEphemeralDelta).toBeUndefined();
        expect(session.getEphemeralStreamConnectionEpoch).toBeUndefined();
    });
});
