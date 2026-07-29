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

    /**
     * S-1 (RED until `transcriptMeasurementReconciler.recordMeasuredHeight` stops re-labelling a
     * carried peak with the CURRENT `structuralKey`).
     *
     * A GROWING row's floor is deliberately carried across content shapes — that is what stops a
     * mid-stream frame from under-reserving. But `recordMeasuredHeight` stores the carried peak
     * under the shape it was carried INTO, so the peak's provenance is destroyed. Once the row
     * settles (`thinking`/`streaming` -> `stable`) at that same shape, `isFloorShapeValid` compares
     * equal keys and can never refuse it again: the row's own last real measurement is 96px, but
     * every consumer is served 612px.
     *
     * Both consumers strand on it, which is why the symptom reads as BOTH "element height" and
     * "top placement":
     *  - `estimateTranscriptRowHeightFromCache` (this owner) hands 612 to Legend's
     *    `getEstimatedItemSize`, and Legend places rows by accumulation, so the next row's `top` is
     *    612 below — a 516px gap under a 96px row that nothing paints.
     *  - `resolveTranscriptRowShellHeight` hands 612 to `TranscriptRowShell` as a forcing
     *    `minHeight` on a FRESH mount (a remount has no previous signature to diff), so the row's
     *    own element becomes 612px tall around 96px of content, re-measures at 612, and writes 612
     *    into the stable exact cache — the strand is then permanent for the session.
     */
    it('does not predict from a peak that was carried in from a DIFFERENT shape while growing', () => {
        const reconciler = createTranscriptMeasurementReconciler({
            cache: createTestTranscriptItemHeightCache(),
        });
        // A live thinking block streams to 612px at revision r7.
        reconciler.recordMeasuredHeight({
            signature: buildSignature({ kind: 'message:thinking', rowState: 'thinking', structuralKey: 'm1:r7' }),
            heightPx: 612,
        });
        // It collapses to its settled 96px form at r8, still classified as growing for that frame.
        reconciler.recordMeasuredHeight({
            signature: buildSignature({ kind: 'message:thinking', rowState: 'thinking', structuralKey: 'm1:r8' }),
            heightPx: 96,
        });
        // A newer message becomes the latest activity, so the row settles at the SAME shape r8.
        const settled = buildSignature({ kind: 'message:agent', rowState: 'stable', structuralKey: 'm1:r8' });

        // The row's own last real measurement at this shape is 96. Anything larger is space the
        // renderer reserves and nothing paints.
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: settled })).toBe(96);
        expect(reconciler.resolveReservation(settled)).toBeUndefined();
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
            ?? estimateTranscriptRowHeightFromContent({ getMessageById: () => null, item: row.item, toolCallsGroupChromeVariant: 'feed_background' });
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
    // Real painted heights from the live web capture 2026-07-28 (session
    // `cms3bvdv13hlutm9p19hw1n9s` plus the three healthy control sessions, whose row contiguity
    // was exact). These are the oracle every tool-group estimate below is calibrated against.
    const MEASURED_TOOL_GROUP_HEADER_PX = 33;
    const MEASURED_TOOL_ROW_PX = 28;
    const MEASURED_TOOL_GROUP_FOOTER_PX = 34;

    const toolCallsGroupItem = (toolCount: number): TranscriptRowShellItem => ({
        kind: 'tool-calls-group',
        id: 'g1',
        toolMessageIds: Array.from({ length: toolCount }, (_, i) => `t${i}`),
        createdAt: 1,
    } as TranscriptRowShellItem);

    const toolGroupUnitItem = (kind: string): TranscriptRowShellItem => ({
        kind,
        id: `g1#${kind}`,
        groupId: 'g1',
        toolMessageId: 't0',
        toolMessageIds: ['t0', 't1', 't2'],
        expanded: false,
        hiddenCount: 297,
        createdAt: 1,
        seq: 1,
    } as unknown as TranscriptRowShellItem);

    const agentText = (id: string, text: string): Message => ({
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    } as Message);

    it('scales a text message estimate with its content instead of a flat scalar', () => {
        const short = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => agentText('m1', 'hello'),
            item: { kind: 'message', id: 'i1', messageId: 'm1' } as TranscriptRowShellItem,
        });
        const giant = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
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
            toolCallsGroupChromeVariant: 'feed_background',
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

    it('scales a tool-calls group estimate by its RENDERED tool rows, not its tool count', () => {
        const estimateFor = (toolCount: number) => estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: toolCallsGroupItem(toolCount),
        }) as number;
        // Below the collapsed-preview count the group really does render one row per tool.
        expect(estimateFor(3)).toBeGreaterThan(estimateFor(2));
        // Above it the group renders at most `collapsedPreviewCount` preview rows plus a single
        // "show N more" row — `buildTranscriptTurnUnits.ts` `appendToolGroupUnits`. A 30-tool and
        // a 300-tool group therefore lay out the SAME height, and both are a few hundred px.
        expect(estimateFor(300)).toBe(estimateFor(30));
        expect(estimateFor(300)).toBeLessThan(700);
    });

    /**
     * T-3 · residual 1 — the cap rows are the gap.
     *
     * Legend places rows by ACCUMULATION (`positions[i+1] = positions[i] + size_i`), so an
     * estimate that overshoots a row's painted height becomes a literal gap underneath it. The
     * live web capture 2026-07-28 measured a tool-group header at 33px against this owner's flat
     * 56px compact estimate, and `56 - 33 = 23` is exactly the gap captured between that header
     * and its expand row. Those two rows are adjacent BY CONSTRUCTION (`appendToolGroupUnits`
     * emits header -> expand -> tools -> footer with nothing between them), so the gap cannot be
     * a virtualized-out row — it is the estimator's own overshoot. A healthy inter-row gap is 0.
     */
    it('estimates the tool-group cap rows at their measured heights so accumulation leaves no gap', () => {
        const estimateFor = (item: TranscriptRowShellItem) => estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item,
        }) as number;
        expect(estimateFor(toolGroupUnitItem('tool-group-header'))).toBe(MEASURED_TOOL_GROUP_HEADER_PX);
        expect(estimateFor(toolGroupUnitItem('tool-group-footer'))).toBe(MEASURED_TOOL_GROUP_FOOTER_PX);
        expect(estimateFor(toolGroupUnitItem('tool-group-tool'))).toBe(MEASURED_TOOL_ROW_PX);
        // The "show N more" row is the same single-line cap as a tool row.
        expect(estimateFor(toolGroupUnitItem('tool-group-expand'))).toBe(MEASURED_TOOL_ROW_PX);
    });

    /**
     * T-3 · residual 2 — the ceiling was the settings CLAMP, not the session's preview count.
     *
     * `ESTIMATE_MAX_COLLAPSED_TOOL_ROWS` resolved the preview-count setting with
     * `Number.MAX_SAFE_INTEGER`, which returns the clamp maximum (15) rather than what the
     * session renders. A default-config group therefore estimated `(15 + 1) * 32 = 512` against a
     * painted `33 + 28 + 3*28 + 34 = 179` — a 333px per-group phantom that accumulation turns
     * into blank space above the viewport.
     */
    it('sizes a collapsed tool group from the session preview count, not the settings clamp', () => {
        const estimateFor = (collapsedPreviewCount: number) => estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: toolCallsGroupItem(300),
            toolGroupLayout: { collapsedPreviewCount, isExpanded: () => false },
        }) as number;
        // header 33 + "show 297 more" 28 + 3 preview rows 84 + footer 34.
        expect(estimateFor(3)).toBe(179);
        // The product default is 3, so the unthreaded estimate must land on the same 179.
        expect(estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: toolCallsGroupItem(300),
        })).toBe(179);
        // A session configured at the clamp maximum really does render 15 preview rows.
        expect(estimateFor(15)).toBe(33 + 28 + 15 * MEASURED_TOOL_ROW_PX + 34);
    });

    /**
     * T-3 · residual 3 — the ceiling ignored expansion, so it UNDER-estimated.
     *
     * An expanded group renders every tool row. Capping it at the collapsed preview tail turned a
     * bounded over-estimate into a ~47x under-estimate for a 300-tool group, and an under-estimate
     * is not the safe direction: the renderer lays the row out short and then corrects it on the
     * frame the user is watching, dragging every row below it.
     */
    it('does not under-estimate an EXPANDED tool group', () => {
        const expanded = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: toolCallsGroupItem(300),
            toolGroupLayout: { collapsedPreviewCount: 3, isExpanded: () => true },
        }) as number;
        // header 33 + 300 tool rows + footer 34 — no "show N more" row while expanded.
        expect(expanded).toBe(33 + 300 * MEASURED_TOOL_ROW_PX + 34);
        // A turn carrying that same expanded group must not collapse to the preview-tail height.
        const turnWithExpandedGroup = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: {
                kind: 'turn',
                id: 't1',
                turn: {
                    userMessageId: null,
                    content: [{
                        kind: 'tool_calls',
                        id: 'tc',
                        toolMessageIds: Array.from({ length: 300 }, (_, i) => `t${i}`),
                    }],
                },
            } as unknown as TranscriptRowShellItem,
            toolGroupLayout: { collapsedPreviewCount: 3, isExpanded: () => true },
        }) as number;
        expect(turnWithExpandedGroup).toBeGreaterThanOrEqual(expanded);
    });

    // P-1 live web capture 2026-07-28, session `cms3bvdv13hlutm9p19hw1n9s`: the scroller reported
    // scrollHeight 18620 while the three rendered rows measured [0, 3874, 26] (3900 total) — a
    // 14,724px phantom the viewport was parked inside (scrollTop 17848 => blank screen). The
    // middle row is one turn holding a few hundred tool calls; counting a compact row for EVERY
    // tool message inflated the app's `getEstimatedItemSize` (ChatListInternal.tsx:1368-1375) to
    // the 20,000px cap, and Legend sized its content model from that estimate.
    it('does not inflate a collapsed tool-heavy turn into a phantom content size', () => {
        const REAL_MEASURED_ROW_PX = 3_874;
        const turnItem = {
            kind: 'turn',
            id: 't1',
            turn: {
                userMessageId: 'u1',
                content: [
                    { kind: 'message', messageId: 'a1' },
                    {
                        kind: 'tool_calls',
                        id: 'tc',
                        toolMessageIds: Array.from({ length: 314 }, (_, i) => `t${i}`),
                    },
                ],
            },
        } as unknown as TranscriptRowShellItem;
        const estimate = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            // ~12k chars of markdown: the text really rendered by that row.
            getMessageById: (messageId) => (messageId === 'a1' ? agentText('a1', 'y'.repeat(12_000)) : null),
            item: turnItem,
        }) as number;
        // The estimate must still carry the giant markdown body...
        expect(estimate).toBeGreaterThan(3_000);
        // ...but the phantom (estimate - real measured height) must be a healthy tail, not 14,724.
        expect(estimate - REAL_MEASURED_ROW_PX).toBeLessThan(1_000);
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
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: pendingQueue('ok'),
        });
        const long = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
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
            toolCallsGroupChromeVariant: 'feed_background',
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
            toolCallsGroupChromeVariant: 'feed_background',
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
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: { kind: 'mystery', id: 'x' } as unknown as TranscriptRowShellItem,
        });
        expect(estimate).toBeUndefined();
    });
});

/**
 * P (2026-07-29) · a tool row is sized by the chrome it actually paints.
 *
 * `toolViewTimelineChromeMode` is a user setting (`TranscriptSettingsView`), and it decides two
 * things at once: `resolveToolCallsGroupChromeVariant` returns `cards` exactly when the mode is
 * not `activity_feed`, and `useChatListRootState` turns grouping OFF for the same condition
 * (`groupToolCalls = transcriptGroupToolCalls === true && toolViewTimelineChromeMode ===
 * 'activity_feed'`). So the two chrome families are also two disjoint ROW families: the feed
 * variants own every `tool-group-*` row, and `cards` owns the ungrouped tool-call MESSAGE row.
 *
 * Legend places rows by ACCUMULATION (`positions[i + 1] = positions[i] + size_i`), so a
 * mis-calibrated constant is not a margin: undershoot places the successor INSIDE the row,
 * overshoot leaves a literal gap. Both directions are pinned below against measurement.
 *
 * All heights MEASURED live in Chrome against the running web build (2026-07-29) by rendering the
 * real components at the default 850px content width: `ToolCallsGroupUnit*RowWithSessionCommon`
 * for the caps, `MessageViewWithSessionCommon` (standalone, `layoutContext: 'transcript'`) for the
 * message row. The harness reproduced the previously captured `feed_background` 33/28/34 and the
 * flat 50px feed message row exactly, which is what cross-validates it.
 */
describe('P · a tool row is sized by the chrome it actually paints', () => {
    const toolUnitItem = (kind: string, expanded: boolean): TranscriptRowShellItem => ({
        kind,
        id: `g1#${kind}`,
        groupId: 'g1',
        toolMessageId: 't0',
        toolMessageIds: ['t0', 't1', 't2'],
        expanded,
        hiddenCount: 7,
        createdAt: 1,
        seq: 1,
    } as unknown as TranscriptRowShellItem);

    const estimateFor = (
        item: TranscriptRowShellItem,
        toolCallsGroupChromeVariant: 'cards' | 'feed' | 'feed_background',
    ) => estimateTranscriptRowHeightFromContent({
        getMessageById: () => null,
        item,
        toolCallsGroupChromeVariant,
    });

    const MEASURED_FEED_TOOL_ROW_PX = 28;

    it('keeps the feed variants on their measured single-line caps', () => {
        expect(estimateFor(toolUnitItem('tool-group-tool', false), 'feed')).toBe(MEASURED_FEED_TOOL_ROW_PX);
        expect(estimateFor(toolUnitItem('tool-group-tool', false), 'feed_background')).toBe(MEASURED_FEED_TOOL_ROW_PX);
        // The chrome caps differ between the two feed variants; the group background adds 6px to
        // both the header and the footer (measured: feed 27/28, feed_background 33/34).
        expect(estimateFor(toolUnitItem('tool-group-header', false), 'feed')).toBe(27);
        expect(estimateFor(toolUnitItem('tool-group-footer', false), 'feed')).toBe(28);
        expect(estimateFor(toolUnitItem('tool-group-header', false), 'feed_background')).toBe(33);
        expect(estimateFor(toolUnitItem('tool-group-footer', false), 'feed_background')).toBe(34);
        // The "show N more" row is the same single-line cap in both (measured 28).
        expect(estimateFor(toolUnitItem('tool-group-expand', false), 'feed')).toBe(28);
        expect(estimateFor(toolUnitItem('tool-group-expand', false), 'feed_background')).toBe(28);
    });

    /**
     * Measured, and deliberately NOT an input: group expansion never changed a unit row's painted
     * height (3 chrome variants x 7 tool shapes x expanded/collapsed, all identical). Expansion
     * changes the row COUNT that `appendToolGroupUnits` emits, not any row's height — including
     * for a SUBAGENT tool row, which swaps renderer on expand
     * (`shouldRenderGroupedToolCallWithMessageView`) yet paints the same 28px timeline row in feed
     * mode because `MessageView` renders `ToolTimelineRow` there too.
     */
    it('does not change a tool row estimate when the group expands', () => {
        for (const variant of ['feed', 'feed_background'] as const) {
            expect(estimateFor(toolUnitItem('tool-group-tool', true), variant))
                .toBe(estimateFor(toolUnitItem('tool-group-tool', false), variant));
        }
    });

    /**
     * The deletion this module carries: `cards` mode disables grouping, so no `tool-group-*` row
     * and no `tool-calls-group`/`tool_calls` shape can ever be built while the variant is `cards`
     * (`appendToolGroupUnits` is their only producer and it is only reached from a grouped item).
     * A `cards` column in the cap table would be numbers no session can reach, so there is none —
     * the group shapes hand the row back to the renderer's own estimate instead. Re-enabling
     * grouping in `cards` mode therefore has to arrive with its own measurement; it cannot
     * silently inherit a feed cap or a fabricated card height.
     */
    it('has no calibration for tool-group rows in cards mode, because none can be built', () => {
        for (const kind of ['tool-group-header', 'tool-group-expand', 'tool-group-tool', 'tool-group-footer'] as const) {
            expect(estimateFor(toolUnitItem(kind, false), 'cards')).toBeUndefined();
        }
        const groupItem = {
            kind: 'tool-calls-group',
            id: 'g1',
            toolMessageIds: ['t0', 't1', 't2'],
            createdAt: 1,
        } as unknown as TranscriptRowShellItem;
        expect(estimateFor(groupItem, 'cards')).toBeUndefined();
        // ...and the feed variants are untouched by that deletion.
        expect(estimateFor(groupItem, 'feed_background')).toBe(33 + 34 + 3 * 28);
    });

    /**
     * The whole tool surface of `cards` mode: an ungrouped tool call renders through `MessageView`,
     * which paints a `ToolView` card there (`MessageView.tsx` chrome branch) instead of the
     * single-line `ToolTimelineRow` it paints in the feed.
     *
     * MEASURED 2026-07-29, `MessageViewWithSessionCommon` standalone at 850px, 19 tool-call
     * fixtures (Read/Bash/Edit/Write/Grep/Glob/TodoWrite/Task/WebFetch/MultiEdit, short and long
     * results). The same fixtures paint a flat 50px in either feed variant.
     */
    const MEASURED_CARDS_MESSAGE_ROW_PX = [
        74, 74, 132, 142, 150, 174, 186, 196, 196, 240, 247, 274, 292, 382, 548, 562, 562, 834, 966,
    ] as const;

    const toolMessage = {
        kind: 'tool-call',
        id: 'm1',
        localId: null,
        createdAt: 1,
        tool: { name: 'Read', state: 'completed', input: {}, createdAt: 1, startedAt: 1, completedAt: 2, description: null },
        children: [],
    } as unknown as Message;
    const messageItem = { kind: 'message', id: 'i1', messageId: 'm1' } as TranscriptRowShellItem;
    const estimateMessageFor = (variant: 'cards' | 'feed' | 'feed_background') => (
        estimateTranscriptRowHeightFromContent({
            getMessageById: () => toolMessage,
            item: messageItem,
            toolCallsGroupChromeVariant: variant,
        }) as number
    );

    it('sizes an ungrouped cards-mode tool message like the card it paints', () => {
        expect(estimateMessageFor('cards')).toBeGreaterThan(estimateMessageFor('feed'));
        expect(estimateMessageFor('feed')).toBe(estimateMessageFor('feed_background'));
    });

    /**
     * The bound the direction assertion above cannot give: Legend ACCUMULATES, so the number that
     * matters is not one row's error but the summed one. A constant far above the distribution is
     * a per-row GAP (5000px passed every other assertion in this file), one far below is a per-row
     * OVERLAP (the pre-P flat 56px compact constant, and the 240px mean of the GROUPED unit-row
     * distribution this branch never renders). Both are rejected by requiring the estimate to sit
     * inside the measured range AND to reproduce the measured total.
     */
    it('keeps the accumulated cards-mode content model unbiased over the measured card distribution', () => {
        const estimate = estimateMessageFor('cards');
        const measuredMin = Math.min(...MEASURED_CARDS_MESSAGE_ROW_PX);
        const measuredMax = Math.max(...MEASURED_CARDS_MESSAGE_ROW_PX);
        expect(estimate).toBeGreaterThanOrEqual(measuredMin);
        expect(estimate).toBeLessThanOrEqual(measuredMax);

        const measuredTotal = MEASURED_CARDS_MESSAGE_ROW_PX.reduce((total, px) => total + px, 0);
        const estimatedTotal = estimate * MEASURED_CARDS_MESSAGE_ROW_PX.length;
        // 5% of the measured content height, i.e. the constant must stay the sample's mean to
        // within ~16px; anything else is a systematic drift the accumulated model would carry.
        expect(Math.abs(estimatedTotal - measuredTotal) / measuredTotal).toBeLessThanOrEqual(0.05);
    });
});
