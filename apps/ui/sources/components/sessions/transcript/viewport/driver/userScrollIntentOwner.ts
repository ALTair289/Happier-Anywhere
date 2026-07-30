/**
 * Maximum gap after the last raw scroll input for the gesture to still count as physically
 * in progress. Trackpad/wheel momentum and browser smooth-scroll continuation emit frames
 * every ~16-100ms; a Legend replay/measurement burst arrives after a longer gap or with a
 * programmatic correction interleaved. Same value the DOM observation owner uses for its
 * inertia continuation, and the renderer for its own — one window, one owner.
 */
export const TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS = 320;

/**
 * A continuous, self-closing input phase. `drag` covers a native finger drag and a web
 * scrollbar-thumb drag (pointerdown in the scrollbar band until pointerup); `momentum`
 * covers a fling that chained off a real drag release.
 */
export type TranscriptUserScrollIntentGesture = 'drag' | 'momentum';

export type TranscriptUserScrollIntentOwner = Readonly<{
    /**
     * The ONE storage location for "when did the reader last express scroll intent".
     * Exposed with `MutableRef<number>` shape because it IS the ref the host already
     * threads into the bottom-follow, entry-restore, prepend and lifecycle consumers.
     * Producers: raw input handlers (host + renderer) and the classifier's
     * `web-user-scroll-intent-timestamp` lifecycle effect. There is no second copy.
     */
    readonly timestampRef: { current: number };
    /** True while a drag/momentum phase is open. */
    isGestureActive(): boolean;
    /**
     * True while the reader's hand is on the scroller: an open drag/momentum phase, or raw
     * scroll input within the bounded continuation window. This is the STATE-shaped fact that
     * pin suppression needs — an event timestamp alone cannot answer it for a scrollbar drag
     * (one pointerdown then silence for the whole drag), a held key, or an inertia tail that
     * outlives the last wheel event.
     */
    isLive(nowMs: number): boolean;
    /** Latest RAW scroll input timestamp; never a classifier derivation. */
    lastInputAtMs(): number;
    /**
     * Direction the reader last ASKED for (-1 toward older, +1 toward newer), or null when the
     * input carried none (a scrollbar-thumb press, a bare drag start). Needed because "input is
     * live" alone must never license attributing movement the reader did not ask for: at the top
     * clamp an upward wheel produces no movement while estimate churn pushes the offset DOWN, and
     * treating that as the reader's would abandon the anchor they are reading (live S-D, 2026-07-11).
     */
    lastInputDirection(): -1 | 1 | null;
    /** Record raw, unforgeable scroll input (wheel / drag / momentum / touch / keyboard). */
    recordInput(input: Readonly<{ atMs: number; direction?: -1 | 1 | null }>): void;
    /** Open or close a continuous gesture phase. Closing also records terminal input. */
    setGestureActive(input: Readonly<{
        active: boolean;
        atMs: number;
        gesture: TranscriptUserScrollIntentGesture;
    }>): void;
    /**
     * Revoke recorded input EVIDENCE at a command/data boundary (explicit jump, logical session
     * phase change) while leaving an OPEN gesture phase intact: a command issued mid-fling must not
     * pretend the finger left the screen.
     */
    revokeInputEvidence(): void;
    /** Full revoke, including any open gesture phase: session change / teardown. */
    clear(): void;
}>;

/**
 * ONE owner for "is the reader scrolling / does the reader still want the live tail".
 *
 * Before this owner the same question had three faces: a host timestamp ref
 * (`ChatListInternal`), a same-named renderer timestamp ref (`legendListRenderer`), and the
 * renderer's private `userDragActive`/`userMomentumActive` bits. The host's auto-pin guard
 * therefore could not see a web scrollbar drag at all (that gesture lives only in the
 * renderer), and the renderer could not see host-side keyboard/pointer intent. Pin
 * suppression was event-shaped (a timestamp that expires 250ms after an EVENT) while the
 * fact it needed is state-shaped (a gesture that is still in progress).
 *
 * Ownership split that remains, deliberately:
 * - THIS owner answers "does the reader have their hand on the scroller / did they just
 *   express scroll intent". It is fed only by unforgeable input and by the classifier's
 *   certified-movement effect.
 * - `resolveWebGenuineScrollMovement` keeps answering "is THIS scroll frame attributable to
 *   the user rather than to our own write" (the Q1-WEB-1 self-write exclusion). It is a
 *   per-frame attribution question, not a liveness question, and it stays single-owner.
 * - "Any interaction" (a bare tap) is NOT scroll intent and is deliberately not recorded
 *   here: an expansion commit keeps moving the offset for seconds after a toggling tap, and
 *   treating that as a detach strands the armed hold (live native S-C, 2026-07-11).
 */
export function createTranscriptUserScrollIntentOwner(): TranscriptUserScrollIntentOwner {
    const timestampRef = { current: Number.NEGATIVE_INFINITY };
    let lastRawInputAtMs = Number.NEGATIVE_INFINITY;
    let lastRawInputDirection: -1 | 1 | null = null;
    let dragActive = false;
    let momentumActive = false;

    const recordInput = (input: Readonly<{ atMs: number; direction?: -1 | 1 | null }>): void => {
        if (!Number.isFinite(input.atMs)) return;
        lastRawInputAtMs = input.atMs;
        lastRawInputDirection = input.direction ?? null;
        timestampRef.current = input.atMs;
    };

    return {
        timestampRef,
        isGestureActive() {
            return dragActive || momentumActive;
        },
        isLive(nowMs) {
            if (dragActive || momentumActive) return true;
            if (!Number.isFinite(nowMs)) return false;
            return nowMs - lastRawInputAtMs <= TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS;
        },
        lastInputAtMs() {
            return lastRawInputAtMs;
        },
        lastInputDirection() {
            return lastRawInputDirection;
        },
        recordInput,
        setGestureActive(input) {
            if (input.gesture === 'drag') {
                dragActive = input.active;
            } else {
                momentumActive = input.active;
            }
            // Both edges are input evidence: the press that opens a scrollbar drag and the
            // release that closes it are the reader acting on the scroller.
            recordInput({ atMs: input.atMs });
        },
        revokeInputEvidence() {
            timestampRef.current = Number.NEGATIVE_INFINITY;
            lastRawInputAtMs = Number.NEGATIVE_INFINITY;
            lastRawInputDirection = null;
        },
        clear() {
            timestampRef.current = Number.NEGATIVE_INFINITY;
            lastRawInputAtMs = Number.NEGATIVE_INFINITY;
            lastRawInputDirection = null;
            dragActive = false;
            momentumActive = false;
        },
    };
}
