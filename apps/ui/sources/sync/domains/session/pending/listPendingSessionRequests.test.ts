import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    buildPendingSessionRequestsSourceSignature,
    collectTranscriptRequestStates,
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
    listPendingSessionRequests,
    shouldReadTranscriptForPendingSessionRequests,
    type TranscriptRequestState,
    type TranscriptRequestStatesCache,
} from './listPendingSessionRequests';

describe('buildPendingSessionRequestsSourceSignature', () => {
    it('ignores session seq and timestamp churn that cannot change pending request derivation', () => {
        const session = createSessionFixture({
            active: true,
            seq: 1,
            updatedAt: 100,
            activeAt: 100,
            thinkingAt: 100,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        });
        const signature = buildPendingSessionRequestsSourceSignature(session);

        expect(buildPendingSessionRequestsSourceSignature({
            ...session,
            seq: 2,
            updatedAt: 200,
            activeAt: 200,
            thinkingAt: 200,
        })).toBe(signature);
    });

    it('changes when pending projection or agent request inputs change', () => {
        const session = createSessionFixture({
            active: true,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        });
        const signature = buildPendingSessionRequestsSourceSignature(session);

        expect(buildPendingSessionRequestsSourceSignature({
            ...session,
            pendingUserActionRequestCount: 1,
        })).not.toBe(signature);
        expect(buildPendingSessionRequestsSourceSignature({
            ...session,
            agentState: {
                requests: {
                    question: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { question: 'Continue?' },
                        createdAt: 10,
                    },
                },
                completedRequests: null,
            },
        })).not.toBe(signature);
    });
});

describe('derivePendingRequestFlagsFromSession', () => {
    it('uses projected pending request counts without scanning large transcript message lists', () => {
        const messages: Message[] = Array.from({ length: 1_000 }, (_, index) => ({
            id: `msg-${index}`,
            kind: 'tool-call',
            localId: null,
            createdAt: index + 1,
            tool: {
                id: `tool-${index}`,
                name: 'bash',
                state: 'running',
                input: {},
                createdAt: index + 1,
                startedAt: index + 1,
                completedAt: null,
                description: null,
                permission: {
                    id: `permission-${index}`,
                    status: 'pending',
                },
            },
            children: [],
        }));

        const session = createSessionFixture({
            active: true,
            updatedAt: 10_000,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        });

        expect(derivePendingRequestFlagsFromSession(session, messages)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
    });

    it('prefers projected counts over stale agent state request details', () => {
        const session = createSessionFixture({
            active: true,
            agentState: {
                requests: {
                    stale_request: {
                        tool: 'bash',
                        arguments: {},
                        createdAt: 10,
                    },
                },
                completedRequests: null,
            },
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 1,
        });

        expect(derivePendingRequestFlagsFromSession(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
    });

    it('prefers projected observed timestamp over request detail timestamps', () => {
        const session = createSessionFixture({
            active: true,
            pendingRequestObservedAt: 25,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            agentState: {
                requests: {
                    stale_request: {
                        tool: 'bash',
                        arguments: {},
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
        });

        expect(deriveLatestPendingRequestObservedAtFromSession(session)).toBe(25);
    });

    it('does not read transcript details when projected counts say nothing is pending', () => {
        const session = createSessionFixture({
            active: true,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentState: {
                requests: {
                    stale_request: {
                        tool: 'bash',
                        arguments: {},
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
        });

        expect(shouldReadTranscriptForPendingSessionRequests(session)).toBe(false);
        expect(listPendingSessionRequests(session)).toEqual([]);
    });

    it('surfaces live agentState user-action requests even when projected counts are stale zero', () => {
        const session = createSessionFixture({
            active: true,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentState: {
                requests: {
                    toolu_question: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {
                            questions: [{
                                header: 'Direction',
                                question: 'How should I resolve this?',
                                options: [{ label: 'Keep', description: 'Keep the behavior' }],
                                multiSelect: false,
                            }],
                        },
                        createdAt: 123,
                    },
                },
                completedRequests: null,
            },
        });

        expect(shouldReadTranscriptForPendingSessionRequests(session)).toBe(false);
        expect(listPendingSessionRequests(session)).toEqual([
            expect.objectContaining({
                id: 'toolu_question',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                createdAt: 123,
            }),
        ]);
        expect(derivePendingRequestFlagsFromSession(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session)).toBe(123);
    });

    it('surfaces live agentState user-action requests even while session.active is false', () => {
        const session = createSessionFixture({
            active: false,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentState: {
                requests: {
                    resume_choice: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {
                            questions: [{
                                header: 'Claude resume',
                                question: 'How should Claude resume this session?',
                                options: [
                                    { label: 'Resume from summary', description: 'Use the saved summary.' },
                                    { label: 'Resume full session', description: 'Load full context.' },
                                ],
                                multiSelect: false,
                            }],
                        },
                        createdAt: 456,
                    },
                },
                completedRequests: null,
            },
        });

        expect(shouldReadTranscriptForPendingSessionRequests(session)).toBe(false);
        expect(listPendingSessionRequests(session)).toEqual([
            expect.objectContaining({
                id: 'resume_choice',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                createdAt: 456,
            }),
        ]);
        expect(derivePendingRequestFlagsFromSession(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session)).toBe(456);
    });

    it('suppresses a stale projected pending flag when a newer hard-terminal transcript outcome exists', () => {
        // Projection still says a permission is pending, but the transcript shows
        // the request was hard-resolved (approved) AFTER the projection was observed.
        const messages: Message[] = [{
            id: 'msg-1',
            kind: 'tool-call',
            localId: null,
            createdAt: 200,
            tool: {
                id: 'tool-1',
                name: 'bash',
                state: 'completed',
                input: {},
                createdAt: 200,
                startedAt: 200,
                completedAt: 200,
                description: null,
                result: { output: 'done' },
                permission: {
                    id: 'permission-1',
                    status: 'approved',
                },
            },
            children: [],
        }] as unknown as Message[];

        const session = createSessionFixture({
            active: true,
            updatedAt: 100,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 100,
            agentState: {
                requests: {},
                completedRequests: null,
            },
        });

        expect(derivePendingRequestFlagsFromSession(session, messages)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session, messages)).toBeNull();
        expect(listPendingSessionRequests(session, messages)).toEqual([]);
    });

    it('still surfaces a genuinely pending request that has no newer hard-terminal transcript outcome', () => {
        // Projection says a permission is pending and the transcript agrees (still pending).
        const messages: Message[] = [{
            id: 'msg-1',
            kind: 'tool-call',
            localId: null,
            createdAt: 200,
            tool: {
                id: 'tool-1',
                name: 'bash',
                state: 'running',
                input: {},
                createdAt: 200,
                startedAt: 200,
                completedAt: null,
                description: null,
                permission: {
                    id: 'permission-1',
                    status: 'pending',
                },
            },
            children: [],
        }] as unknown as Message[];

        const session = createSessionFixture({
            active: true,
            updatedAt: 100,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 100,
            agentState: {
                requests: {},
                completedRequests: null,
            },
        });

        expect(derivePendingRequestFlagsFromSession(session, messages)).toEqual({
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session, messages)).toBe(100);
        expect(listPendingSessionRequests(session, messages)).toHaveLength(1);
    });

    it('does not suppress projected pending when the only hard-terminal outcome predates the projection', () => {
        // The hard-terminal resolution happened BEFORE updatedAt, so it cannot
        // explain away a still-projected pending request; trust the projection.
        const messages: Message[] = [{
            id: 'msg-1',
            kind: 'tool-call',
            localId: null,
            createdAt: 50,
            tool: {
                id: 'tool-1',
                name: 'bash',
                state: 'completed',
                input: {},
                createdAt: 50,
                startedAt: 50,
                completedAt: 50,
                description: null,
                result: { output: 'done' },
                permission: {
                    id: 'permission-1',
                    status: 'approved',
                },
            },
            children: [],
        }] as unknown as Message[];

        const session = createSessionFixture({
            active: true,
            updatedAt: 100,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 100,
            agentState: {
                requests: {},
                completedRequests: null,
            },
        });

        expect(derivePendingRequestFlagsFromSession(session, messages)).toEqual({
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session, messages)).toBe(100);
    });
});

describe('transcript request states cache', () => {
    function pendingToolCallMessage(id: string, createdAt: number): Message {
        return {
            id,
            kind: 'tool-call',
            localId: null,
            createdAt,
            tool: {
                id: `${id}-tool`,
                name: 'bash',
                state: 'running',
                input: { command: 'ls' },
                createdAt,
                startedAt: createdAt,
                completedAt: null,
                description: null,
                permission: {
                    id: `${id}-perm`,
                    status: 'pending',
                },
            },
            children: [],
        } as unknown as Message;
    }

    function activeTranscriptSession() {
        return createSessionFixture({
            active: true,
            updatedAt: 100,
            agentState: {
                requests: {},
                completedRequests: null,
            },
        });
    }

    it('derives identical results from a pre-filled cache without messages', () => {
        const session = activeTranscriptSession();
        const messages = [pendingToolCallMessage('m1', 50)];

        const cache: TranscriptRequestStatesCache = {
            states: (() => {
                const states = new Map<string, TranscriptRequestState>();
                collectTranscriptRequestStates(messages, null, states);
                return states;
            })(),
        };

        expect(derivePendingRequestFlagsFromSession(session, undefined, cache))
            .toEqual(derivePendingRequestFlagsFromSession(session, messages));
        expect(deriveLatestPendingRequestObservedAtFromSession(session, undefined, cache))
            .toBe(deriveLatestPendingRequestObservedAtFromSession(session, messages));
        expect(listPendingSessionRequests(session, undefined, cache))
            .toEqual(listPendingSessionRequests(session, messages));
    });

    it('walks the transcript once per cache and reuses the collected states', () => {
        const session = activeTranscriptSession();
        const messages = [pendingToolCallMessage('m1', 50)];

        const cache: TranscriptRequestStatesCache = {};
        const flags = derivePendingRequestFlagsFromSession(session, messages, cache);
        expect(flags.hasPendingPermissionRequests).toBe(true);
        expect(cache.states?.size).toBe(1);

        // A later derivation in the same pass must reuse the cached states and
        // never re-walk the (now grown) message array.
        messages.push(pendingToolCallMessage('m2', 80));
        expect(deriveLatestPendingRequestObservedAtFromSession(session, messages, cache)).toBe(50);
    });
});
