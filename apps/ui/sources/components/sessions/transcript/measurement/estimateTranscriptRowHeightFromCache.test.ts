import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { estimateTranscriptRowHeightFromCache, estimateTranscriptRowHeightFromContent } from './estimateTranscriptRowHeightFromCache';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';
import { createTestTranscriptItemHeightCache, type TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import { createTranscriptMeasurementReconciler } from './transcriptMeasurementReconciler';

function buildSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'row-1',
        kind: 'turn:text',
        structuralKey: 'structural-1',
        widthBucket: 'w800',
        fontScaleKey: 'fs-1',
        groupingMode: 'linear',
        forkContextKey: 'none',
        expansionKey: 'none',
        rowState: 'stable',
        ...overrides,
    };
}

describe('estimateTranscriptRowHeightFromCache', () => {
    it('serves a prior exact measurement as the estimate', () => {
        const reconciler = createTranscriptMeasurementReconciler({
            cache: createTestTranscriptItemHeightCache(),
        });
        const signature = buildSignature();
        reconciler.recordMeasuredHeight({ signature, heightPx: 1859 });
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature })).toBe(1859);
    });

    it('never predicts from a GROWING row\'s floor — that floor is a cross-shape peak, not a size', () => {
        const reconciler = createTranscriptMeasurementReconciler({
            cache: createTestTranscriptItemHeightCache(),
        });
        // A streaming row records only the monotonic floor, not the exact cache. Its floor is
        // deliberately carried ACROSS content shapes, so it is a lower bound and never a prediction.
        const streaming = buildSignature({ rowState: 'streaming' });
        reconciler.recordMeasuredHeight({ signature: streaming, heightPx: 400 });
        // The reservation IS a floor of 400 — the estimator refuses it because the row is growing.
        expect(reconciler.resolveReservation(streaming)).toEqual({ kind: 'floor', minHeight: 400 });
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: streaming })).toBeUndefined();
        // Same for a thinking row (the other growing state).
        const thinking = buildSignature({ itemId: 'row-2', rowState: 'thinking' });
        reconciler.recordMeasuredHeight({ signature: thinking, heightPx: 640 });
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: thinking })).toBeUndefined();
    });

    it('returns undefined for never-measured rows so the renderer falls back to its own estimate', () => {
        const reconciler = createTranscriptMeasurementReconciler({
            cache: createTestTranscriptItemHeightCache(),
        });
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: buildSignature() })).toBeUndefined();
    });

    // E-28: a pending row carries rowState 'pending-action' permanently, so it is NEVER
    // exact-cacheable. Without this, every send lays the pending row out at the flat compact
    // constant and then corrects it to the measured height on the frame the user is watching.
    it('reuses a shrink-capable row\'s own measured height for the SAME shape', () => {
        const reconciler = createTranscriptMeasurementReconciler({
            cache: createTestTranscriptItemHeightCache(),
        });
        const pending = buildSignature({
            itemId: 'pending-queue',
            kind: 'pending-action',
            rowState: 'pending-action',
        });
        reconciler.recordMeasuredHeight({ signature: pending, heightPx: 214 });
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: pending })).toBe(214);
    });

    it('does not serve a shrink-capable row a height measured from a DIFFERENT shape', () => {
        const reconciler = createTranscriptMeasurementReconciler({
            cache: createTestTranscriptItemHeightCache(),
        });
        const pending = buildSignature({
            itemId: 'pending-queue',
            kind: 'pending-action',
            rowState: 'pending-action',
        });
        reconciler.recordMeasuredHeight({ signature: pending, heightPx: 214 });
        // The queue drained 3 -> 1: same item, new content shape. The stale 214px must not be served.
        const drained = { ...pending, structuralKey: 'structural-2' };
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: drained })).toBeUndefined();
    });
});

describe('estimateTranscriptRowHeightFromContent', () => {
    const agentText = (id: string, text: string): Message => ({
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    } as Message);

    it('scales a text message estimate with its content instead of a flat scalar', () => {
        const short = estimateTranscriptRowHeightFromContent({
            getMessageById: () => agentText('m1', 'hello'),
            item: { kind: 'message', id: 'i1', messageId: 'm1' } as TranscriptRowShellItem,
        });
        const giant = estimateTranscriptRowHeightFromContent({
            getMessageById: () => agentText('m1', 'x'.repeat(14_000)),
            item: { kind: 'message', id: 'i1', messageId: 'm1' } as TranscriptRowShellItem,
        });
        expect(short).toBeGreaterThan(0);
        // 14k chars is a multi-thousand-px markdown row; a flat 240px scalar
        // undercounted a live transcript by 53% (reopen capture 2026-07-23).
        expect(giant).toBeGreaterThan(3_000);
        expect(giant).toBeGreaterThan(short as number);
    });

    it('sums a turn estimate over its messages and counts tool messages compactly', () => {
        const turnItem = {
            kind: 'turn',
            id: 't1',
            turn: {
                userMessageId: 'u1',
                content: [
                    { kind: 'message', messageId: 'a1' },
                    { kind: 'tool_calls', toolMessageIds: ['tc1', 'tc2'] },
                ],
            },
        } as unknown as TranscriptRowShellItem; // minimal turn fixture: only the fields the estimator walks
        const estimate = estimateTranscriptRowHeightFromContent({
            getMessageById: (messageId) => (
                messageId === 'a1' ? agentText('a1', 'y'.repeat(720)) : null
            ),
            item: turnItem,
        });
        // 720 chars ≈ 10 lines of text + base, plus compact rows for the user
        // message (unresolvable → compact) and two tool messages.
        expect(estimate).toBeGreaterThan(250);
        expect(estimate).toBeLessThan(1_000);
    });

    it('scales a tool-calls group estimate by its tool count', () => {
        const estimate = estimateTranscriptRowHeightFromContent({
            getMessageById: () => null,
            item: {
                kind: 'tool-calls-group',
                id: 'g1',
                toolMessageIds: Array.from({ length: 30 }, (_, i) => `t${i}`),
                createdAt: 1,
            } as TranscriptRowShellItem,
        });
        expect(estimate).toBeGreaterThan(1_500);
    });

    // E-28: the pending-queue row is the row a send creates. Estimating it flat means every send
    // lays it out at the compact constant and then corrects to the real height one frame later.
    it('scales a pending-queue estimate with the queued message text', () => {
        const pendingQueue = (text: string): TranscriptRowShellItem => ({
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages: [{ id: 'p1', localId: null, createdAt: 1, updatedAt: 1, text }],
            discardedMessages: [],
        } as unknown as TranscriptRowShellItem);
        const short = estimateTranscriptRowHeightFromContent({
            getMessageById: () => null,
            item: pendingQueue('ok'),
        });
        const long = estimateTranscriptRowHeightFromContent({
            getMessageById: () => null,
            item: pendingQueue('x'.repeat(600)),
        });
        // 600 chars ≈ 9 wrapped lines: a real multi-line send is far taller than the compact constant.
        expect(long).toBeGreaterThan(150);
        expect(long).toBeGreaterThan(short as number);
        expect(short).toBeGreaterThan(0);
    });

    it('sums a pending-queue estimate over every queued and discarded message', () => {
        const estimate = estimateTranscriptRowHeightFromContent({
            getMessageById: () => null,
            item: {
                kind: 'pending-queue',
                id: 'pending-queue',
                pendingMessages: [
                    { id: 'p1', localId: null, createdAt: 1, updatedAt: 1, text: 'a'.repeat(300) },
                    { id: 'p2', localId: null, createdAt: 2, updatedAt: 2, text: 'b'.repeat(300) },
                ],
                discardedMessages: [
                    { id: 'd1', localId: null, createdAt: 3, updatedAt: 3, text: 'c'.repeat(300), discardedAt: 4, discardedReason: null },
                ],
            } as unknown as TranscriptRowShellItem,
        });
        // Three ~5-line entries; a flat compact constant undercounts this by roughly 5x.
        expect(estimate).toBeGreaterThan(350);
    });

    it('returns undefined for unknown item shapes so the renderer fallback applies', () => {
        const estimate = estimateTranscriptRowHeightFromContent({
            getMessageById: () => null,
            item: { kind: 'mystery', id: 'x' } as unknown as TranscriptRowShellItem,
        });
        expect(estimate).toBeUndefined();
    });
});
