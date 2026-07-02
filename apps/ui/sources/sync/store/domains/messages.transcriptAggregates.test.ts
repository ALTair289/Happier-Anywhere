import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage } from '../../typesRaw';

const serverProfiles = vi.hoisted(() => ({
    activeServerId: 'server_1',
    profiles: [] as Array<{
        id: string;
        name: string;
        serverUrl: string;
        serverIdentityId: string | null;
        legacyServerIds: string[];
        createdAt: number;
        updatedAt: number;
        lastUsedAt: number;
    }>,
}));

function createSession(overrides: Record<string, unknown> = {}) {
    return {
        id: 's1',
        serverId: 'server_1',
        seq: 10,
        createdAt: 1_000,
        updatedAt: 2_000,
        active: true,
        activeAt: 2_000,
        archivedAt: null,
        lastViewedSessionSeq: 9,
        metadata: {
            machineId: 'm1',
            path: '/home/u/repo',
            homeDir: '/home/u',
        },
        metadataVersion: 1,
        agentState: {
            requests: {},
            completedRequests: null,
        },
        agentStateVersion: 1,
        thinking: true,
        thinkingAt: 1_500,
        presence: 'online',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 1_900,
        permissionMode: null,
        permissionModeUpdatedAt: 0,
        ...overrides,
    };
}

function createWorkingRenderable() {
    return {
        id: 's1',
        seq: 9,
        createdAt: 1_000,
        updatedAt: 1_900,
        active: true,
        activeAt: 1_900,
        archivedAt: null,
        lastViewedSessionSeq: 9,
        metadata: {
            machineId: 'm1',
            path: '/home/u/repo',
            homeDir: '/home/u',
        },
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: true,
        thinkingAt: Date.now(),
        presence: 'online' as const,
        latestTurnStatus: 'in_progress' as const,
        latestTurnStatusObservedAt: 1_900,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
    };
}

function agentTextMessage(id: string, createdAt: number, text: string, usage?: Record<string, number>): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        isSidechain: false,
        role: 'agent',
        content: [{ type: 'text', text }],
        ...(usage ? { usage } : {}),
    } as unknown as NormalizedMessage;
}

async function createHarness() {
    serverProfiles.activeServerId = 'server_1';
    serverProfiles.profiles = [{
        id: 'server_1',
        name: 'Server One',
        serverUrl: 'http://server.test',
        serverIdentityId: null,
        legacyServerIds: [],
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
    }];
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: vi.fn(() => ({
            serverId: 'server_1',
            serverUrl: 'http://server.test',
            generation: 1,
        })),
    }));
    vi.doMock('../../domains/server/serverProfiles', async (importOriginal) => {
        const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
        return createServerProfilesModuleMock({
            importOriginal,
            overrides: {
                getActiveServerSnapshot: vi.fn(() => ({
                    serverId: serverProfiles.activeServerId,
                    serverUrl: 'http://server.test',
                    generation: 1,
                })),
                listServerProfiles: vi.fn(() => serverProfiles.profiles),
            },
        });
    });

    const { createMessagesDomain } = await import('./messages');
    const { buildSessionListViewDataWithServerScope } = await import('../buildSessionListViewDataWithServerScope');

    const session = createSession();
    const workingRenderable = createWorkingRenderable();
    const initialListViewData = buildSessionListViewDataWithServerScope({
        sessions: { s1: workingRenderable },
        sessionRecords: { s1: session as any },
        machines: {},
        machineRecords: {},
        groupInactiveSessionsByProject: false,
        inactiveGroupingV1: 'date',
    });

    let state: any = {
        sessions: { s1: session },
        sessionPending: {},
        sessionMessages: {},
        sessionListRenderables: { s1: workingRenderable },
        sessionListViewData: initialListViewData,
        sessionListViewDataByServerId: { server_1: initialListViewData },
        machines: {},
        machineDisplayById: {},
        settings: {
            sessionListAttentionPromotionModeV1: 'global',
            sessionListWorkingPlacementModeV1: 'global',
            groupInactiveSessionsByProject: false,
            sessionListInactiveGroupingV1: 'date',
        },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };
    const domain = createMessagesDomain({ get, set } as any);

    return { domain, get };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe('messages domain: transcript renderable aggregates', () => {
    it('maintains one transcript aggregate incrementally across streaming applies', async () => {
        const { domain, get } = await createHarness();

        domain.applyMessages('s1', [agentTextMessage('a1', 2_100, 'hel')]);
        const firstAggregate = get().sessionMessages.s1.renderableAggregate;
        expect(firstAggregate).toBeDefined();
        const firstRequestStates = firstAggregate.requestStates;

        domain.applyMessages('s1', [agentTextMessage('a2', 2_200, 'lo world')]);
        const secondAggregate = get().sessionMessages.s1.renderableAggregate;

        // Aggregate reuse identity: no full rebuild on the streaming path.
        expect(secondAggregate).toBe(firstAggregate);
        expect(secondAggregate.requestStates).toBe(firstRequestStates);
        expect(secondAggregate.latestCommittedMessageCreatedAt).toBe(2_200);
    });

    it('derives the streamed renderable identically to the full-walk builder', async () => {
        const { domain, get } = await createHarness();

        domain.applyMessages('s1', [agentTextMessage('a1', 2_100, 'hel')]);
        domain.applyMessages('s1', [agentTextMessage('a2', 2_200, 'lo world')]);

        const { buildSessionListRenderableFromSession } = await import(
            '../../domains/session/listing/sessionListRenderable'
        );
        const sessionMessages = get().sessionMessages.s1;
        const messages = sessionMessages.messageIdsOldestFirst.map(
            (id: string) => sessionMessages.messagesById[id],
        );
        const groundTruth = buildSessionListRenderableFromSession(get().sessions.s1, messages);
        const streamed = get().sessionListRenderables.s1;

        expect(streamed.meaningfulActivityAt).toBe(groundTruth.meaningfulActivityAt);
        expect(streamed.hasPendingPermissionRequests).toBe(groundTruth.hasPendingPermissionRequests);
        expect(streamed.hasPendingUserActionRequests).toBe(groundTruth.hasPendingUserActionRequests);
        expect(streamed.pendingRequestObservedAt ?? null).toBe(groundTruth.pendingRequestObservedAt ?? null);
        expect(streamed.hasUnreadMessages === true).toBe(groundTruth.hasUnreadMessages === true);
    });

    it('mutates message revisions in place instead of copying the record per apply', async () => {
        const { domain, get } = await createHarness();

        domain.applyMessages('s1', [agentTextMessage('a1', 2_100, 'hel')]);
        const revisions = get().sessionMessages.s1.messageRevisionsById;
        const firstStoredId = get().sessionMessages.s1.messageIdsOldestFirst[0];
        expect(revisions[firstStoredId]).toBe(1);

        domain.applyMessages('s1', [agentTextMessage('a2', 2_200, 'lo')]);
        const storedIds = get().sessionMessages.s1.messageIdsOldestFirst;
        expect(get().sessionMessages.s1.messageRevisionsById).toBe(revisions);
        expect(revisions[firstStoredId]).toBe(1);
        for (const storedId of storedIds) {
            expect(revisions[storedId]).toBeGreaterThanOrEqual(1);
        }
    });

    it('keeps the Session identity stable when usage and todos did not change', async () => {
        const { domain, get } = await createHarness();

        domain.applyMessages('s1', [agentTextMessage('a1', 2_100, 'hel', {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        })]);
        const sessionAfterUsage = get().sessions.s1;
        expect(sessionAfterUsage.latestUsage).toMatchObject({ inputTokens: 10, outputTokens: 5 });

        // Usage-free streaming delta: nothing user-visible changed on the
        // Session object, so its identity must not churn.
        domain.applyMessages('s1', [agentTextMessage('a2', 2_200, 'lo')]);
        expect(get().sessions.s1).toBe(sessionAfterUsage);

        // A real usage change must still produce a fresh Session identity.
        domain.applyMessages('s1', [agentTextMessage('a3', 2_300, ' world', {
            input_tokens: 20,
            output_tokens: 9,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        })]);
        expect(get().sessions.s1).not.toBe(sessionAfterUsage);
        expect(get().sessions.s1.latestUsage).toMatchObject({ inputTokens: 20, outputTokens: 9 });
    });
});
