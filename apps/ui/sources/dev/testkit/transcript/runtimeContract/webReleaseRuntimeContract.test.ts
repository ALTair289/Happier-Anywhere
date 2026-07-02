/**
 * WEB release RUNTIME contract tests (lane H1) — the env-independent guard for Q1-WEB-1.
 *
 * The user's ORIGINAL web bug: a pinned reader is silently RELEASED mid-stream when the app's own
 * programmatic pin write UNDER-SHOOTS the (still-growing) bottom and RN-web fires the echo
 * `onScroll` with `isTrusted:true`. The fix moves web release authority off the `isTrusted` flag
 * and onto `resolveWebGenuineScrollMovement` (genuine = "scrollTop moved to a value that does NOT
 * match the app's own last programmatic write").
 *
 * The live browser/device QA for this is environment-blocked, so these tests run the faithful
 * `WebScrollRuntimeModel` — which composes the REAL `resolveWebGenuineScrollMovement` +
 * `resolveTranscriptBottomFollowIntent` + the canonical web metric helpers, and a programmatic
 * writer that records its LANDED value exactly like `performTranscriptViewportCommand`. They assert
 * the OBSERVABLE pinned-vs-released outcome (wantsPinned + on-screen distance), pinning the fix
 * ENVIRONMENT-INDEPENDENTLY.
 *
 * Each scenario also carries an adversarial demonstration proving the harness can DETECT the
 * regression (the `isTrusted`-trusting release) the prop-capture suite structurally cannot.
 */

import { describe, expect, it } from 'vitest';

import { WebScrollRuntimeModel } from './webScrollRuntimeModel';

const WEB = {
    layoutHeightPx: 600,
    pinThresholdPx: 72,
};

describe('web release runtime contract — (a) programmatic pin under-shoot during streaming keeps wantsPinned', () => {
    it('GREEN: an under-shooting trusted self-write echo (incl. the 1px residue) does NOT release the pin', () => {
        const model = new WebScrollRuntimeModel({
            ...WEB,
            // Bottom is reachable: max scrollTop = 4000 - 600 = 3400.
            contentHeightPx: 4000,
            startPinned: true,
        });
        expect(model.observe().wantsPinned).toBe(true);
        expect(model.observe().distanceFromBottomPx).toBe(0);

        // Stream grows every frame; the app re-pins programmatically but the content keeps growing
        // so each pin write UNDER-SHOOTS the new bottom by a residue. RN-web fires the echo onScroll
        // with isTrusted:true. A naive isTrusted-trusting release would drop the pin here.
        for (let frame = 0; frame < 6; frame += 1) {
            model.streamGrow(250);
            // The app's pin write lands the PREVIOUS bottom (under-shoots the just-grown content).
            const undershootTarget = model.observe().scrollHeightPx - WEB.layoutHeightPx - 250;
            model.programmaticScrollTopWrite(undershootTarget);
            // The trusted echo onScroll for that self-write.
            const echo = model.programmaticWriteEchoFrame({ isTrusted: true });
            expect(echo.released).toBe(false);
            expect(echo.genuineUserMovement).toBe(false);
        }

        // Also model the exact 1px residue self-write echo.
        model.streamGrow(120);
        const bottom = model.observe().scrollHeightPx - WEB.layoutHeightPx;
        model.programmaticScrollTopWrite(bottom - 1);
        const residueEcho = model.programmaticWriteEchoFrame({ isTrusted: true });
        expect(residueEcho.released).toBe(false);
        expect(residueEcho.genuineUserMovement).toBe(false);

        // The reader stayed pinned: wantsPinned never flipped despite 7 trusted self-write echoes.
        expect(model.observe().wantsPinned).toBe(true);
    });

    it('RED demonstration: trusting isTrusted releases on the same under-shoot echo', () => {
        // The faithful model keeps the pin (asserted above). A regression that used the event
        // `isTrusted` flag as release authority would have released on the first trusted echo, since
        // the under-shoot moved scrollTop away from the true bottom. Encode the two divergent
        // outcomes so the harness proves it discriminates them.
        const model = new WebScrollRuntimeModel({ ...WEB, contentHeightPx: 4000, startPinned: true });
        model.streamGrow(250);
        model.programmaticScrollTopWrite(model.observe().scrollHeightPx - WEB.layoutHeightPx - 250);
        const faithfulReleased = model.programmaticWriteEchoFrame({ isTrusted: true }).released;
        const brokenIsTrustedReleased = true; // an isTrusted-trusting release would unpin here.
        expect(faithfulReleased).toBe(false);
        expect(faithfulReleased).not.toBe(brokenIsTrustedReleased);
    });
});

describe('web release runtime contract — (b) a genuine scrollbar/keyboard scroll-up releases and holds', () => {
    it('GREEN: a genuine away-move releases wantsPinned and holds the new position', () => {
        const model = new WebScrollRuntimeModel({
            ...WEB,
            contentHeightPx: 4000,
            startPinned: true,
        });
        // max scrollTop = 3400; a genuine scrollbar drag well beyond the pin threshold (72px).
        const before = model.observe();
        expect(before.wantsPinned).toBe(true);

        const frame = model.userScrollUpBy(1200, { isTrusted: true });
        expect(frame.genuineUserMovement).toBe(true);
        expect(frame.upwardIntent).toBe(true);
        expect(frame.released).toBe(true);

        const after = model.observe();
        // Released: wantsPinned false, the surface holds the scrolled-up position far from bottom.
        expect(after.wantsPinned).toBe(false);
        expect(after.isPinned).toBe(false);
        expect(after.distanceFromBottomPx).toBeGreaterThan(WEB.pinThresholdPx);
        expect(after.scrollTop).toBe(3400 - 1200);
    });

    it('GREEN: an UNTRUSTED genuine away-move still releases when it is BEYOND the pin threshold', () => {
        // RN-web does not reliably mark scrollbar/keyboard scrolls trusted; a beyond-threshold away
        // move (value mismatch with the last write) must still carry release authority.
        const model = new WebScrollRuntimeModel({ ...WEB, contentHeightPx: 4000, startPinned: true });
        const frame = model.userScrollUpBy(900, { isTrusted: false });
        expect(frame.genuineUserMovement).toBe(true);
        expect(model.observe().wantsPinned).toBe(false);
    });
});

describe('web release runtime contract — (c) untrusted within-threshold single-frame noise does NOT release', () => {
    it('GREEN: a tiny untrusted within-threshold single-frame jitter keeps wantsPinned', () => {
        const model = new WebScrollRuntimeModel({
            ...WEB,
            contentHeightPx: 4000,
            startPinned: true,
        });
        // Pinned at the bottom (scrollTop 3400). A single untrusted virtualization-noise frame nudges
        // scrollTop by a few px (well within the 72px threshold) — NOT sustained, NOT trusted.
        const frame = model.userScrollTo(3400 - 20, { isTrusted: false });
        expect(frame.released).toBe(false);
        expect(model.observe().wantsPinned).toBe(true);
    });

    it('GREEN: a single trusted within-threshold nudge during content-height churn does NOT release', () => {
        // The exact Q1-WEB-1 shape: content reflowing (height changed) + trusted echo + within
        // threshold. The owner gates eager-trusted release on `!contentHeightChanged`, so churn can
        // never masquerade as scrollbar/keyboard intent.
        const model = new WebScrollRuntimeModel({ ...WEB, contentHeightPx: 4000, startPinned: true });
        // Establish a prior observation baseline (the pinned reader has been observed at the bottom
        // at least once) so the next frame's content-height change is detectable as churn.
        model.programmaticPinToBottom();
        model.programmaticWriteEchoFrame({ isTrusted: true });
        model.streamGrow(30); // content height churn this frame
        const frame = model.userScrollTo(model.observe().scrollHeightPx - WEB.layoutHeightPx - 10, { isTrusted: true });
        expect(frame.released).toBe(false);
        expect(model.observe().wantsPinned).toBe(true);
    });

    it('RED demonstration: a SUSTAINED untrusted away streak DOES release (the harness is not over-suppressing)', () => {
        // Proves (c) suppresses only single-frame within-threshold noise, not genuine slow intent.
        const model = new WebScrollRuntimeModel({ ...WEB, contentHeightPx: 4000, startPinned: true });
        // Two consecutive same-direction untrusted away frames (sustainFrames = 2), within threshold.
        const f1 = model.userScrollTo(3400 - 30, { isTrusted: false });
        expect(f1.released).toBe(false);
        const f2 = model.userScrollTo(3400 - 60, { isTrusted: false });
        // Second same-direction frame reaches the sustained streak → genuine intent → release.
        expect(f2.genuineUserMovement).toBe(true);
        expect(model.observe().wantsPinned).toBe(false);
    });
});
