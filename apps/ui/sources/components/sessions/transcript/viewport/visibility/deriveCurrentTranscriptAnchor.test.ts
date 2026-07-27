import { describe, expect, it } from 'vitest';

import {
    deriveCurrentTranscriptAnchor,
    type TranscriptNavigationAnchorCandidate,
} from './deriveCurrentTranscriptAnchor';

const TURN_1: TranscriptNavigationAnchorCandidate = { id: 'turn-1', kind: 'user-turn', sourceIndex: 2 };
const PIN_A: TranscriptNavigationAnchorCandidate = { id: 'pin-a', kind: 'pinned-tool', sourceIndex: 6 };
const TURN_2: TranscriptNavigationAnchorCandidate = { id: 'turn-2', kind: 'user-turn', sourceIndex: 10 };
const TURN_3: TranscriptNavigationAnchorCandidate = { id: 'turn-3', kind: 'user-turn', sourceIndex: 30 };
const ANCHORS = [TURN_1, PIN_A, TURN_2, TURN_3];

describe('deriveCurrentTranscriptAnchor', () => {
    it('keeps the turn being read current when its own prompt row is scrolled out of the visible range', () => {
        // The user is deep inside turn-2's body: turn-2's prompt row (index 10)
        // is no longer rendered in the visible window at all.
        expect(deriveCurrentTranscriptAnchor({
            anchors: ANCHORS,
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 17, lastSourceIndex: 24 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: [],
        });
    });

    it('does not hand off to the next turn while it is only peeking in below the leading row', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors: ANCHORS,
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 5, lastSourceIndex: 12 },
        })).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['pin-a', 'turn-2'],
        });
    });

    it('treats a partially scrolled leading row as landed so a freshly jump-aligned turn is current', () => {
        // Jump-to-turn-2 aligns turn-2 at the viewport top: it IS the leading
        // visible row, so it wins over the earlier turn whether its top sits a
        // few pixels above or below the exact viewport edge.
        expect(deriveCurrentTranscriptAnchor({
            anchors: ANCHORS,
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 10, lastSourceIndex: 18 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
        });
    });

    it('reports every anchor inside the visible source range', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors: ANCHORS,
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 2, lastSourceIndex: 30 },
        })).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1', 'pin-a', 'turn-2', 'turn-3'],
        });
    });

    it('falls back to the greatest anchor of any kind when no user turn has been reached', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors: [PIN_A, TURN_2],
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 8, lastSourceIndex: 9 },
        })).toEqual({
            currentAnchorId: 'pin-a',
            visibleAnchorIds: [],
        });
    });

    it('falls back to the first visible anchor when nothing sits at or above the leading row', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors: [TURN_2, TURN_3],
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 0, lastSourceIndex: 12 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
        });
    });

    it('returns the empty snapshot for an absent or inverted range', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors: ANCHORS,
            preferUserTurnAnchor: true,
            visibleSourceRange: null,
        })).toEqual({ currentAnchorId: null, visibleAnchorIds: [] });
        expect(deriveCurrentTranscriptAnchor({
            anchors: ANCHORS,
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 9, lastSourceIndex: 3 },
        })).toEqual({ currentAnchorId: null, visibleAnchorIds: [] });
    });

    it('ignores malformed anchors instead of ranking them', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors: [
                { id: '', kind: 'user-turn', sourceIndex: 0 },
                { id: 'turn-nan', kind: 'user-turn', sourceIndex: Number.NaN },
                TURN_2,
            ],
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 10, lastSourceIndex: 11 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
        });
    });
});
