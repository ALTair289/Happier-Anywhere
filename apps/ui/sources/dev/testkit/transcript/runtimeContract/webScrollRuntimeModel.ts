/**
 * Faithful WEB (standard DOM scroller) runtime SIMULATOR for the transcript device/perf contract
 * harness (lane H1) — the web counterpart of `flashListRuntimeModel.ts`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The native runtime model proves the inverted FlashList scroll physics. The user's ORIGINAL
 * Q1-WEB-1 bug, however, lives on the WEB path: a programmatic pin/restore write under-shoots while
 * the stream grows, RN-web fires the echo `onScroll` with `isTrusted:true`, and a naive release
 * authority that trusts that flag silently RELEASES bottom-follow mid-stream — the pinned reader
 * gets dropped. The live device/browser QA for this is environment-blocked (a QA-lane MED finding),
 * so this headless model pins the pinned-vs-released PIXEL outcome ENVIRONMENT-INDEPENDENTLY.
 *
 * It is the OPPOSITE of a no-op mock. It is a deterministic re-implementation of the WEB DOM
 * scroller's geometry (`scrollTop` / `scrollHeight` / `clientHeight`), driven by the REAL web
 * release owners — never re-derived:
 *
 *  - `createWebDomScrollObservation` (the single owner of "did the WEB user genuinely scroll?",
 *    Plan E3 / C3b): genuine movement is "scrollTop moved to a value that does NOT match the app's
 *    own last programmatic write", NOT the DOM `isTrusted` flag. The model imports and composes the
 *    same owner as `ChatList.tsx`'s flash_v2 web onScroll branch does.
 *  - `createTranscriptViewportLifecycle` (the renderer-free follow/release owner): fed the
 *    SAME genuine web movement facts the production branch feeds it.
 *  - `getWebTranscriptDistanceFromBottom` / `resolveWebTranscriptMaxScrollTop` (the canonical web
 *    metric helpers): distance + visual-bottom math, so the model cannot drift from the app.
 *
 * The KEY fidelity detail — and the heart of the Q1-WEB-1 root cause — is the PROGRAMMATIC WRITE
 * (`programmaticScrollTopWrite`): a programmatic pin/restore lands the `scrollTop` value AND updates
 * the observation refs (`lastObservedWebScrollTop` / `Height`) to the LANDED value, mirroring the
 * `performTranscriptViewportCommand` web writer. Because the writer records the value it actually
 * landed, the write's echo `onScroll` matches `previousObservedScrollTop` and is correctly NOT
 * classified as a user movement — even when the write UNDER-SHOT (could not reach the true bottom
 * because the stream was still growing) and even though the echo carries `isTrusted:true`. A real
 * scrollbar / keyboard scroll lands a DIFFERENT value than the recorded write and IS genuine.
 *
 * SCOPE / FIDELITY
 * ----------------
 * This is a model, not the browser. It omits sub-pixel layout, smooth-scroll animation timing, and
 * the older-pagination machine. It asserts the geometric + release-authority invariants the
 * Q1-WEB-1 failure lives in. Where a number is load-bearing (the distance, the visual bottom, the
 * genuine-movement classification, the pin gate) it uses the canonical production owner.
 */

import {
    getWebTranscriptDistanceFromBottom,
    resolveWebTranscriptMaxScrollTop,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    createWebDomScrollObservation,
} from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { createTranscriptViewportLifecycle } from '@/components/sessions/transcript/viewport/lifecycle/lifecycle';

/**
 * Mirrors `TRANSCRIPT_WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES` in `ChatList.tsx` (Plan E3):
 * consecutive same-direction non-programmatic web frames required before an untrusted/churn-time
 * movement accumulates into "sustained user intent".
 */
export const WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES = 2;

export type WebScrollRuntimeModelOptions = Readonly<{
    layoutHeightPx: number;
    /** Distance (px) from the visual bottom under which the reader is considered pinned. */
    pinThresholdPx?: number;
    /** Initial total content height (scrollHeight). */
    contentHeightPx: number;
    /** Whether the session opens pinned at the visual bottom (cold open / resume-at-bottom). */
    startPinned?: boolean;
}>;

export type WebScrollRuntimeObservation = Readonly<{
    /** DOM scroller `scrollTop`. 0 = visual top (oldest); max = visual bottom (newest, pinned). */
    scrollTop: number;
    scrollHeightPx: number;
    clientHeightPx: number;
    /** Distance in px from the visual bottom. 0 = pinned to the newest content. */
    distanceFromBottomPx: number;
    /** The app's intent to keep following the live tail. The Q1-WEB-1 observable. */
    wantsPinned: boolean;
    /** wantsPinned AND within the effective pin threshold of the bottom. */
    isPinned: boolean;
}>;

type WebScrollFrameResult = Readonly<{
    /** TRUE only when the REAL owner classified the frame as a genuine non-programmatic scroll. */
    genuineUserMovement: boolean;
    /** TRUE when the REAL owner detected genuine upward (toward older) intent. */
    upwardIntent: boolean;
    /** TRUE when the viewport lifecycle flipped wantsPinned true→false this frame. */
    released: boolean;
}>;

/**
 * Headless WEB DOM-scroller runtime model. Construct, drive programmatic writes / streaming growth /
 * genuine user scrolls, then read the observable pinned-vs-released position.
 *
 * The model keeps the DOM scroller geometry directly (scrollTop / scrollHeight / clientHeight) — the
 * web path is standard (non-inverted) so scrollTop grows toward the visual bottom.
 */
export class WebScrollRuntimeModel {
    private scrollTop: number;
    private scrollHeightPx: number;
    private readonly clientHeightPx: number;
    private readonly pinThresholdPx: number;

    /** App intent to follow the live tail (Q1-WEB-1 observable). */
    private wantsPinned: boolean;

    private readonly observation = createWebDomScrollObservation();
    private readonly lifecycle = createTranscriptViewportLifecycle();

    // Telemetry of the most recent frame (for assertions that need the release transition).
    private lastFrame: WebScrollFrameResult = {
        genuineUserMovement: false,
        upwardIntent: false,
        released: false,
    };

    constructor(options: WebScrollRuntimeModelOptions) {
        this.clientHeightPx = options.layoutHeightPx;
        this.scrollHeightPx = options.contentHeightPx;
        this.pinThresholdPx = options.pinThresholdPx ?? 72;
        this.wantsPinned = options.startPinned !== false;
        this.scrollTop = this.wantsPinned ? this.maxScrollTop() : 0;
        this.lifecycle.dispatch({
            sessionId: 'web-runtime',
            shouldFollowLiveTail: this.wantsPinned,
            type: 'session-entry',
        });
    }

    // ---- canonical web metrics (REAL helpers) --------------------------------------------------

    private metrics(): WebTranscriptScrollMetrics {
        return {
            // The model never touches a real DOM node; the helpers only read the numeric fields.
            element: null as unknown as HTMLElement,
            scrollTop: this.scrollTop,
            scrollHeight: this.scrollHeightPx,
            clientHeight: this.clientHeightPx,
        };
    }

    private maxScrollTop(): number {
        return resolveWebTranscriptMaxScrollTop(this.metrics());
    }

    private distanceFromBottom(): number {
        return getWebTranscriptDistanceFromBottom(this.metrics());
    }

    private clampScrollTop(value: number): number {
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.min(value, this.maxScrollTop()));
    }

    // ---- driving events ------------------------------------------------------------------------

    /**
     * The app commits a programmatic pin/restore scroll write (jump-to-bottom, content-size-change
     * re-pin, entry/prepend restore). Lands `targetScrollTop` (clamped to the current visual
     * bottom) AND records it as the last-observed write — exactly as the production web writer in
     * `performTranscriptViewportCommand` does. This is the self-write exclusion that prevents the
     * write's own echo `onScroll` from masquerading as a user scroll.
     *
     * When the stream is still growing the target may UNDER-SHOOT the true bottom (the Q1-WEB-1
     * condition); the recorded value is whatever actually landed, so the subsequent echo still
     * matches and is correctly excluded.
     */
    programmaticScrollTopWrite(targetScrollTop: number): void {
        const model = this;
        this.observation.recordProgrammaticScrollTopWrite({
            element: {
                get scrollTop() {
                    return model.scrollTop;
                },
                set scrollTop(value: number) {
                    model.scrollTop = model.clampScrollTop(value);
                },
                get scrollHeight() {
                    return model.scrollHeightPx;
                },
            },
            targetScrollTop,
        });
    }

    /** Convenience: the app's "pin to the live tail" programmatic write. */
    programmaticPinToBottom(): void {
        this.programmaticScrollTopWrite(this.maxScrollTop());
    }

    /**
     * The live tail grows by `deltaPx` (a streaming token / new row at the visual bottom). Content
     * height grows; the existing scrollTop is unchanged by the growth itself (standard DOM: new
     * content extends the bottom, the viewport stays where it is in scrollTop space).
     */
    streamGrow(deltaPx: number): void {
        if (deltaPx <= 0) return;
        this.scrollHeightPx += deltaPx;
        // A pinned reader normally re-pins via a programmatic write AFTER growth; the model leaves
        // that to the caller / the onScroll frame so the under-shoot window is observable.
    }

    /**
     * Drive ONE web `onScroll` frame, mirroring the flash_v2 web branch in `ChatList.tsx`
     * (~:9310-9482): resolve genuine movement via the REAL owner, apply the upward-intent unpin,
     * update web DOM observation state, then feed normalized web facts into the viewport lifecycle.
     *
     * `isTrusted` is the DOM event flag (RN-web sets it true even for the app's own programmatic
     * writes — the Q1-WEB-1 trap). The model takes the CURRENT `scrollTop` as the observed value,
     * so callers set `scrollTop` (via a programmatic write or a genuine user scroll) BEFORE calling.
     */
    private onScrollFrame(isTrusted: boolean): WebScrollFrameResult {
        const distanceFromBottom = this.distanceFromBottom();
        const visualBottomScrollOffset = this.maxScrollTop();
        // Capture the pin intent BEFORE any unpin this frame: in production the upward-intent
        // `wantsPinnedRef.current = false` IS the release, so `released` must reflect the whole
        // frame's true→false transition, not only the follow-intent resolver's flip.
        const wantsPinnedBefore = this.wantsPinned;

        const movement = this.observation.observeGenuineScrollMovement({
            metrics: this.metrics(),
            fallbackObservedScrollTop: this.wantsPinned ? visualBottomScrollOffset : null,
            distanceFromBottom,
            pinThresholdPx: this.pinThresholdPx,
            sustainFrames: WEB_NON_PROGRAMMATIC_SCROLL_SUSTAIN_FRAMES,
            isTrusted,
        });

        const webObservedUserScrollMovement = movement.isGenuineUserMovement;
        const transition = this.lifecycle.dispatch({
            distanceFromLiveTailPx: distanceFromBottom,
            movement: movement.upwardIntent
                ? 'away-from-live-tail'
                : movement.downwardIntent
                    ? 'toward-live-tail'
                    : 'none',
            pinThresholdPx: this.pinThresholdPx,
            ...(webObservedUserScrollMovement ? { releaseAuthority: 'web-genuine-movement' as const } : {}),
            sessionId: 'web-runtime',
            source: 'web-scroll',
            trustedUserMovement: false,
            type: 'facts-observed',
        });
        this.wantsPinned = transition.state.followMode === 'following';

        const result: WebScrollFrameResult = {
            genuineUserMovement: webObservedUserScrollMovement,
            upwardIntent: movement.upwardIntent,
            released: wantsPinnedBefore === true && this.wantsPinned === false,
        };
        this.lastFrame = result;
        return result;
    }

    /**
     * A genuine non-programmatic user scroll (scrollbar drag / keyboard). Lands `nextScrollTop`
     * (clamped) WITHOUT recording it as a programmatic write, then drives an onScroll frame.
     * `isTrusted` defaults to true to model the worst case (RN-web marks even genuine scrolls
     * inconsistently; the owner must classify by value mismatch, not the flag).
     */
    userScrollTo(nextScrollTop: number, options: Readonly<{ isTrusted?: boolean }> = {}): WebScrollFrameResult {
        this.scrollTop = this.clampScrollTop(nextScrollTop);
        return this.onScrollFrame(options.isTrusted ?? true);
    }

    /** A genuine user scroll UP (toward older content) by `deltaPx`. */
    userScrollUpBy(deltaPx: number, options: Readonly<{ isTrusted?: boolean }> = {}): WebScrollFrameResult {
        return this.userScrollTo(this.scrollTop - Math.abs(deltaPx), options);
    }

    /**
     * The echo `onScroll` fired by RN-web for the app's OWN programmatic write — carries
     * `isTrusted:true` but the scrollTop matches the recorded write. Drives an onScroll frame at the
     * CURRENT (already-written) scrollTop, so the owner's self-write exclusion is exercised.
     */
    programmaticWriteEchoFrame(options: Readonly<{ isTrusted?: boolean }> = {}): WebScrollFrameResult {
        return this.onScrollFrame(options.isTrusted ?? true);
    }

    // ---- observation ---------------------------------------------------------------------------

    observe(): WebScrollRuntimeObservation {
        const distanceFromBottom = this.distanceFromBottom();
        return {
            scrollTop: this.scrollTop,
            scrollHeightPx: this.scrollHeightPx,
            clientHeightPx: this.clientHeightPx,
            distanceFromBottomPx: distanceFromBottom,
            wantsPinned: this.wantsPinned,
            isPinned: this.wantsPinned && distanceFromBottom <= this.pinThresholdPx,
        };
    }

    lastFrameResult(): WebScrollFrameResult {
        return this.lastFrame;
    }
}
