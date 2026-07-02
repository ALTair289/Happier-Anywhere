/**
 * Ergonomic scenario surface for the transcript device/perf contract harness (lane H1).
 *
 * This is the layer Phase 1–3 lanes plug into: it wraps the faithful `FlashListRuntimeModel`
 * (which composes the REAL bottom-follow + maintenance owners) plus the `TranscriptPerfContractTracker`
 * into a single driver with named, reusable scenario builders for the 4 recurring device failures
 * and the performance contracts. Each scenario reads the OBSERVABLE on-screen position / offset /
 * render-count outcome — never a captured prop object.
 *
 * Adding a scenario = add a method here (or compose the primitives `model` + `perf` directly in a
 * test). The committed plan's G3 guardrail ("no owner moves without a runtime pin") is satisfied by
 * pinning new behavior through this surface before a Phase 1–3 lane moves the owner.
 */

import {
    FlashListRuntimeModel,
    type FlashListRuntimeModelOptions,
    type RuntimeModelObservation,
    type RuntimeModelRow,
} from './flashListRuntimeModel';
import { TranscriptPerfContractTracker } from './perfContractTracker';

export type { RuntimeModelRow, RuntimeModelObservation, FlashListRuntimeModelOptions };

export type TranscriptRuntimeContractOptions = FlashListRuntimeModelOptions;

/** Build N committed rows of uniform height in canonical (oldest-first) order. */
export function buildUniformRows(
    count: number,
    options: Readonly<{ heightPx?: number; prefix?: string; startIndex?: number }> = {},
): RuntimeModelRow[] {
    const heightPx = options.heightPx ?? 120;
    const prefix = options.prefix ?? 'msg';
    const startIndex = options.startIndex ?? 0;
    return Array.from({ length: count }, (_value, i) => ({
        key: `${prefix}-${startIndex + i}`,
        heightPx,
    }));
}

export class TranscriptRuntimeContract {
    readonly model: FlashListRuntimeModel;
    readonly perf: TranscriptPerfContractTracker;

    constructor(options: TranscriptRuntimeContractOptions) {
        this.model = new FlashListRuntimeModel(options);
        this.perf = new TranscriptPerfContractTracker();
    }

    observe(): RuntimeModelObservation {
        return this.model.observe();
    }

    /** Record a render + the current MVCP policy + an optional reference sample, atomically. */
    private commitFrame(referenceSamples?: Record<string, unknown>): void {
        this.perf.markRender();
        this.perf.sampleMvcpPolicy(this.model.mvcpPolicy());
        if (referenceSamples) {
            for (const [label, value] of Object.entries(referenceSamples)) {
                this.perf.sampleReference(label, value);
            }
        }
    }

    // ---- Failure (a): escape-lockup (pin fights finger) ---------------------------------------

    /**
     * Drive a finger-drag that scrolls AWAY from the live tail while the live tail is streaming.
     * The committed plan: finger-down/dragging SUSPENDS all automatic pin writers. A regression
     * (pin fights finger) would re-pin the surface to the bottom mid-drag, undoing the user's
     * scroll. Returns the model so the test asserts the released distance held.
     */
    fingerDragAwayWhileStreaming(options: Readonly<{
        dragDistancePx: number;
        streamGrowthPxPerFrame: number;
        frames: number;
    }>): FlashListRuntimeModel {
        this.model.setLiveRegionState({ liveRegionActive: true, sessionActive: true });
        this.model.fingerDown();
        for (let frame = 0; frame < options.frames; frame += 1) {
            // The finger drags toward the older edge each frame...
            this.model.dragBy(options.dragDistancePx / options.frames);
            // ...while the live tail keeps growing (the stream never stops for the gesture).
            this.model.streamAppend({ growTailByPx: options.streamGrowthPxPerFrame });
            this.commitFrame();
        }
        this.model.fingerUp({ momentumPending: false });
        return this.model;
    }

    // ---- Failure (b): inverted jump-overshoot then settle -------------------------------------

    /**
     * Jump to the live tail, then stream more tokens. A correct jump lands exactly at the visual
     * bottom (distance 0) and STAYS there as the tail grows (following). A regression overshoots
     * (distance goes negative / clamps) then settles back, a visible bounce.
     */
    jumpToTailThenStream(options: Readonly<{
        streamGrowthPxPerFrame: number;
        frames: number;
    }>): FlashListRuntimeModel {
        this.model.setLiveRegionState({ liveRegionActive: true, sessionActive: true });
        this.model.jumpToBottom();
        this.commitFrame();
        for (let frame = 0; frame < options.frames; frame += 1) {
            this.model.streamAppend({ growTailByPx: options.streamGrowthPxPerFrame });
            this.commitFrame();
        }
        return this.model;
    }

    // ---- Failure (c): prepend-position-loss while released ------------------------------------

    /**
     * The reader is released (scrolled up reading history). Older history is prepended. With MVCP
     * armed the anchor row the reader is looking at holds its on-screen position; with MVCP
     * disabled (§3a) the content shifts under the reader. Returns the on-screen top of `anchorKey`
     * before/after.
     */
    prependOlderWhileReleased(options: Readonly<{
        anchorKey: string;
        olderRows: readonly RuntimeModelRow[];
        scrollAwayPx: number;
    }>): Readonly<{ beforeTop: number | null; afterTop: number | null; mvcpDiffPx: number }> {
        // Release the reader by dragging away from the tail.
        this.model.fingerDown();
        this.model.dragBy(options.scrollAwayPx);
        this.model.fingerUp({ momentumPending: false });
        const beforeTop = this.model.onScreenTopOfRow(options.anchorKey);
        const mvcpDiffPx = this.model.prependOlder(options.olderRows);
        const afterTop = this.model.onScreenTopOfRow(options.anchorKey);
        this.commitFrame();
        return { beforeTop, afterTop, mvcpDiffPx };
    }

    // ---- Failure (d): released-near-tail jiggle while streaming --------------------------------

    /**
     * The reader released JUST above the live tail (within the carve / live region). Streaming
     * growth happens below the released reader. The anchor the reader is looking at must NOT jiggle
     * (move back and forth) across frames. Returns the per-frame on-screen tops of `anchorKey` so
     * the test asserts monotonic stability (no oscillation).
     */
    streamWhileReleasedNearTail(options: Readonly<{
        anchorKey: string;
        scrollAwayPx: number;
        streamGrowthPxPerFrame: number;
        frames: number;
    }>): Readonly<{ anchorTops: (number | null)[] }> {
        this.model.setLiveRegionState({ liveRegionActive: true, sessionActive: true });
        this.model.fingerDown();
        this.model.dragBy(options.scrollAwayPx);
        this.model.fingerUp({ momentumPending: false });
        const anchorTops: (number | null)[] = [this.model.onScreenTopOfRow(options.anchorKey)];
        for (let frame = 0; frame < options.frames; frame += 1) {
            this.model.streamAppend({ growTailByPx: options.streamGrowthPxPerFrame });
            anchorTops.push(this.model.onScreenTopOfRow(options.anchorKey));
            this.commitFrame();
        }
        return { anchorTops };
    }

    // ---- Perf contract: streaming render budget + MVCP no-churn -------------------------------

    /**
     * Stream `frames` tokens while pinned/following and record the render count + MVCP policy
     * samples. Tests assert render count ≤ budget and `perf.mvcpPolicyDidNotChurn()`.
     */
    streamPinnedForPerf(options: Readonly<{
        frames: number;
        streamGrowthPxPerFrame: number;
        /** A stable derived value (e.g. an items array) sampled each frame for referential checks. */
        stableReference?: () => unknown;
    }>): void {
        this.model.setLiveRegionState({ liveRegionActive: true, sessionActive: true });
        for (let frame = 0; frame < options.frames; frame += 1) {
            this.model.streamAppend({ growTailByPx: options.streamGrowthPxPerFrame });
            this.commitFrame(
                options.stableReference ? { stableReference: options.stableReference() } : undefined,
            );
        }
    }
}

export function createTranscriptRuntimeContract(
    options: TranscriptRuntimeContractOptions,
): TranscriptRuntimeContract {
    return new TranscriptRuntimeContract(options);
}
