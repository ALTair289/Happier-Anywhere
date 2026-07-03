export type JumpToBottomAffordancePresentation = 'standard' | 'activity';

export type JumpToBottomAffordanceState = Readonly<{
    count: number;
    isVisible: boolean;
    presentation: JumpToBottomAffordancePresentation;
}>;

const HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE: JumpToBottomAffordanceState = {
    count: 0,
    isVisible: false,
    presentation: 'standard',
};

function normalizeNonNegativeInteger(value: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

export function resolveJumpToBottomAffordanceState(params: Readonly<{
    distanceFromBottom: number;
    enabled: boolean;
    /**
     * Target-window mode with unloaded newer content: the session's live tail is below the
     * rendered window, so local pin/distance facts cannot justify hiding the affordance.
     */
    hasMoreNewerBeyondRenderedWindow?: boolean;
    isPinned: boolean;
    minNewActivityCount: number;
    newActivityCount: number;
    revealThresholdPx: number;
}>): JumpToBottomAffordanceState {
    if (!params.enabled) return HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE;
    if (params.hasMoreNewerBeyondRenderedWindow === true) {
        const windowNewActivityCount = normalizeNonNegativeInteger(params.newActivityCount);
        const windowMinNewActivityCount = Math.max(1, normalizeNonNegativeInteger(params.minNewActivityCount));
        const hasWindowActivityBadge = windowNewActivityCount >= windowMinNewActivityCount;
        return {
            count: hasWindowActivityBadge ? windowNewActivityCount : 0,
            isVisible: true,
            presentation: 'standard',
        };
    }
    if (params.isPinned) return HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE;

    const distanceFromBottom = normalizeNonNegativeInteger(params.distanceFromBottom);
    const revealThresholdPx = normalizeNonNegativeInteger(params.revealThresholdPx);
    const minNewActivityCount = Math.max(1, normalizeNonNegativeInteger(params.minNewActivityCount));
    const newActivityCount = normalizeNonNegativeInteger(params.newActivityCount);
    const hasNewActivityBadge = newActivityCount >= minNewActivityCount;
    const hasStandardReveal = distanceFromBottom >= revealThresholdPx;

    if (!hasStandardReveal && !hasNewActivityBadge) {
        return HIDDEN_JUMP_TO_BOTTOM_AFFORDANCE;
    }

    return {
        count: hasNewActivityBadge ? newActivityCount : 0,
        isVisible: true,
        presentation: hasStandardReveal ? 'standard' : 'activity',
    };
}
