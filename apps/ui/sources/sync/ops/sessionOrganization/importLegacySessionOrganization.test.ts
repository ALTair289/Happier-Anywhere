import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
    fetchAccountEncryptionMode: vi.fn(),
    fetchSessionOrganizationSnapshot: vi.fn(),
    importLegacySessionOrganization: vi.fn(),
    setSessionTagAssignments: vi.fn(),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: apiMocks.fetchAccountEncryptionMode,
}));

vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return {
        ...actual,
        fetchSessionOrganizationSnapshot: apiMocks.fetchSessionOrganizationSnapshot,
        importLegacySessionOrganization: apiMocks.importLegacySessionOrganization,
        setSessionTagAssignments: apiMocks.setSessionTagAssignments,
    };
});

describe('importLegacySessionOrganization op', () => {
    beforeEach(async () => {
        apiMocks.fetchAccountEncryptionMode.mockReset();
        apiMocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
        apiMocks.fetchSessionOrganizationSnapshot.mockReset();
        apiMocks.importLegacySessionOrganization.mockReset();
        apiMocks.setSessionTagAssignments.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
    });

    it('imports the legacy batch with tag assignments atomically and refreshes organization state', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { importLegacySessionOrganization } = await import('./importLegacySessionOrganization');

        apiMocks.importLegacySessionOrganization.mockResolvedValueOnce({
            imported: {
                pins: 1,
                folders: 0,
                tags: 1,
                orderEntries: 0,
                labels: 0,
            },
        });
        apiMocks.fetchSessionOrganizationSnapshot.mockResolvedValueOnce({
            snapshot: {
                schemaVersion: 1,
                version: 10,
                pins: [{ sessionId: 's1', sortKey: '00000001', pinnedAt: 1 }],
                folders: [],
                folderAssignments: [],
                tags: [{
                    tagId: 'tag-a',
                    tagKey: 'tag-a',
                    sortKey: '00000001',
                    display: { t: 'plain', v: { label: 'tag-a' } },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                tagAssignments: [{ sessionId: 's1', tagIds: ['tag-a'] }],
                orderEntries: [],
                labels: [],
            },
        });

        await importLegacySessionOrganization({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            serverUrl: 'https://server-a.example',
            request: {
                pins: [{ sessionId: 's1', sortKey: '00000001' }],
                folders: [],
                tags: [{
                    tagId: 'tag-a',
                    tagKey: 'tag-a',
                    sortKey: '00000001',
                    display: { t: 'plain', v: { label: 'tag-a' } },
                }],
                tagAssignments: [{ sessionId: 's1', tagIds: ['tag-a'] }],
                orderEntries: [],
                labels: [],
            },
        });

        expect(apiMocks.importLegacySessionOrganization).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example',
            request: expect.objectContaining({
                pins: [{ sessionId: 's1', sortKey: '00000001' }],
                tagAssignments: [{ sessionId: 's1', tagIds: ['tag-a'] }],
            }),
        }));
        expect(apiMocks.setSessionTagAssignments).not.toHaveBeenCalled();
        expect(apiMocks.fetchSessionOrganizationSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                includeAllTagAssignments: true,
            }),
        }));

        const state = getStorage().getState();
        expect(state.sessionOrganizationPinsBySessionKey['server-a:s1']?.sortKey).toBe('00000001');
        expect(state.sessionOrganizationTagAssignmentsBySessionKey['server-a:s1']).toEqual(['tag-a']);
    });
});
