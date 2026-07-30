import { describe, expect, it } from 'vitest';

import { resolveWebGenuineScrollMovement } from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';
import { createWebDomScrollObservation } from './webDomObservation';
import {
    createTranscriptUserScrollIntentOwner,
    TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS,
} from './userScrollIntentOwner';

function metrics(scrollTop: number, scrollHeight: number, clientHeight = 600) {
    return { clientHeight, scrollHeight, scrollTop } as any;
}

describe('createTranscriptUserScrollIntentOwner', () => {
    it('reports live intent for a whole scrollbar drag even though only its press is an event', () => {
        const owner = createTranscriptUserScrollIntentOwner();
        owner.setGestureActive({ active: true, atMs: 1_000, gesture: 'drag' });

        // A scrollbar thumb drag emits one pointerdown and then nothing until release. An
        // event-shaped guard goes stale mid-drag; the state-shaped fact must not.
        expect(owner.isLive(1_000 + 5_000)).toBe(true);

        owner.setGestureActive({ active: false, atMs: 6_000, gesture: 'drag' });
        expect(owner.isLive(6_000)).toBe(true);
        expect(owner.isLive(6_000 + TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS + 1)).toBe(false);
    });

    it('keeps raw-input liveness separate from the timestamp the classifier may also stamp', () => {
        const owner = createTranscriptUserScrollIntentOwner();
        owner.recordInput({ atMs: 1_000 });
        // The classifier's certified-movement effect writes the shared timestamp directly.
        owner.timestampRef.current = 5_000;

        expect(owner.timestampRef.current).toBe(5_000);
        // Liveness is raw-input-only: a derived stamp must not manufacture a live gesture.
        expect(owner.lastInputAtMs()).toBe(1_000);
        expect(owner.isLive(5_000)).toBe(false);

        owner.clear();
        expect(owner.timestampRef.current).toBe(Number.NEGATIVE_INFINITY);
        expect(owner.isLive(5_000)).toBe(false);
    });
});

describe('resolveWebGenuineScrollMovement under concurrent layout churn', () => {
    const baseFrame = {
        clientHeight: 600,
        distanceFromBottom: 900,
        pinThresholdPx: 60,
        previousObservedClientHeight: 600,
        previousObservedScrollHeight: 40_000,
        previousObservedScrollTop: 39_000,
        previousStreak: null,
        scrollHeight: 40_180, // content grew on this very frame
        scrollTop: 38_900,
        sustainFrames: 2,
    } as const;

    it('cannot certify a trusted movement under churn without witnessed input', () => {
        // Preserved: `isTrusted` alone is not evidence. RN-web marks the echo of the app's own
        // programmatic write trusted, and a reflow frame is not proof the reader moved.
        expect(resolveWebGenuineScrollMovement({
            ...baseFrame,
            isTrusted: true,
        }).isGenuineUserMovement).toBe(false);
    });

    it('certifies a trusted movement under churn when raw user input was witnessed', () => {
        // The keystone. A content-height change is the ONLY thing that arms the auto-pin, so a
        // classifier that cannot certify intent during churn is blind exactly when it matters.
        // Witnessed raw input is intent regardless of what layout is doing.
        const result = resolveWebGenuineScrollMovement({
            ...baseFrame,
            hasWitnessedUserInput: true,
            isTrusted: true,
        });
        expect(result.isGenuineUserMovement).toBe(true);
        expect(result.upwardIntent).toBe(true);
    });

    it('certifies a witnessed trusted movement while a measurement invalidation shrinks content', () => {
        // Signature/metadata-only churn: a row identity change deletes a measured size, so the
        // content height DROPS to an estimate. No new messages at all, same blindness.
        expect(resolveWebGenuineScrollMovement({
            ...baseFrame,
            hasWitnessedUserInput: true,
            isTrusted: true,
            scrollHeight: 39_200,
        }).isGenuineUserMovement).toBe(true);
    });

    it('does not certify a witnessed frame that did not move', () => {
        expect(resolveWebGenuineScrollMovement({
            ...baseFrame,
            hasWitnessedUserInput: true,
            isTrusted: true,
            scrollTop: baseFrame.previousObservedScrollTop,
        }).isGenuineUserMovement).toBe(false);
    });
});

describe('webDomObservation user authority', () => {
    it('still refuses user authority for our own command write echo during a live gesture', () => {
        // Q1-WEB-1 must survive: RN-web marks the echo of the app's OWN programmatic write
        // `isTrusted: true`. Witnessed input is not a licence to attribute a command frame to
        // the reader, otherwise a pin under-shoot masquerades as a user scroll again.
        const observation = createWebDomScrollObservation();
        const nowMs = 1_000;

        observation.observeGenuineScrollMovement({
            distanceFromBottom: 400,
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: metrics(39_000, 40_000),
            pinThresholdPx: 60,
            semanticContext: { atEndNonUserCause: 'layout', isUserInputActive: true, nowMs },
            sustainFrames: 2,
        });

        const commandFrame = observation.observeGenuineScrollMovement({
            distanceFromBottom: 0,
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: metrics(39_400, 40_000),
            pinThresholdPx: 60,
            semanticContext: { atEndNonUserCause: 'command', isUserInputActive: true, nowMs: nowMs + 16 },
            sustainFrames: 2,
        });

        expect(commandFrame.isGenuineUserMovement).toBe(false);
        expect(commandFrame.atEndPublicationCause).toBe('command');
    });

    it('keeps certifying a live gesture frame after a programmatic write cleared movement authority', () => {
        // The measured failure chain: a pin write during the reader's own wheel gesture wipes
        // `pendingUserInput`/`lastUserMovement`, so the NEXT frame of that same gesture is
        // unclassified — bottom-follow is never released and the auto-pin snaps the reader back.
        const observation = createWebDomScrollObservation();
        const owner = createTranscriptUserScrollIntentOwner();
        let nowMs = 1_000;

        observation.observeGenuineScrollMovement({
            distanceFromBottom: 400,
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: metrics(39_000, 40_000),
            pinThresholdPx: 60,
            semanticContext: { atEndNonUserCause: 'layout', isUserInputActive: false, nowMs },
            sustainFrames: 2,
        });

        owner.recordInput({ atMs: nowMs });
        const element = { scrollTop: 39_000 };
        observation.recordProgrammaticScrollTopWrite({ element: element as any, targetScrollTop: 39_400 });

        nowMs += 40;
        const userFrame = observation.observeGenuineScrollMovement({
            distanceFromBottom: 1_100,
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: metrics(38_500, 40_200),
            pinThresholdPx: 60,
            semanticContext: {
                atEndNonUserCause: 'layout',
                isUserInputActive: owner.isLive(nowMs),
                nowMs,
            },
            sustainFrames: 2,
        });

        expect(userFrame.isGenuineUserMovement).toBe(true);
        expect(userFrame.upwardIntent).toBe(true);
    });
});
