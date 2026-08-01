import { getPendingMessageVisualState } from '@/components/sessions/pending/pendingMessageVisualState';
import { shouldClipPendingQueueContent } from '@/components/sessions/pending/pendingQueueContentClipping';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
// Type-only: the chrome variant is DECIDED by `resolveToolCallsGroupChromeVariant` in that module
// (the renderer's own owner) and threaded in by `ChatListInternal`. This estimate consumes the
// decision; it never re-derives one from the underlying settings.
import type { ToolCallsGroupChromeVariant } from '@/components/sessions/transcript/toolCalls/units/toolCallsGroupChrome';

import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import {
    TRANSCRIPT_GROWING_ROW_STATES,
    type TranscriptMeasurementReconciler,
} from './transcriptMeasurementReconciler';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

/**
 * Size ESTIMATE served to the list renderer's virtualization layer for rows it has
 * not yet measured (Legend `getEstimatedItemSize`, vendored @legendapp/list 3.3.3
 * patch): the app's own measured-height cache is the best predictor of a row's real
 * height — a prior EXACT measurement beats Legend's per-type average learning,
 * which is biased toward whichever rows rendered first (LegendApp/legend-list#492;
 * live scrollHeight-oscillation captures 2026-07-22/23: switch-back/reopen jiggle).
 * Unknown rows fall through (undefined) to Legend's per-type average / scalar estimate.
 *
 * A GROWING row's floor (`streaming`, `thinking`) is NOT a size: the reconciler
 * deliberately carries that floor across content shapes, so it is a lower bound on a
 * row whose content is still arriving, and the content estimate below tracks the live
 * text better. Every other row state is shrink-capable, and for those this estimate is
 * the row's own last measurement at this width/font — a real measurement, not a
 * prediction. It cannot come from the exact-height cache alone, because that cache is
 * stable-only and a row that never reaches `stable` (every `pending-action` row:
 * `pending-queue`, `pending-user-action`, `action-draft`, and every `tool-progress`
 * row) structurally cannot enter it.
 *
 * W-1: an estimate and a reservation are OPPOSITE contracts over that same measurement
 * and must not be read through one call. A reservation is a forcing, self-fulfilling
 * `minHeight` style, so it is released the instant a shrink-capable row's shape moves
 * (`isFloorShapeValid`) — otherwise a shrunk row strands blank space. An estimate is
 * discarded by that row's very next onLayout, so releasing it buys nothing and costs
 * everything: `ChatListInternal` wires the vendored Legend `getItemSizeVersion` to the
 * full signature key, so an OFFSCREEN row whose shape moves has its measured size
 * deleted and is re-sized from this estimate. Returning `undefined` there sent already
 * scrolled-past rows to the flat content heuristic below, which for a tool row is one compact
 * constant against a painted row measured at 50px in the activity feed and 74..966px in cards
 * (2026-07-29) — collapsing the content above the viewport and pulling the user's scroll
 * position backwards. `resolveLastMeasuredHeight` is therefore read for exactly the case the
 * reservation refuses.
 */
export function estimateTranscriptRowHeightFromCache(params: Readonly<{
    reconciler: TranscriptMeasurementReconciler;
    signature: TranscriptItemHeightValiditySignature;
}>): number | undefined {
    const reservation = params.reconciler.resolveReservation(params.signature);
    if (reservation?.kind === 'exact') return reservation.minHeight;
    // Consume the reconciler's set rather than re-listing the growing states here: it is the
    // single owner of that decision (`isFloorShapeValid` reads the same set), so a future state
    // cannot silently diverge between the reservation producer and this estimate consumer.
    if (TRANSCRIPT_GROWING_ROW_STATES.has(params.signature.rowState)) return undefined;
    if (reservation) return reservation.minHeight;
    return params.reconciler.resolveLastMeasuredHeight(params.signature);
}

// Conservative text-flow constants for rows never measured in this app run. Estimates
// only need to shrink first-visit error (a flat 240px scalar undercounted a real
// transcript by 53% in the live reopen capture 2026-07-23); measurement replaces them
// the moment a row mounts.
const ESTIMATE_ROW_BASE_PX = 32;
const ESTIMATE_LINE_HEIGHT_PX = 22;
const ESTIMATE_CHARS_PER_LINE = 72;
const ESTIMATE_COMPACT_ROW_PX = 56;
/**
 * Painted heights of the tool-group row shapes, per RENDERED CHROME VARIANT. Legend places rows
 * by ACCUMULATION, so an estimate that overshoots a row's painted height is not a harmless margin
 * — it is a literal gap under that row, and an undershoot is a literal OVERLAP.
 *
 * P (2026-07-29): these were a single flat set calibrated on the DEFAULT variant
 * (`activity_feed` + group background = `feed_background`), applied unconditionally. But
 * `toolViewTimelineChromeMode` is a user setting (`TranscriptSettingsView`), and in `cards` mode
 * a tool unit row does not paint a single-line timeline row at all — it paints a whole `ToolView`
 * card. A flat 28px against a real card is the undershoot direction, i.e. overlap.
 *
 * MEASURED live in Chrome against the running web build (2026-07-29), rendering the real row
 * components (`ToolCallsGroupUnit{Header,Expand,Tool,Footer}RowWithSessionCommon`) at the default
 * 850px content width. The `feed_background` column reproduces the previously captured 33/28/34
 * exactly, which is what cross-validates the harness against the live 2026-07-28 capture.
 *
 * | variant           | header | expand | tool | footer |
 * |-------------------|--------|--------|------|--------|
 * | `feed`            |   27   |   28   |  28  |   28   |
 * | `feed_background` |   33   |   28   |  28  |   34   |
 *
 * `cards` is deliberately NOT a key here: a tool GROUP cannot exist in that mode. Grouping is
 * gated on the same setting the variant is resolved from — `useChatListRootState` computes
 * `groupToolCalls = transcriptGroupToolCalls === true && toolViewTimelineChromeMode ===
 * 'activity_feed'`, while `resolveToolCallsGroupChromeVariant` returns `cards` exactly when that
 * mode is NOT `activity_feed`. With grouping off, `buildChatListItems` emits no
 * `tool-calls-group` item and `buildTranscriptTurns` emits no `tool_calls` turn content, so
 * `appendToolGroupUnits` (the only producer of `tool-group-*` rows) never runs. A `cards` column
 * would therefore be four numbers no session can reach; the group shapes return `undefined`
 * instead and fall through to the renderer's own estimate, so re-enabling grouping in `cards`
 * mode has to arrive with its own measurement rather than silently inheriting one.
 *
 * Group EXPANSION was measured across all three variants and 7 tool shapes and never changed a
 * unit row's painted height — expansion changes the row COUNT (`appendToolGroupUnits`), not any
 * row's height — so it is deliberately not an input here.
 */
const ESTIMATE_TOOL_ROW_PX = 28;
/**
 * One whole tool card, the shape a tool-call MESSAGE row paints in `cards` mode — the only tool
 * surface that mode has, since grouping is off there (see above). Its height is dominated by the
 * tool's own rendered body, which only that tool's renderer knows, so this is a central estimate
 * for a WIDE distribution rather than a precise height.
 *
 * MEASURED 2026-07-29 on the reachable path: `MessageViewWithSessionCommon` rendered standalone
 * (`layoutContext: 'transcript'`) at the default 850px content width, 19 tool-call fixtures
 * (Read/Bash/Edit/Write/Grep/Glob/TodoWrite/Task/WebFetch/MultiEdit, short and long results):
 * 74, 74, 132, 142, 150, 174, 186, 196, 196, 240, 247, 274, 292, 382, 548, 562, 562, 834, 966 —
 * min 74, median 240, mean 328, max 966. The same fixtures paint a flat 50px in either feed
 * variant, which is what cross-validates the harness.
 *
 * The MEAN is the constant because Legend ACCUMULATES (`positions[i + 1] = positions[i] + size_i`):
 * only a mean keeps the summed content model unbiased over the distribution, which is what decides
 * where an unmeasured row above the viewport places everything below it. (The previous 240 was the
 * mean of the GROUPED unit-row distribution — a shape this branch never renders.) It is superseded
 * by the row's own onLayout the moment it mounts; taller cards still undershoot until measured.
 */
const ESTIMATE_TOOL_CARD_ROW_PX = 328;

/**
 * The `pending-queue` row — the row a SEND creates — sized from the chrome it actually paints.
 *
 * J/D2 (2026-07-30). The previous model summed `estimateTextBlockPx` over every queued and
 * discarded message and floored at the compact constant. That is the height of the SCROLL CONTENT,
 * not of the row, and it was wrong in both directions at once:
 *
 *   - it undershot a single short send. NATIVE MEASUREMENT (iOS simulator, rAF sampler on the
 *     mounted LegendList fiber, `.project/reviews/2026-07-30-send-jiggle-and-anchor/J-send-jiggle.md`):
 *     one short queued message paints **68.625px**, and the old model returned the 56px floor —
 *     a 12.6px UNDERSHOOT, i.e. a literal overlap, re-applied on every pending-record tick because
 *     the row's measured size was being deleted each time (see `transcriptRowShellSignature`).
 *   - it overshot everything else without bound. `PendingMessagesTranscriptBlock` renders its
 *     messages inside a `ScrollView` whose box is `maxHeight: transcriptPendingQueueMaxHeightPx`
 *     (account default **80**), so three 300-char messages paint ~94px while the old model returned
 *     ~438 — a ~340px phantom gap under the tail row during exactly the send the user is watching.
 *
 * DERIVATION, cross-validated against that one measurement. The block paints
 * `TranscriptSeparatorRow` (`padding="none"`, `chipChrome="minimal"`) + optionally the
 * terminal-draft notice + the capped `ScrollView` (`contentContainerStyle.paddingTop: 6`). Each
 * message row is `userMessageWrapper` (`paddingBottom: 8`) wrapping `userMessageBubble`
 * (`paddingVertical: 8` ×2) around markdown at `transcriptMarkdownTextStyle.lineHeight`:
 *
 *   header 14.625 + [ paddingTop 6 + wrapper 8 + bubble 16 + one 24px line ] = 68.625  ✓ measured
 *
 * so `PENDING_QUEUE_HEADER_ROW_PX` is the measured total minus the source-derived content
 * (68.625 − 54). Everything else here is read off those same styles and is therefore DERIVED, not
 * measured: the two-line header (only when queued and discarded rows coexist), the per-message
 * notices, and the discarded section. They sit INSIDE the capped scroll box, so for any queue big
 * enough to reach the cap they cannot move the answer at all.
 *
 * D (2026-08-01): the cap is now conditional. A block holding exactly one queued utterance is the
 * SEND crossover and does not clip, so this estimate must follow the same rule from the same owner
 * — see `shouldClipPendingQueueContent`. The per-message line clamp is gated by that same
 * predicate, which is why it has never needed modelling here: it is only ever active for a queue
 * whose content already exceeds the cap.
 */
const PENDING_QUEUE_HEADER_ROW_PX = 14.625;
/** Header grows a second 12px line when the "Discarded (n)" subtitle is present (`gap: 2`). */
const PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX = 31;
const PENDING_QUEUE_SCROLL_PADDING_TOP_PX = 6;
/** `userMessageBubble` paddingVertical 8 ×2 + `userMessageWrapper` paddingBottom 8. */
const PENDING_QUEUE_MESSAGE_CHROME_PX = 24;
/** `blockedDeliveryNotice`: margins 4+2, paddingVertical 3 ×2, border 1 ×2, 14px text line. */
const PENDING_QUEUE_MESSAGE_NOTICE_PX = 26;
/** Same notice with the inline retry `Pressable` (`minHeight: 24`) instead of a text line. */
const PENDING_QUEUE_MESSAGE_RETRY_NOTICE_PX = 36;
/** `nonSteerableNotice` — the one notice rendered OUTSIDE (above) the capped scroll box. */
const PENDING_QUEUE_TERMINAL_DRAFT_NOTICE_PX = 40;
/** Discarded section: container margin 4, title 6+14.3, subtitle 4+14.3, list margin 10. */
const PENDING_QUEUE_DISCARDED_SECTION_PX = 53;
/** "Discarded" label (marginTop 6 + 14.3px line) under a discarded bubble. */
const PENDING_QUEUE_DISCARDED_LABEL_PX = 20;
/** `discardedReason` line (marginTop 3 + 14.3px line). */
const PENDING_QUEUE_DISCARDED_REASON_PX = 17;
const PENDING_QUEUE_SCROLL_MAX_HEIGHT_PX = settingsDefaults.transcriptPendingQueueMaxHeightPx;

function estimatePendingQueueTextPx(message: Pick<PendingMessage, 'text' | 'displayText'>): number {
    // `displayText ?? text` is the string the block renders (`PendingMessagesTranscriptBlock`); a
    // message with a distinct display form is otherwise sized from text it never paints.
    const rendered = (message.displayText ?? message.text) ?? '';
    let newlines = 0;
    for (let i = 0; i < rendered.length; i += 1) {
        if (rendered.charCodeAt(i) === 10) newlines += 1;
    }
    const lines = Math.max(1, newlines + Math.ceil(rendered.length / ESTIMATE_CHARS_PER_LINE));
    return lines * transcriptMarkdownTextStyle.lineHeight;
}

function estimatePendingQueueRowPx(item: Extract<TranscriptRowShellItem, { kind: 'pending-queue' }>): number {
    let scrollContentPx = PENDING_QUEUE_SCROLL_PADDING_TOP_PX;
    let hasTerminalDraftNotice = false;
    for (const pendingMessage of item.pendingMessages) {
        scrollContentPx += PENDING_QUEUE_MESSAGE_CHROME_PX + estimatePendingQueueTextPx(pendingMessage);
        // The canonical owner of what chrome a pending row paints. Its session-runtime inputs are
        // not reachable from a pure size estimate, so a `queued_behind_turn` wait notice is NOT
        // modelled — it is absorbed by the cap for any queue that reaches it, and superseded by the
        // row's own onLayout otherwise.
        // D (2026-08-01) RESIDUAL, stated rather than engineered around: an UNCLIPPED single
        // utterance no longer has a cap to absorb that notice, so a message queued behind an active
        // turn estimates 26px short until its own onLayout lands. It is one frame in one
        // runtime-derived state, and `transcriptRowShellSignature` deliberately does not key on that
        // state, so the row's measured height is never deleted because of it. Threading session
        // runtime into a pure size estimate to model a notice onLayout corrects in the same commit
        // buys a mechanism, not a fix.
        const visualState = getPendingMessageVisualState(pendingMessage);
        if (visualState.kind === 'send_failed') {
            scrollContentPx += PENDING_QUEUE_MESSAGE_RETRY_NOTICE_PX;
        } else if (visualState.kind === 'blocked' || visualState.kind === 'delivery_uncertain') {
            scrollContentPx += PENDING_QUEUE_MESSAGE_NOTICE_PX;
            if (visualState.deliveryBlockedReason === 'terminal_composer_draft') hasTerminalDraftNotice = true;
        }
    }
    if (item.discardedMessages.length > 0) {
        scrollContentPx += PENDING_QUEUE_DISCARDED_SECTION_PX;
        for (const discardedMessage of item.discardedMessages) {
            scrollContentPx += PENDING_QUEUE_MESSAGE_CHROME_PX
                + estimatePendingQueueTextPx(discardedMessage)
                + PENDING_QUEUE_DISCARDED_LABEL_PX
                + (discardedMessage.discardedReason ? PENDING_QUEUE_DISCARDED_REASON_PX : 0);
        }
    }
    const headerPx = item.pendingMessages.length > 0 && item.discardedMessages.length > 0
        ? PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX
        : PENDING_QUEUE_HEADER_ROW_PX;
    // NOT a ceiling on a position-bearing value (see C-1 above): this is the block's OWN painted
    // bound, and only when the block actually clips (`shouldClipPendingQueueContent` is the single
    // owner of that decision — a disagreement with the renderer is a literal gap or overlap under
    // the tail). The `ScrollView` carries `maxHeight`, so content past it is scrolled, never
    // painted. The account default is modelled because a pure estimate cannot read the setting; a
    // user who raises `transcriptPendingQueueMaxHeightPx` (or expands the queue, which is a
    // post-measurement interaction) undershoots until that row's next onLayout, instead of
    // overshooting without end.
    const scrollBoxPx = shouldClipPendingQueueContent({
        pendingCount: item.pendingMessages.length,
        discardedCount: item.discardedMessages.length,
    })
        ? Math.min(scrollContentPx, PENDING_QUEUE_SCROLL_MAX_HEIGHT_PX)
        : scrollContentPx;
    return headerPx + (hasTerminalDraftNotice ? PENDING_QUEUE_TERMINAL_DRAFT_NOTICE_PX : 0) + scrollBoxPx;
}

type ToolGroupUnitRowHeights = Readonly<{
    header: number;
    expand: number;
    tool: number;
    footer: number;
}>;

type ToolCallsGroupFeedChromeVariant = Exclude<ToolCallsGroupChromeVariant, 'cards'>;

const TOOL_GROUP_UNIT_ROW_PX_BY_CHROME_VARIANT: Readonly<Record<ToolCallsGroupFeedChromeVariant, ToolGroupUnitRowHeights>> = {
    feed: { header: 27, expand: 28, tool: ESTIMATE_TOOL_ROW_PX, footer: 28 },
    feed_background: { header: 33, expand: 28, tool: ESTIMATE_TOOL_ROW_PX, footer: 34 },
};

/** `undefined` for `cards`: that mode builds no tool-group rows at all (see the table above). */
function resolveToolGroupUnitRowHeights(
    chromeVariant: ToolCallsGroupChromeVariant,
): ToolGroupUnitRowHeights | undefined {
    if (chromeVariant === 'cards') return undefined;
    return TOOL_GROUP_UNIT_ROW_PX_BY_CHROME_VARIANT[chromeVariant];
}

function estimateTextBlockPx(text: string): number {
    let newlines = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) newlines += 1;
    }
    const lines = Math.max(1, newlines + Math.ceil(text.length / ESTIMATE_CHARS_PER_LINE));
    return ESTIMATE_ROW_BASE_PX + lines * ESTIMATE_LINE_HEIGHT_PX;
}

function estimateMessagePx(message: Message | null, chromeVariant: ToolCallsGroupChromeVariant): number {
    if (!message) return ESTIMATE_COMPACT_ROW_PX;
    if (message.kind === 'user-text' || message.kind === 'agent-text') {
        return estimateTextBlockPx(message.text);
    }
    // The whole tool surface of `cards` mode, since grouping is off there. Measured 2026-07-29: a
    // standalone `MessageView` tool row is 50px in either feed variant (the compact constant is
    // 6px over, left alone) but 74..966px in `cards` — the undershoot direction, and the one
    // accumulation turns into overlap.
    if (message.kind === 'tool-call' && chromeVariant === 'cards') {
        return ESTIMATE_TOOL_CARD_ROW_PX;
    }
    return ESTIMATE_COMPACT_ROW_PX;
}

/**
 * Content-aware size estimate for rows with no prior measurement: text-bearing rows
 * scale with their real text length instead of a flat scalar, so a giant markdown
 * turn no longer collapses the renderer's content model to a fraction of its true
 * height (the estimate-vs-measured relayout oscillation on reopen/switch-back).
 * Non-text and unknown item shapes fall through to the renderer's own estimate.
 *
 * C-1: this value is a POSITION, so it carries no ceiling. Legend accumulates
 * (`positions[i + 1] = positions[i] + size_i`), which is why an overshoot is a literal gap under a
 * row (see `ESTIMATE_TOOL_ROW_PX`) — and, inverted, why an undershoot is a literal OVERLAP. A
 * ceiling guarantees undershoot for every row taller than it, unconditionally. Live web capture
 * 2026-07-28 (`cmrxjkh2v0vintmk4445ywy9s`): a 21,849px markdown message was sized by the former
 * `ESTIMATE_MAX_ROW_PX = 20_000`, so the next row was placed at `A.top + 20000` and painted 1,849px
 * INSIDE it, with that same 1,849px re-surfacing as a phantom tail below the last row. Every box in
 * that capture matched its DOM height exactly: the heights were right and only the ceiling was wrong.
 * A 21,849px message is legitimate content (a very long markdown turn), so the estimate accommodates
 * the real height instead of bounding it — and it is superseded by that row's own onLayout anyway.
 */
export function estimateTranscriptRowHeightFromContent(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    item: TranscriptRowShellItem;
    /**
     * Which chrome the tool rows in this session actually paint, as decided by
     * `resolveToolCallsGroupChromeVariant` — the renderer's own owner. REQUIRED so the compiler,
     * not a default, guarantees the live call site keeps threading it: the previous
     * default-when-omitted parameter on this function ended up exercised only by tests.
     */
    toolCallsGroupChromeVariant: ToolCallsGroupChromeVariant;
}>): number | undefined {
    const { item, toolCallsGroupChromeVariant } = params;
    const unitRowHeights = resolveToolGroupUnitRowHeights(toolCallsGroupChromeVariant);
    if (item.kind === 'message') {
        return estimateMessagePx(params.getMessageById(item.messageId), toolCallsGroupChromeVariant);
    }
    if (item.kind === 'pending-queue') {
        return estimatePendingQueueRowPx(item);
    }
    // Per-unit rows, one cap each. They are the ONLY tool-group shape this estimate can be asked
    // about: `useTranscriptItemsPipeline` runs `buildTranscriptTurnUnits` unconditionally over
    // every projection item, and that function consumes every `turn` and `tool-calls-group` item
    // into header/expand/tools/footer units, so neither shape survives into `listData` — the array
    // `getEstimatedItemSize` is called against. Their calibration is what accumulation gaps are
    // made of.
    if (item.kind === 'tool-group-tool') return unitRowHeights?.tool;
    if (item.kind === 'tool-group-expand') return unitRowHeights?.expand;
    if (item.kind === 'tool-group-header') return unitRowHeights?.header;
    if (item.kind === 'tool-group-footer') return unitRowHeights?.footer;
    if (
        item.kind === 'pending-user-action'
        || item.kind === 'action-draft'
        || item.kind === 'fork-divider'
    ) {
        return ESTIMATE_COMPACT_ROW_PX;
    }
    return undefined;
}
