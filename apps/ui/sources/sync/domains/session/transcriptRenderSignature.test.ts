import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { buildSessionTranscriptRenderSignature } from './transcriptRenderSignature';

const baseSession = {
    id: 'session-1',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: { path: '/repo', host: 'host.local', machineId: 'machine-1' },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 1,
    presence: 'online',
} satisfies Session;

describe('buildSessionTranscriptRenderSignature', () => {
    it('ignores session churn that does not affect transcript rendering', () => {
        const signature = buildSessionTranscriptRenderSignature(baseSession);

        expect(buildSessionTranscriptRenderSignature({
            ...baseSession,
            updatedAt: 2,
            activeAt: 2,
            thinkingAt: 2,
            meaningfulActivityAt: 2,
            pendingCount: 1,
            pendingVersion: 2,
            latestUsage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 2,
                timestamp: 2,
            },
        })).toBe(signature);
    });

    it('includes the transcript sequence cursor so parent-driven transcript updates render', () => {
        expect(buildSessionTranscriptRenderSignature({
            ...baseSession,
            seq: 2,
        })).not.toBe(buildSessionTranscriptRenderSignature(baseSession));
    });

    it('includes transcript-visible session fields', () => {
        expect(buildSessionTranscriptRenderSignature({
            ...baseSession,
            active: false,
        })).not.toBe(buildSessionTranscriptRenderSignature(baseSession));
    });

    it('treats future session fields as relevant by default', () => {
        const sessionWithFutureField: Session & { futureTranscriptRenderVersion: number } = {
            ...baseSession,
            updatedAt: 2,
            futureTranscriptRenderVersion: 1,
        };

        expect(buildSessionTranscriptRenderSignature(sessionWithFutureField))
            .not.toBe(buildSessionTranscriptRenderSignature(baseSession));
    });
});
