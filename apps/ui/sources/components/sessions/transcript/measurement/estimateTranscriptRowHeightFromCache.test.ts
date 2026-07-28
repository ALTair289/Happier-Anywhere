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

    // RE-AUTHORED (W-1). The previous title — "does not serve a shrink-capable row a height
    // measured from a DIFFERENT shape" — pinned the RESERVATION rule onto the ESTIMATE, which are
    // opposite contracts (see the module doc). The reservation half is the real blank-space guard
    // and is asserted here verbatim; the estimate half was the web scroll regression and is inverted.
    it('releases the FORCING floor on a shape change but still predicts from the row\'s own measurement', () => {
        const reconciler = createTranscriptMeasurementReconciler({
            cache: createTestTranscriptItemHeightCache(),
        });
        const pending = buildSignature({
            itemId: 'pending-queue',
            kind: 'pending-action',
            rowState: 'pending-action',
        });
        reconciler.recordMeasuredHeight({ signature: pending, heightPx: 214 });
        // The queue drained 3 -> 1: same item, new content shape.
        const drained = { ...pending, structuralKey: 'structural-2' };
        // Reservation (a forcing `minHeight` that self-fulfils): still released. Do not weaken —
        // re-serving it here is exactly the stranded-blank-space defect E-3 fixed.
        expect(reconciler.resolveReservation(drained)).toBeUndefined();
        // Estimate (a prediction the renderer replaces on the row's next onLayout): the row's own
        // last measurement at this width/font is the best available predictor. `undefined` here
        // sends the renderer to the flat content heuristic and moves every row below it.
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: drained })).toBe(214);
    });
});

/**
 * W-1 — the web scroll regression oracle.
 *
 * `ChatListInternal.tsx` wires the vendored Legend `getItemSizeVersion` prop to the FULL row
 * signature key, so an OFFSCREEN row whose `structuralKey` moves has its measured size DELETED
 * from `sizesKnown` and is re-sized from `getEstimatedItemSize`
 * (`patches/@legendapp+list+3.3.3.patch` → `validateItemSizeVersion`). Legend then lays rows out by
 * accumulation, `positions[i+1] = positions[i] + size_i`; the repo's real-Legend integration test
 * `viewport/shell/renderer/legendListRenderer.real.integration.test.tsx`
 * ("uses the current item-size version estimate for an offscreen measured key…") pins that exact
 * arithmetic against the installed package.
 *
 * The oracle below therefore models the renderer's content model, not a re-implementation of it:
 * the anchored row's absolute offset is the sum of the sizes the app itself hands the renderer for
 * every preceding row. A row that has already been measured and whose PAINTED height did not change
 * must not move the anchor when its shape key moves — residual displacement 0.
 */
describe('W-1 · an offscreen shape change must not displace the anchored row', () => {
    const ROW_COUNT = 40;
    const ANCHOR_INDEX = 30;
    const RENDER_WINDOW_ROWS = 8;
    const NATURAL_ROW_HEIGHT_PX = 420;

    type ScrollModelRow = {
        item: TranscriptRowShellItem;
        naturalHeightPx: number;
        signature: TranscriptItemHeightValiditySignature;
    };

    function buildToolRows(): ScrollModelRow[] {
        return Array.from({ length: ROW_COUNT }, (_value, index): ScrollModelRow => ({
            item: { kind: 'message', id: `row-${index}`, messageId: `tool-${index}` } as TranscriptRowShellItem,
            naturalHeightPx: NATURAL_ROW_HEIGHT_PX,
            signature: buildSignature({
                itemId: `row-${index}`,
                kind: 'message:tool',
                // A tool row's structural key is its message revision (`transcriptRowShellSignature.ts`).
                structuralKey: `tool-${index}:r1`,
                // Running / permission-pending tool rows are pinned to 'tool-progress' and never
                // reach 'stable', so the exact-height cache structurally cannot hold them.
                rowState: 'tool-progress',
            }),
        }));
    }

    // The exact composition `ChatListInternal.tsx` hands Legend as `getEstimatedItemSize`.
    function resolveRendererSize(
        reconciler: ReturnType<typeof createTranscriptMeasurementReconciler>,
        row: ScrollModelRow,
    ): number {
        const estimate = estimateTranscriptRowHeightFromCache({ reconciler, signature: row.signature })
            ?? estimateTranscriptRowHeightFromContent({ getMessageById: () => null, item: row.item });
        return estimate ?? NATURAL_ROW_HEIGHT_PX;
    }

    function anchorOffsetPx(
        reconciler: ReturnType<typeof createTranscriptMeasurementReconciler>,
        rows: readonly ScrollModelRow[],
    ): number {
        let offset = 0;
        for (let index = 0; index < ANCHOR_INDEX; index += 1) {
            offset += resolveRendererSize(reconciler, rows[index]!);
        }
        return offset;
    }

    it('keeps the anchored row\'s offset fixed when rows scrolled past change shape offscreen', () => {
        const reconciler = createTranscriptMeasurementReconciler({
            cache: createTestTranscriptItemHeightCache(),
        });
        const rows = buildToolRows();

        // Scroll the render window across the whole list: every row mounts, measures, unmounts.
        for (let start = 0; start + RENDER_WINDOW_ROWS <= ROW_COUNT; start += 1) {
            for (let index = start; index < start + RENDER_WINDOW_ROWS; index += 1) {
                const row = rows[index]!;
                reconciler.recordMeasuredHeight({ signature: row.signature, heightPx: row.naturalHeightPx });
            }
        }

        const offsetBefore = anchorOffsetPx(reconciler, rows);
        expect(offsetBefore).toBe(ANCHOR_INDEX * NATURAL_ROW_HEIGHT_PX);

        // Ten tools ABOVE the viewport settle running -> completed while offscreen: the revision
        // bumps, the shape key moves, the PAINTED height is unchanged. Nothing the user can see
        // moved, so the anchor must not move either.
        const settled = rows.map((row, index): ScrollModelRow => (
            index < 10
                ? { ...row, signature: { ...row.signature, structuralKey: `tool-${index}:r2` } }
                : row
        ));

        expect(anchorOffsetPx(reconciler, settled) - offsetBefore).toBe(0);
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

    it('estimates a pending message from the string the row actually renders (displayText)', () => {
        // `PendingMessagesTranscriptBlock` renders `displayText ?? text`. A message whose stored
        // text is a short command but whose display form is long (or vice versa) must be sized
        // from the DISPLAYED string, or the estimate is wrong for exactly the rows it covers.
        const estimate = estimateTranscriptRowHeightFromContent({
            getMessageById: () => null,
            item: {
                kind: 'pending-queue',
                id: 'pending-queue',
                pendingMessages: [{
                    id: 'p1',
                    localId: null,
                    createdAt: 1,
                    updatedAt: 1,
                    text: 'hi',
                    displayText: 'z'.repeat(600),
                }],
                discardedMessages: [],
            } as unknown as TranscriptRowShellItem,
        });
        expect(estimate).toBeGreaterThan(150);
    });

    it('returns undefined for unknown item shapes so the renderer fallback applies', () => {
        const estimate = estimateTranscriptRowHeightFromContent({
            getMessageById: () => null,
            item: { kind: 'mystery', id: 'x' } as unknown as TranscriptRowShellItem,
        });
        expect(estimate).toBeUndefined();
    });
});
