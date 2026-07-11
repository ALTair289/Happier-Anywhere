import { describe, expect, it } from 'vitest';

import type { SessionMediaSource } from '@/agent/core/AgentMessage';

import { resolveSessionMediaDedupeKey } from './sessionMediaDedupeKey';

describe('resolveSessionMediaDedupeKey', () => {
    it('hashes base64 media payloads instead of embedding full payloads in memory', () => {
        const largePayload = 'iVBORw0KGgo='.repeat(10_000);
        const media: SessionMediaSource = {
            kind: 'base64',
            data: largePayload,
            mimeType: 'image/png',
            origin: { source: 'acp-content', providerEventId: 'event-1', contentIndex: 0 },
        };

        const key = resolveSessionMediaDedupeKey(media);

        expect(key).not.toContain(largePayload);
        expect(key).toMatch(/^acp-content:id-sha256:[a-f0-9]{64}:0:image\/png:sha256:[a-f0-9]{64}$/);
        expect(key).not.toContain('event-1');
    });

    it('deduplicates the same local file across provider notification and final tool output projections', () => {
        const notification: SessionMediaSource = {
            kind: 'local-file',
            path: '/workspace/generated/image.png',
            origin: {
                source: 'provider-generated',
                agentId: 'cursor',
                toolCallId: 'image-call-1',
            },
        };
        const finalOutput: SessionMediaSource = {
            kind: 'local-file',
            path: '/workspace/generated/image.png',
            origin: {
                source: 'tool-output',
                toolCallId: 'image-call-1',
                contentIndex: 0,
            },
        };

        expect(resolveSessionMediaDedupeKey(notification)).toBe(resolveSessionMediaDedupeKey(finalOutput));
    });

    it('does not collapse separate generated calls that intentionally reuse one output path', () => {
        const first: SessionMediaSource = {
            kind: 'local-file',
            path: '/workspace/generated/image.png',
            origin: { source: 'provider-generated', agentId: 'cursor', toolCallId: 'image-call-1' },
        };
        const second: SessionMediaSource = {
            kind: 'local-file',
            path: '/workspace/generated/image.png',
            origin: { source: 'provider-generated', agentId: 'cursor', toolCallId: 'image-call-2' },
        };

        expect(resolveSessionMediaDedupeKey(first)).not.toBe(resolveSessionMediaDedupeKey(second));
    });

    it('hashes explicit provider dedupe keys so opaque identifiers stay bounded and private', () => {
        const providerKey = `provider:${'/Users/alice/private/'.repeat(1_000)}`;
        const media: SessionMediaSource = {
            kind: 'local-uri',
            uri: 'file:///tmp/generated.png',
            mimeType: 'image/png',
            origin: { source: 'tool-output', toolCallId: 'tool-1', contentIndex: 0 },
            dedupeKey: providerKey,
        };

        const key = resolveSessionMediaDedupeKey(media);
        expect(key).toMatch(/^explicit:sha256:[a-f0-9]{64}$/);
        expect(key).not.toContain(providerKey);
        expect(key.length).toBeLessThan(100);
    });

    it('hashes local URI correlation identifiers as well as the URI', () => {
        const privateCallId = '/Users/alice/private/call-id';
        const media: SessionMediaSource = {
            kind: 'local-uri',
            uri: 'file:///Users/alice/private/generated.png',
            mimeType: 'image/png',
            origin: { source: 'tool-output', toolCallId: privateCallId, contentIndex: 0 },
        };

        const key = resolveSessionMediaDedupeKey(media);
        expect(key).toMatch(/^tool-output:id-sha256:[a-f0-9]{64}:0:local-uri:[a-f0-9]{64}$/);
        expect(key).not.toContain(privateCallId);
        expect(key).not.toContain('/Users/alice/private');
    });
});
