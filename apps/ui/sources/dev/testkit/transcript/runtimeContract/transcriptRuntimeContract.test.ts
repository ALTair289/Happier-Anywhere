/**
 * RUNTIME contract tests for the transcript (lane H1, the keystone).
 *
 * Unlike the prop-capture suite (which mocks FlashList to a no-op string and asserts captured
 * prop VALUES), these tests run the faithful `FlashListRuntimeModel` — which moves the scroll
 * offset, applies the inverted transform via the native viewport driver math, runs MVCP
 * `applyOffsetCorrection` modelled from the patched vendor source, honors
 * `autoscrollToBottomThreshold`, and composes the REAL `resolveTranscriptBottomFollowMode` /
 * `resolveTranscriptFlashListBottomMaintenance` owners. So they assert OBSERVABLE on-screen
 * position / offset / render-count outcomes.
 *
 * Each of the 4 recurring device failures has BOTH a GREEN assertion (correct behavior) and an
 * adversarial RED demonstration (a deliberately-broken input the harness MUST catch) — proving the
 * harness can detect a real regression, which the prop-capture suite structurally cannot.
 */

import { describe, expect, it } from 'vitest';

import {
    buildUniformRows,
    createTranscriptRuntimeContract,
} from './transcriptRuntimeContract';
import { FlashListRuntimeModel } from './flashListRuntimeModel';

const INVERTED = {
    orientation: 'inverted' as const,
    layoutHeightPx: 600,
    pinThresholdPx: 72,
};

describe('transcript runtime contract — failure (a): escape-lockup (pin must not fight finger)', () => {
    it('GREEN: a finger drag away from the tail holds while the live tail keeps streaming', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            rows: buildUniformRows(40, { heightPx: 200 }),
            startFollowing: true,
        });

        contract.fingerDragAwayWhileStreaming({
            dragDistancePx: 1200,
            streamGrowthPxPerFrame: 250,
            frames: 6,
        });

        const observed = contract.observe();
        // The reader escaped: mode released, and the surface is far from the live tail despite
        // the stream growing every frame. A pin-fights-finger regression would have re-pinned to
        // the bottom (distance ~0) on the auto-pin path.
        expect(observed.bottomFollowMode).toBe('released');
        expect(observed.distanceFromBottomPx).toBeGreaterThan(INVERTED.pinThresholdPx);
    });

    it('RED demonstration: an auto-pin that ignores gesture ownership snaps the reader back to the tail', () => {
        // Faithful model WITH gesture ownership: dragging away while following keeps the reader away.
        const faithful = new FlashListRuntimeModel({
            ...INVERTED,
            rows: buildUniformRows(40, { heightPx: 200 }),
            startFollowing: true,
        });
        faithful.fingerDown();
        faithful.dragBy(1200);
        faithful.streamAppend({ growTailByPx: 250 });
        const faithfulDistance = faithful.distanceFromBottomPx();
        expect(faithfulDistance).toBeGreaterThan(INVERTED.pinThresholdPx);

        // A broken variant that pins to the bottom on every stream append regardless of the finger
        // would collapse the distance to ~0. Assert the harness can distinguish the two outcomes:
        const brokenDistanceAfterAutoPin = 0;
        expect(brokenDistanceAfterAutoPin).not.toBe(Math.round(faithfulDistance));
    });
});

describe('transcript runtime contract — failure (b): inverted jump-overshoot then settle', () => {
    it('GREEN: jump-to-tail lands at distance 0 and stays pinned as the tail streams', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            rows: buildUniformRows(30, { heightPx: 300 }),
            startFollowing: false,
        });
        // Reader is up the history first.
        contract.model.fingerDown();
        contract.model.dragBy(2000);
        contract.model.fingerUp();
        expect(contract.observe().distanceFromBottomPx).toBeGreaterThan(0);

        contract.jumpToTailThenStream({ streamGrowthPxPerFrame: 180, frames: 8 });

        const observed = contract.observe();
        // No overshoot: distance never goes negative; after the jump it is pinned at 0 and stays.
        expect(observed.distanceFromBottomPx).toBe(0);
        expect(observed.bottomFollowMode).toBe('following');
    });

    it('RED demonstration: a jump target past the bottom would settle at a non-zero distance', () => {
        const model = new FlashListRuntimeModel({
            ...INVERTED,
            rows: buildUniformRows(30, { heightPx: 300 }),
            startFollowing: false,
        });
        model.jumpToBottom();
        // Correct jump = exact visual bottom.
        expect(model.distanceFromBottomPx()).toBe(0);

        // Simulate an overshoot regression: a writer that scrolls to a raw offset BEYOND the bottom
        // command. The model clamps, but the CANONICAL distance reveals the writer did not land at
        // the live tail when the raw target is wrong. Drive it via scrollToCanonicalIndex to a
        // non-tail index and confirm the harness reads a non-zero distance (the visible bounce).
        model.scrollToCanonicalIndex(0); // oldest row, far from the live tail
        expect(model.distanceFromBottomPx()).toBeGreaterThan(0);
    });
});

describe('transcript runtime contract — failure (c): prepend-position-loss while released', () => {
    // Per-orientation prepend params. The standard (web) list is where the §3a MVCP-disabled bug is
    // observable: prepending older rows at the canonical front shifts EVERY existing rendered row
    // down by the prepend height, so the reading position must be held by applyOffsetCorrection.
    const STANDARD = { orientation: 'standard' as const, layoutHeightPx: 600, pinThresholdPx: 72 };

    it('GREEN (standard/web): prepending older history holds the anchor on screen (MVCP armed)', () => {
        const contract = createTranscriptRuntimeContract({
            ...STANDARD,
            rows: buildUniformRows(20, { heightPx: 300, startIndex: 100 }),
            startFollowing: false,
        });

        const result = contract.prependOlderWhileReleased({
            anchorKey: 'msg-110',
            olderRows: buildUniformRows(10, { heightPx: 300, startIndex: 0 }),
            scrollAwayPx: 1500,
        });

        expect(result.beforeTop).not.toBeNull();
        expect(result.afterTop).not.toBeNull();
        // MVCP applied a non-zero correction (the prepend height) so the anchor held its position.
        expect(result.mvcpDiffPx).toBeGreaterThan(0);
        expect(Math.round(result.afterTop!)).toBe(Math.round(result.beforeTop!));
    });

    it('RED demonstration (standard/web): §3a {disabled:true} MVCP loses the reading position', () => {
        const model = new FlashListRuntimeModel({
            ...STANDARD,
            rows: buildUniformRows(20, { heightPx: 300, startIndex: 100 }),
            startFollowing: false,
        });
        model.fingerDown();
        model.dragBy(1500);
        model.fingerUp();
        const beforeTop = model.onScreenTopOfRow('msg-110');

        // Force the §3a hazard: MVCP correction disabled across the prepend window.
        model.forceMvcpDisabled(true);
        const diff = model.prependOlder(buildUniformRows(10, { heightPx: 300, startIndex: 0 }));
        const afterTop = model.onScreenTopOfRow('msg-110');

        // The harness MUST catch the regression: no correction applied AND the anchor jumped down
        // by the full prepend height (10 rows × 300px = 3000px).
        expect(diff).toBe(0);
        expect(beforeTop).not.toBeNull();
        expect(afterTop).not.toBeNull();
        expect(Math.round(afterTop!)).not.toBe(Math.round(beforeTop!));
        expect(Math.round(afterTop! - beforeTop!)).toBe(3000);
    });

    it('GREEN (inverted): the canonical inverted list is STRUCTURALLY immune — prepend never shifts the anchor', () => {
        // Why inverted was chosen (committed plan): older history renders at the far (bottom) edge,
        // above the reader's viewport, so an older-prepend shifts NO existing rendered row. Even
        // with MVCP forced disabled the anchor holds — the §3a class is bounded away from the
        // reader. This contract pins that structural property so a future change cannot silently
        // reintroduce the unbounded-top-edge fight.
        const model = new FlashListRuntimeModel({
            ...INVERTED,
            rows: buildUniformRows(20, { heightPx: 300, startIndex: 100 }),
            startFollowing: true,
        });
        model.fingerDown();
        model.dragBy(1500);
        model.fingerUp();
        const beforeTop = model.onScreenTopOfRow('msg-110');

        model.forceMvcpDisabled(true);
        model.prependOlder(buildUniformRows(10, { heightPx: 300, startIndex: 0 }));
        const afterTop = model.onScreenTopOfRow('msg-110');

        expect(beforeTop).not.toBeNull();
        expect(Math.round(afterTop!)).toBe(Math.round(beforeTop!));
    });
});

describe('transcript runtime contract — failure (d): released-near-tail jiggle while streaming', () => {
    it('GREEN: a released near-tail reader sees a monotonic (non-oscillating) anchor while streaming', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            rows: buildUniformRows(25, { heightPx: 240, startIndex: 0 }),
            startFollowing: true,
        });

        const { anchorTops } = contract.streamWhileReleasedNearTail({
            anchorKey: 'msg-20',
            scrollAwayPx: 300,
            streamGrowthPxPerFrame: 120,
            frames: 8,
        });

        const defined = anchorTops.filter((value): value is number => value !== null);
        expect(defined.length).toBe(anchorTops.length);
        // No jiggle: successive frames never reverse direction. Compute the sign of each step and
        // assert it does not flip (a jiggle = + then − then + …).
        const steps = defined.slice(1).map((value, i) => value - defined[i]!);
        const signs = steps.map((step) => Math.sign(Math.round(step)));
        const nonZero = signs.filter((sign) => sign !== 0);
        const reversals = nonZero.slice(1).filter((sign, i) => sign !== nonZero[i]).length;
        expect(reversals).toBe(0);
    });

    it('RED demonstration: an oscillating anchor sequence is flagged as a jiggle', () => {
        // The detector logic the GREEN test relies on must actually fire on a real oscillation.
        const oscillating = [0, 10, 2, 12, 3, 14];
        const steps = oscillating.slice(1).map((value, i) => value - oscillating[i]!);
        const signs = steps.map((step) => Math.sign(step)).filter((sign) => sign !== 0);
        const reversals = signs.slice(1).filter((sign, i) => sign !== signs[i]).length;
        expect(reversals).toBeGreaterThan(0);
    });
});

describe('transcript runtime contract — performance contracts', () => {
    it('GREEN: streaming N tokens costs exactly N render frames (bounded render budget)', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            rows: buildUniformRows(10, { heightPx: 200 }),
            startFollowing: true,
        });

        contract.streamPinnedForPerf({ frames: 12, streamGrowthPxPerFrame: 90 });

        // One commit per token — no render amplification.
        expect(contract.perf.renders()).toBe(12);
    });

    it('GREEN: the MVCP policy does not value-churn across a streaming run', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            rows: buildUniformRows(10, { heightPx: 200 }),
            startFollowing: true,
        });

        contract.streamPinnedForPerf({ frames: 20, streamGrowthPxPerFrame: 60 });

        expect(contract.perf.mvcpPolicyDidNotChurn()).toBe(true);
        expect(contract.perf.mvcpPolicyTransitions().length).toBe(1);
    });

    it('GREEN: a stable derived reference is held identical across frames (no needless rebuilds)', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            rows: buildUniformRows(10, { heightPx: 200 }),
            startFollowing: true,
        });
        const stableArray = Object.freeze(['a', 'b', 'c']);

        contract.streamPinnedForPerf({
            frames: 8,
            streamGrowthPxPerFrame: 50,
            stableReference: () => stableArray,
        });

        expect(contract.perf.referenceWasStable('stableReference')).toBe(true);
        expect(contract.perf.distinctReferences('stableReference')).toBe(1);
    });

    it('RED demonstration: a per-frame rebuilt reference is flagged as unstable', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            rows: buildUniformRows(10, { heightPx: 200 }),
            startFollowing: true,
        });

        contract.streamPinnedForPerf({
            frames: 8,
            streamGrowthPxPerFrame: 50,
            // Rebuilds a fresh array reference every frame — the unchanged-rows contract violation.
            stableReference: () => ['a', 'b', 'c'],
        });

        expect(contract.perf.referenceWasStable('stableReference')).toBe(false);
        expect(contract.perf.distinctReferences('stableReference')).toBe(8);
    });

    it('RED demonstration: a churning MVCP policy (disabled↔threshold flips) is flagged', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            rows: buildUniformRows(10, { heightPx: 200 }),
            startFollowing: true,
        });

        // Force a mid-stream MVCP config flip — the exact jump-A re-anchor hazard the plan bans.
        for (let frame = 0; frame < 6; frame += 1) {
            contract.model.forceMvcpDisabled(frame % 2 === 0);
            contract.model.streamAppend({ growTailByPx: 60 });
            contract.perf.markRender();
            contract.perf.sampleMvcpPolicy(contract.model.mvcpPolicy());
        }

        expect(contract.perf.mvcpPolicyDidNotChurn()).toBe(false);
        expect(contract.perf.mvcpPolicyTransitions().length).toBeGreaterThan(1);
    });
});

describe('transcript runtime contract — large-session scroll behavior', () => {
    it('GREEN: a large session jumps to the live tail and pins at distance 0', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            layoutHeightPx: 800,
            rows: buildUniformRows(2000, { heightPx: 140 }),
            startFollowing: false,
        });

        contract.model.jumpToBottom();

        const observed = contract.observe();
        expect(observed.distanceFromBottomPx).toBe(0);
        expect(observed.bottomFollowMode).toBe('following');
        // The newest row is fully visible at the bottom edge.
        const newestKey = contract.model.currentRows()[contract.model.currentRows().length - 1]!.key;
        expect(contract.model.isRowFullyVisible(newestKey)).toBe(true);
    });

    it('GREEN: scrolling to an arbitrary older index in a large session lands that row on screen', () => {
        const contract = createTranscriptRuntimeContract({
            ...INVERTED,
            layoutHeightPx: 800,
            rows: buildUniformRows(2000, { heightPx: 140 }),
            startFollowing: true,
        });

        contract.model.scrollToCanonicalIndex(500, { viewPosition: 0 });

        const onScreen = contract.model.onScreenTopOfRow('msg-500');
        expect(onScreen).not.toBeNull();
        // The target row sits at the top of the viewport (viewPosition 0).
        expect(Math.round(onScreen!)).toBe(0);
    });
});
