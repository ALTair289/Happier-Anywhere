import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS } from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    runtimeFetchWithServerReachability: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: mocks.runtimeFetchWithServerReachability,
}));

const credentials = { token: 'token-a', secret: 'secret-a' };

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
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

describe('sessionFolderAssignmentsApi', () => {
    beforeEach(() => {
        mocks.serverFetch.mockReset();
        mocks.runtimeFetchWithServerReachability.mockReset();
    });

    it('fetches assignments for visible sessions', async () => {
        const { fetchSessionFolderAssignmentsForSessions } = await import('./sessionFolderAssignmentsApi');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([
                { sessionId: 's1', folderId: 'folder-a' },
        ])));

        const response = await fetchSessionFolderAssignmentsForSessions({
            credentials,
            sessionIds: ['s1', 's2'],
        });

        expect(response.assignments).toEqual([
            { sessionId: 's1', folderId: 'folder-a' },
        ]);
        expect(mocks.serverFetch).toHaveBeenCalledWith(
            '/v2/session-organization?includeFolders=false&includeTags=false&includeLabels=false&assignmentSessionIds=s1%2Cs2',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token-a' }),
            }),
            { includeAuth: false },
        );
    });

    it('chunks visible-session assignment fetches to the shared server limit', async () => {
        const { fetchSessionFolderAssignmentsForSessions } = await import('./sessionFolderAssignmentsApi');
        const sessionIds = Array.from(
            { length: SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS + 2 },
            (_value, index) => `s${index}`,
        );
        mocks.serverFetch
            .mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([{ sessionId: 's0', folderId: 'folder-a' }])))
            .mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([{ sessionId: `s${SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS}`, folderId: 'folder-b' }])));

        const response = await fetchSessionFolderAssignmentsForSessions({
            credentials,
            sessionIds,
        });

        expect(response.assignments).toEqual([
            { sessionId: 's0', folderId: 'folder-a' },
            { sessionId: `s${SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS}`, folderId: 'folder-b' },
        ]);
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
        expect(decodeURIComponent(String(mocks.serverFetch.mock.calls[0]?.[0]))).toContain(
            `assignmentSessionIds=${sessionIds.slice(0, SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS).join(',')}`,
        );
        expect(decodeURIComponent(String(mocks.serverFetch.mock.calls[1]?.[0]))).toContain(
            `assignmentSessionIds=${sessionIds.slice(SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS).join(',')}`,
        );
    });

    it('sets and clears a session assignment through the canonical route', async () => {
        const { setSessionFolderAssignment } = await import('./sessionFolderAssignmentsApi');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ sessionId: 's1', folderId: 'folder-a' }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ sessionId: 's1', folderId: null }));

        await expect(setSessionFolderAssignment({ credentials, sessionId: 's1', folderId: 'folder-a' }))
            .resolves.toEqual({ sessionId: 's1', folderId: 'folder-a' });
        await expect(setSessionFolderAssignment({ credentials, sessionId: 's1', folderId: null }))
            .resolves.toEqual({ sessionId: 's1', folderId: null });

        expect(mocks.serverFetch).toHaveBeenNthCalledWith(
            1,
            '/v2/session-organization/folder-assignments/s1',
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ folderId: 'folder-a' }),
            }),
            { includeAuth: false },
        );
    });

    it('targets the row server URL when setting an assignment outside the active server', async () => {
        const { setSessionFolderAssignment } = await import('./sessionFolderAssignmentsApi');
        mocks.runtimeFetchWithServerReachability.mockResolvedValueOnce(jsonResponse({ sessionId: 's1', folderId: 'folder-a' }));

        await setSessionFolderAssignment({
            credentials,
            serverUrl: 'https://row-server.example.test/api',
            sessionId: 's1',
            folderId: 'folder-a',
        });

        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).toHaveBeenCalledWith({
            serverUrl: 'https://row-server.example.test/api',
            token: 'token-a',
            url: 'https://row-server.example.test/api/v2/session-organization/folder-assignments/s1',
            init: expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ folderId: 'folder-a' }),
            }),
        });
    });

    it('queries folder scopes using the server archived field', async () => {
        const { querySessionsByFolderScope } = await import('./sessionFolderAssignmentsApi');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ sessions: [], nextCursor: null }));

        await querySessionsByFolderScope({
            credentials,
            folderIds: ['folder-a'],
            includeArchived: true,
            cursor: 'cursor-a',
            limit: 25,
        });

        expect(mocks.serverFetch).toHaveBeenCalledWith(
            '/v2/session-folder-assignments/query',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    folderIds: ['folder-a'],
                    archived: true,
                    cursor: 'cursor-a',
                    limit: 25,
                }),
            }),
            { includeAuth: false },
        );
    });
});
