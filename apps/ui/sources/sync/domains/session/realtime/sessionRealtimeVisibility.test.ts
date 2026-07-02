import { describe, expect, it } from 'vitest';

import { sessionNeedsLiveTranscript, sessionScmMutationSignalWanted } from './sessionRealtimeVisibility';

describe('sessionNeedsLiveTranscript', () => {
    it('returns visible and voice reasons as full transcript consumers', () => {
        expect(sessionNeedsLiveTranscript({
            sessionId: 's1',
            isVisible: true,
        })).toEqual({ active: true, reasons: ['visible'] });

        expect(sessionNeedsLiveTranscript({
            sessionId: 's1',
            voicePrimaryActionSessionId: 's1',
            voiceTrackedSessionIds: ['s2'],
        })).toEqual({ active: true, reasons: ['voicePrimaryAction'] });

        expect(sessionNeedsLiveTranscript({
            sessionId: 's1',
            voiceTrackedSessionIds: ['s1'],
        })).toEqual({ active: true, reasons: ['voiceTracked'] });
    });

    it('does not treat unrelated same-root sessions as SCM consumers without an explicit same-project scope', () => {
        const decision = sessionNeedsLiveTranscript({
            sessionId: 's1',
            sessionScmScope: {
                sessionId: 's1',
                canonicalProjectKey: 'machine:/repo/packages/a',
                machineScopeId: 'machine',
                repoRoot: '/repo',
            },
            scmMountedScopes: [
                {
                    sessionId: 's2',
                    canonicalProjectKey: 'machine:/repo/packages/b',
                    machineScopeId: 'machine',
                    repoRoot: '/repo',
                    needsMutationTranscript: true,
                },
            ],
        });

        expect(decision).toEqual({ active: false, reasons: [] });
    });

    it('does not make hidden same-project sessions full transcript consumers for SCM scopes', () => {
        // Same-project hidden sessions get their SCM mutation signal from the durable
        // projection path instead of full transcript hydration.
        expect(sessionNeedsLiveTranscript({
            sessionId: 's1',
            sessionScmScope: {
                sessionId: 's1',
                canonicalProjectKey: 'machine:/repo',
            },
            scmMountedScopes: [
                {
                    sessionId: 's2',
                    canonicalProjectKey: 'machine:/repo',
                    needsMutationTranscript: true,
                },
            ],
        })).toEqual({ active: false, reasons: [] });
    });

    it('keeps the exact SCM session scope as a full transcript consumer', () => {
        expect(sessionNeedsLiveTranscript({
            sessionId: 's1',
            scmMountedScopes: [
                {
                    sessionId: 's1',
                    needsMutationTranscript: true,
                },
            ],
        })).toEqual({ active: true, reasons: ['scmSameSession'] });
    });
});

describe('sessionScmMutationSignalWanted', () => {
    it('wants the mutation signal for hidden sessions in the same canonical project scope', () => {
        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: {
                sessionId: 's1',
                canonicalProjectKey: 'machine:/repo',
            },
            scmMountedScopes: [
                {
                    sessionId: 's2',
                    canonicalProjectKey: 'machine:/repo',
                    needsMutationTranscript: true,
                },
            ],
        })).toBe(true);
    });

    it('wants the mutation signal for the mounted session itself', () => {
        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: null,
            scmMountedScopes: [
                {
                    sessionId: 's1',
                    needsMutationTranscript: true,
                },
            ],
        })).toBe(true);
    });

    it('does not want the mutation signal for different project scopes or non-mutation scopes', () => {
        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: {
                sessionId: 's1',
                canonicalProjectKey: 'machine:/repo/packages/a',
            },
            scmMountedScopes: [
                {
                    sessionId: 's2',
                    canonicalProjectKey: 'machine:/repo/packages/b',
                    needsMutationTranscript: true,
                },
            ],
        })).toBe(false);

        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: {
                sessionId: 's1',
                canonicalProjectKey: 'machine:/repo',
            },
            scmMountedScopes: [
                {
                    sessionId: 's2',
                    canonicalProjectKey: 'machine:/repo',
                },
            ],
        })).toBe(false);

        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: null,
            scmMountedScopes: [],
        })).toBe(false);
    });
});
