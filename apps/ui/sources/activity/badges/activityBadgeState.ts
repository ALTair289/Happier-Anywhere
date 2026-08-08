/**
 * The value the badge channels render.
 *
 * The count itself is derived incrementally by
 * `createLocalActivityBadgeSnapshotSelector`, which maintains a per-session
 * attention cache so a wave only re-evaluates the sessions it moved. There is
 * deliberately no whole-account builder here: a second place that folds
 * sessions into a count would be a competing owner of the same decision.
 */
export type ActivityBadgeState = Readonly<{
    count: number;
    showNonNumericDot: boolean;
}>;
