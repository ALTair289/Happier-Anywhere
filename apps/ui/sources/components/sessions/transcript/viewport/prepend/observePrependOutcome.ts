import { planNativeTranscriptViewportAnchorMeasuredOffsetRestore } from '@/components/sessions/transcript/viewport/driver/transcriptNativeViewportAnchor';
import {
    resolveTranscriptViewportAnchorIndex,
    type TranscriptViewportAnchorResolvableItem,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';

/**
 * Default alignment tolerance for classifying a prepend as MVCP-preserved.
 * Mirrors the legacy `TRANSCRIPT_NATIVE_PREPEND_ANCHOR_RESTORE_ALIGNMENT_TOLERANCE_PX` constant.
 */
export const PREPEND_ANCHOR_ALIGNMENT_TOLERANCE_PX = 4;

/**
 * Residual tolerance for the corrector-covered classification (N2d.1). Wider than the write
 * alignment tolerance on purpose: when the vendor corrector demonstrably covered the commit
 * (correction-applied events in the transaction window), a small leftover misalignment is the
 * corrector-settle jitter family observed live (±20–50px follow-up corrections while freshly
 * materialized rows settle), and spending the single fallback on it trades an invisible drift
 * for a visible snap. Real partial coverage (hundreds of px, live-streaming churn) stays above
 * this bound and still takes the one fallback write.
 */
export const PREPEND_CORRECTOR_COVERED_RESIDUAL_TOLERANCE_PX = 48;

export type PrependAnchorKey = Readonly<{
    itemId: string;
    messageId?: string | null;
}>;

export type PrependCapturedAnchor = Readonly<{
    key: PrependAnchorKey;
    /** Anchor row top relative to the viewport top at capture time (px). */
    itemOffsetPx: number;
    capturedDataLength: number;
    capturedFirstItemId: string | null;
}>;

export type PrependPostCommitObservation = Readonly<{
    items: readonly TranscriptViewportAnchorResolvableItem[];
    getLayout: (index: number) => Readonly<{ y: number }> | undefined;
    absoluteScrollOffset: number;
    contentHeight: number;
    layoutHeight: number;
}>;

export type PrependOutcomeUnresolvableReason =
    | 'anchor-missing'
    | 'layout-not-ready'
    | 'identity-unchanged';

export type PrependOutcome =
    | Readonly<{ kind: 'mvcp-preserved'; observedItemOffsetPx: number; deltaPx: number; correctorCovered?: boolean }>
    | Readonly<{ kind: 'needs-fallback'; targetOffsetY: number; deltaPx: number }>
    | Readonly<{ kind: 'unresolvable'; reason: PrependOutcomeUnresolvableReason }>;

/**
 * FlashList offset-corrector activity recorded over the transaction window (N2d.1): the sum of
 * `correction-applied` diffs and how many corrections landed. Sourced from the vendor-patch hook
 * via `scroll/flashListOffsetCorrectionHook`.
 */
export type PrependCorrectorCoverage = Readonly<{
    appliedDiffTotalPx: number;
    eventCount: number;
}>;

function resolveCurrentFirstItemId(items: readonly TranscriptViewportAnchorResolvableItem[]): string | null {
    const id = items[0]?.id;
    return typeof id === 'string' ? id : null;
}

/**
 * Pure post-commit classifier for one native prepend transaction:
 * - `mvcp-preserved`: the anchor row sits within tolerance of its captured viewport offset (0 writes).
 *   With `correctorCoverage` (N2d.1), a misaligned anchor whose delta is explained by the
 *   corrector's applied diffs (|deltaPx − Σdiff| ≤ tolerance) is ALSO preserved
 *   (`correctorCovered: true`): the corrector adjusted contentOffset natively while our
 *   scroll-offset reading is fed by held scroll events, so the observed misalignment is exactly
 *   the correction the reading has not seen yet — writing the fallback on top of it is the
 *   double-correction flicker proven in N1.
 * - `needs-fallback`: the anchor survived but is misaligned and the corrector demonstrably did
 *   not cover it (no/partial coverage); carries the single corrective offset (1 write).
 * - `unresolvable`: no actionable observation (`identity-unchanged` = the prepend is not visible in
 *   this items snapshot yet → observe again later; `anchor-missing` = anchor not mappable to the
 *   committed data; `layout-not-ready` = observe again later).
 */
export function observePrependOutcome(params: Readonly<{
    capturedAnchor: PrependCapturedAnchor;
    postCommit: PrependPostCommitObservation;
    tolerancePx?: number;
    correctorCoverage?: PrependCorrectorCoverage;
}>): PrependOutcome {
    const { capturedAnchor, postCommit } = params;
    const tolerancePx = params.tolerancePx ?? PREPEND_ANCHOR_ALIGNMENT_TOLERANCE_PX;

    if (
        postCommit.items.length <= capturedAnchor.capturedDataLength &&
        resolveCurrentFirstItemId(postCommit.items) === capturedAnchor.capturedFirstItemId
    ) {
        return { kind: 'unresolvable', reason: 'identity-unchanged' };
    }

    const anchorIndex = resolveTranscriptViewportAnchorIndex({
        anchor: {
            itemId: capturedAnchor.key.itemId,
            messageId: capturedAnchor.key.messageId ?? null,
        },
        items: postCommit.items,
    });
    if (anchorIndex == null) {
        return { kind: 'unresolvable', reason: 'anchor-missing' };
    }

    const layout = postCommit.getLayout(anchorIndex);
    if (
        layout == null ||
        !Number.isFinite(layout.y) ||
        !Number.isFinite(postCommit.absoluteScrollOffset) ||
        !Number.isFinite(capturedAnchor.itemOffsetPx)
    ) {
        return { kind: 'unresolvable', reason: 'layout-not-ready' };
    }

    const observedItemOffsetPx = layout.y - postCommit.absoluteScrollOffset;
    const deltaPx = observedItemOffsetPx - capturedAnchor.itemOffsetPx;
    if (Math.abs(deltaPx) <= Math.max(0, tolerancePx)) {
        return { kind: 'mvcp-preserved', observedItemOffsetPx, deltaPx };
    }

    const coverage = params.correctorCoverage;
    if (coverage != null && coverage.eventCount > 0 && Number.isFinite(coverage.appliedDiffTotalPx)) {
        // Two reading states observed live: the scroll-offset reading may still be STALE (the
        // misalignment equals the not-yet-seen correction → residual = delta − Σdiff) or may
        // have CAUGHT UP (the residual is the observed delta itself). Either way, a residual
        // inside the settle-jitter tolerance means the corrector covered this commit: zero writes.
        const residualPx = Math.min(
            Math.abs(deltaPx),
            Math.abs(deltaPx - coverage.appliedDiffTotalPx),
        );
        if (residualPx <= PREPEND_CORRECTOR_COVERED_RESIDUAL_TOLERANCE_PX) {
            return { kind: 'mvcp-preserved', observedItemOffsetPx, deltaPx, correctorCovered: true };
        }
    }

    const fallbackPlan = planNativeTranscriptViewportAnchorMeasuredOffsetRestore({
        contentHeight: postCommit.contentHeight,
        itemLayoutY: layout.y,
        itemOffsetPx: capturedAnchor.itemOffsetPx,
        layoutHeight: postCommit.layoutHeight,
    });
    if (fallbackPlan.status !== 'planned') {
        return { kind: 'unresolvable', reason: 'layout-not-ready' };
    }

    return { kind: 'needs-fallback', targetOffsetY: fallbackPlan.targetOffsetY, deltaPx };
}
