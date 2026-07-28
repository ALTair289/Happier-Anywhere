import { describe, expect, it } from 'vitest';

import type { TranscriptNavigationAnchorCandidate } from './deriveCurrentTranscriptAnchor';
import { resolveRetainedTranscriptNavigationLandedAnchor } from './transcriptNavigationLandedAnchor';

const ANCHORS: readonly TranscriptNavigationAnchorCandidate[] = [
    { id: 'turn-1', kind: 'user-turn', sourceIndex: 2 },
    { id: 'turn-2', kind: 'user-turn', sourceIndex: 10 },
];

const LANDED = { anchorId: 'turn-2', sessionId: 'session-1' } as const;

describe('resolveRetainedTranscriptNavigationLandedAnchor', () => {
    it('retains the landed anchor across frames the reader did not move', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: ANCHORS,
            genuineUserMovement: false,
            landed: LANDED,
            sessionId: 'session-1',
        })).toEqual(LANDED);
    });

    it('releases as soon as the reader genuinely scrolls', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: ANCHORS,
            genuineUserMovement: true,
            landed: LANDED,
            sessionId: 'session-1',
        })).toBeNull();
    });

    it('releases when the session changed under the host', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: ANCHORS,
            genuineUserMovement: false,
            landed: LANDED,
            sessionId: 'session-2',
        })).toBeNull();
    });

    it('releases when the anchor left the anchor set', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: [ANCHORS[0]!],
            genuineUserMovement: false,
            landed: LANDED,
            sessionId: 'session-1',
        })).toBeNull();
    });

    it('stays null when nothing landed', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: ANCHORS,
            genuineUserMovement: false,
            landed: null,
            sessionId: 'session-1',
        })).toBeNull();
    });
});
