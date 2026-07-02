import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function organizationSnapshotResponse(assignments: unknown[]) {
    return {
        snapshot: {
            schemaVersion: 1,
            version: 1,
            pins: [],
            folders: [],
            folderAssignments: assignments,
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        },
    };
}

describe('fetchAndApplySessionFolderAssignments', () => {
    beforeEach(async () => {
        mocks.serverFetch.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
    });

    it('applies fetched assignments to the organization assignment cache', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([
            { sessionId: 's1', folderId: 'folder-a' },
        ])));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
        });

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-a');
        expect(getStorage().getState().sessionOrganizationLoadingByServerId['server-a']).toBe(false);
    });

    it('ignores legacy-only cached assignments when fetching missing organization assignments', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        getStorage().setState({
            sessionFolderAssignmentsBySessionKey: { 'server-a:s1': 'legacy-folder' },
            sessionOrganizationFolderAssignmentsBySessionKey: {},
        });
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([
            { sessionId: 's1', folderId: 'folder-a' },
        ])));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
            fetchPolicy: 'missing',
        });

        expect(mocks.serverFetch).toHaveBeenCalledWith(
            '/v2/session-organization?includeFolders=false&includeTags=false&includeLabels=false&assignmentSessionIds=s1',
            expect.anything(),
            expect.anything(),
        );
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-a');
    });

    it('marks requested sessions without returned assignments as unassigned', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([
            { sessionId: 's2', folderId: 'folder-b' },
        ])));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1', 's2', 's3'],
            fetchPolicy: 'missing',
        });

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey).toMatchObject({
            'server-a:s1': null,
            'server-a:s2': 'folder-b',
            'server-a:s3': null,
        });
    });

    it('does not overwrite organization assignments that become known while a missing-only fetch is in flight', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        let resolveResponse: ((response: Response) => void) | undefined;
        mocks.serverFetch.mockReturnValueOnce(new Promise((resolve) => {
            resolveResponse = resolve;
        }));

        const fetchPromise = fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
            fetchPolicy: 'missing',
        });
        getStorage().getState().applySessionFolderAssignments('server-a', [
            { sessionId: 's1', folderId: 'folder-local' },
        ]);
        resolveResponse?.(jsonResponse(organizationSnapshotResponse([])));
        await fetchPromise;

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-local');
    });

    it('does not duplicate missing-only assignment requests already in flight', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        let releaseResponses: (() => void) | undefined;
        const responseGate = new Promise<void>((resolve) => {
            releaseResponses = resolve;
        });
        mocks.serverFetch.mockImplementation(async () => {
            await responseGate;
            return jsonResponse(organizationSnapshotResponse([{ sessionId: 's1', folderId: 'folder-a' }]));
        });

        const firstFetch = fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1', 's2'],
            fetchPolicy: 'missing',
        });
        const secondFetch = fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1', 's2'],
            fetchPolicy: 'missing',
        });

        releaseResponses?.();
        await Promise.all([firstFetch, secondFetch]);

        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey).toMatchObject({
            'server-a:s1': 'folder-a',
            'server-a:s2': null,
        });
    });
});
