import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from '@happier-dev/protocol';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }
    }

    return { MMKV };
});

import {
    buildLegacySessionOrganizationImportPlan,
    hasCompletedLegacySessionOrganizationImport,
    markLegacySessionOrganizationImportComplete,
} from './legacySessionOrganizationImport';

describe('legacySessionOrganizationImport', () => {
    beforeEach(() => {
        store.clear();
    });

    it('extracts migrated organization fields from legacy account settings for one server', () => {
        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'server-a',
            rawSettings: {
                pinnedSessionKeysV1: [
                    'server-a:s1',
                    'server-b:s-other',
                    's2',
                    'server-a:s1',
                ],
                sessionFoldersV1: {
                    v: 1,
                    folders: [
                        {
                            id: 'folder-a',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-a',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: null,
                            name: 'Planning',
                            createdAt: 10,
                            updatedAt: 20,
                            sortKey: 'folder-rank-a',
                        },
                        {
                            id: 'folder-other',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-b',
                                machineId: 'machine-b',
                                rootPath: '/other',
                            },
                            parentId: null,
                            name: 'Other server',
                            createdAt: 10,
                            updatedAt: 20,
                        },
                    ],
                },
                sessionTagsV1: {
                    'server-a:s1': ['urgent', 'followup', 'urgent'],
                    s2: ['followup'],
                    'server-b:s-other': ['skip'],
                },
                sessionListGroupOrderV1: {
                    [PINNED_GROUP_KEY_V1]: ['server-a:s1', 'server-a:s2', 'server-b:s-other'],
                    'folder:folder-a': ['server-a:s2', 'server-a:s1'],
                },
                sessionWorkspaceOrderV1: {
                    'server:server-a:workspaces': ['workspace:/repo', 'workspace:/other'],
                    'server:server-b:workspaces': ['workspace:/skip'],
                },
                workspaceLabelsV1: {
                    'server:server-a:workspace:/repo': 'Repo label',
                    'server:server-b:workspace:/skip': 'Skip label',
                },
            },
        });

        expect(plan.request.pins).toEqual([
            { sessionId: 's1', sortKey: '00000001' },
            { sessionId: 's2', sortKey: '00000003' },
        ]);
        expect(plan.request.folders).toEqual([
            expect.objectContaining({
                folderId: 'folder-a',
                folderKey: 'folder-a',
                parentFolderId: null,
                parentFolderKey: null,
                sortKey: 'folder-rank-a',
                display: {
                    t: 'plain',
                    v: {
                        name: 'Planning',
                        workspace: {
                            t: 'workspaceScope',
                            serverId: 'server-a',
                            machineId: 'machine-a',
                            rootPath: '/repo',
                        },
                    },
                },
            }),
        ]);
        expect(plan.request.tags).toEqual([
            {
                tagId: 'urgent',
                tagKey: 'urgent',
                sortKey: '00000001',
                display: { t: 'plain', v: { label: 'urgent' } },
            },
            {
                tagId: 'followup',
                tagKey: 'followup',
                sortKey: '00000002',
                display: { t: 'plain', v: { label: 'followup' } },
            },
        ]);
        expect(plan.request.tagAssignments).toEqual([
            { sessionId: 's1', tagIds: ['urgent', 'followup'] },
            { sessionId: 's2', tagIds: ['followup'] },
        ]);
        expect(plan.tagAssignments).toEqual([
            { sessionId: 's1', tagIds: ['urgent', 'followup'] },
            { sessionId: 's2', tagIds: ['followup'] },
        ]);
        expect(plan.request.orderEntries).toEqual([
            { scopeKind: 'pinned', scopeKey: 'pins', itemKind: 'session', itemKey: 's1', sortKey: '00000001' },
            { scopeKind: 'pinned', scopeKey: 'pins', itemKind: 'session', itemKey: 's2', sortKey: '00000002' },
            { scopeKind: 'group', scopeKey: 'folder:folder-a', itemKind: 'session', itemKey: 's2', sortKey: '00000001' },
            { scopeKind: 'group', scopeKey: 'folder:folder-a', itemKind: 'session', itemKey: 's1', sortKey: '00000002' },
            { scopeKind: 'workspace', scopeKey: 'server-a', itemKind: 'workspace', itemKey: '/repo', sortKey: '00000001' },
            { scopeKind: 'workspace', scopeKey: 'server-a', itemKind: 'workspace', itemKey: '/other', sortKey: '00000002' },
        ]);
        expect(plan.request.labels).toEqual([
            {
                labelKind: 'workspace',
                scopeKey: 'server:server-a:workspace:/repo',
                display: { t: 'plain', v: { label: 'Repo label' } },
            },
        ]);
        expect(plan.hasImportableLegacyOrganization).toBe(true);
    });

    it('maps oversized legacy folder and tag ids to provider-safe ids while preserving legacy keys', () => {
        const longFolderId = `folder-${'f'.repeat(240)}`;
        const longChildFolderId = `child-${'c'.repeat(240)}`;
        const longTagId = `tag-${'t'.repeat(240)}`;
        const longSortKey = 's'.repeat(240);

        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'server-a',
            rawSettings: {
                sessionFoldersV1: {
                    v: 1,
                    folders: [
                        {
                            id: longFolderId,
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-a',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: null,
                            name: 'Long folder',
                            createdAt: 10,
                            updatedAt: 20,
                            sortKey: longSortKey,
                        },
                        {
                            id: longChildFolderId,
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-a',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: longFolderId,
                            name: 'Long child',
                            createdAt: 11,
                            updatedAt: 21,
                        },
                    ],
                },
                sessionTagsV1: {
                    'server-a:s1': [longTagId],
                },
                sessionListGroupOrderV1: {
                    [`folder:${longFolderId}`]: [`folder:${longChildFolderId}`, 'server-a:s1'],
                },
            },
        });

        const [folder, childFolder] = plan.request.folders;
        if (!folder || !childFolder) {
            throw new Error('expected long legacy folders to be importable');
        }
        const folderId = folder.folderId;
        const childFolderId = childFolder.folderId;
        if (!folderId || !childFolderId) {
            throw new Error('expected long legacy folders to have provider-safe ids');
        }
        expect(folderId).not.toBe(longFolderId);
        expect(folderId.length).toBeLessThanOrEqual(SESSION_ORGANIZATION_MAX_ID_LENGTH);
        expect(folder).toEqual(expect.objectContaining({
            folderKey: longFolderId,
            parentFolderId: null,
            parentFolderKey: null,
            sortKey: '00000001',
        }));
        expect(childFolderId).not.toBe(longChildFolderId);
        expect(childFolderId.length).toBeLessThanOrEqual(SESSION_ORGANIZATION_MAX_ID_LENGTH);
        expect(childFolder).toEqual(expect.objectContaining({
            folderKey: longChildFolderId,
            parentFolderId: folderId,
            parentFolderKey: longFolderId,
        }));

        const [tag] = plan.request.tags;
        if (!tag) {
            throw new Error('expected long legacy tag to be importable');
        }
        const tagId = tag.tagId;
        if (!tagId) {
            throw new Error('expected long legacy tag to have a provider-safe id');
        }
        expect(tagId).not.toBe(longTagId);
        expect(tagId.length).toBeLessThanOrEqual(SESSION_ORGANIZATION_MAX_ID_LENGTH);
        expect(tag).toEqual(expect.objectContaining({
            tagKey: longTagId,
            display: { t: 'plain', v: { label: longTagId } },
        }));
        expect(plan.request.tagAssignments).toEqual([{ sessionId: 's1', tagIds: [tagId] }]);
        expect(plan.request.orderEntries).toEqual([
            { scopeKind: 'group', scopeKey: `folder:${folderId}`, itemKind: 'folder', itemKey: childFolderId, sortKey: '00000001' },
            { scopeKind: 'group', scopeKey: `folder:${folderId}`, itemKind: 'session', itemKey: 's1', sortKey: '00000002' },
        ]);
    });

    it('keeps legacy tag assignments importable when only tag definitions already exist on the server', () => {
        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'server-a',
            rawSettings: {
                pinnedSessionKeysV1: ['server-a:s1'],
                sessionTagsV1: { 'server-a:s1': ['urgent'] },
                sessionListGroupOrderV1: { [PINNED_GROUP_KEY_V1]: ['server-a:s1'] },
                workspaceLabelsV1: { 'server:server-a:workspace:/repo': 'Old' },
            },
            existingSnapshot: {
                schemaVersion: 1,
                version: 4,
                pins: [{ sessionId: 's-new', sortKey: 'a', pinnedAt: 1 }],
                folders: [],
                folderAssignments: [],
                tags: [{
                    tagId: 'new-tag',
                    tagKey: 'new-tag',
                    sortKey: 'a',
                    display: { t: 'plain', v: { label: 'New' } },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                tagAssignments: [],
                orderEntries: [{ scopeKind: 'pinned', scopeKey: 'pins', itemKind: 'session', itemKey: 's-new', sortKey: 'a' }],
                labels: [{
                    labelKind: 'workspace',
                    scopeKey: 'server:server-a:workspace:/repo',
                    display: { t: 'plain', v: { label: 'New' } },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
        });

        expect(plan.request.pins).toEqual([{ sessionId: 's1', sortKey: '00000001' }]);
        expect(plan.request.tags).toEqual([{
            tagId: 'urgent',
            tagKey: 'urgent',
            sortKey: '00000001',
            display: { t: 'plain', v: { label: 'urgent' } },
        }]);
        expect(plan.request.tagAssignments).toEqual([{ sessionId: 's1', tagIds: ['urgent'] }]);
        expect(plan.tagAssignments).toEqual([{ sessionId: 's1', tagIds: ['urgent'] }]);
        expect(plan.request.orderEntries).toEqual([
            { scopeKind: 'pinned', scopeKey: 'pins', itemKind: 'session', itemKey: 's1', sortKey: '00000001' },
        ]);
        expect(plan.request.labels).toEqual([]);
        expect(plan.hasImportableLegacyOrganization).toBe(true);
    });

    it('keeps missing legacy tag assignments importable when a retry snapshot has partial assignments', () => {
        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'server-a',
            rawSettings: {
                sessionTagsV1: {
                    'server-a:s1': ['urgent', 'review'],
                    'server-a:s2': ['urgent'],
                },
            },
            existingSnapshot: {
                schemaVersion: 1,
                version: 5,
                pins: [],
                folders: [],
                folderAssignments: [],
                tags: [
                    {
                        tagId: 'urgent',
                        tagKey: 'urgent',
                        sortKey: '00000001',
                        display: { t: 'plain', v: { label: 'urgent' } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        tagId: 'review',
                        tagKey: 'review',
                        sortKey: '00000002',
                        display: { t: 'plain', v: { label: 'review' } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                tagAssignments: [
                    { sessionId: 's1', tagIds: ['urgent'] },
                ],
                orderEntries: [],
                labels: [],
            },
        });

        expect(plan.request.tags).toEqual([]);
        expect(plan.request.tagAssignments).toEqual([
            { sessionId: 's1', tagIds: ['urgent', 'review'] },
            { sessionId: 's2', tagIds: ['urgent'] },
        ]);
        expect(plan.tagAssignments).toEqual([
            { sessionId: 's1', tagIds: ['urgent', 'review'] },
            { sessionId: 's2', tagIds: ['urgent'] },
        ]);
        expect(plan.hasImportableLegacyOrganization).toBe(true);
    });

    it('keeps missing legacy folders, tags, order, and labels importable when retry snapshot is partial', () => {
        const missingFolderId = `folder-${'f'.repeat(240)}`;
        const missingTagId = `tag-${'t'.repeat(240)}`;

        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'server-a',
            rawSettings: {
                sessionFoldersV1: {
                    v: 1,
                    folders: [
                        {
                            id: 'existing-folder',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-a',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: null,
                            name: 'Existing',
                            createdAt: 1,
                            updatedAt: 2,
                        },
                        {
                            id: missingFolderId,
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-a',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: null,
                            name: 'Missing',
                            createdAt: 3,
                            updatedAt: 4,
                        },
                    ],
                },
                sessionTagsV1: {
                    'server-a:s1': ['existing-tag', missingTagId],
                },
                sessionListGroupOrderV1: {
                    [`folder:${missingFolderId}`]: ['server-a:s1'],
                },
                workspaceLabelsV1: {
                    'server:server-a:workspace:/existing': 'Existing',
                    'server:server-a:workspace:/missing': 'Missing',
                },
            },
            existingSnapshot: {
                schemaVersion: 1,
                version: 7,
                pins: [],
                folders: [
                    {
                        folderId: 'existing-folder',
                        folderKey: 'existing-folder',
                        parentFolderId: null,
                        parentFolderKey: null,
                        sortKey: null,
                        display: { t: 'plain', v: { name: 'Existing' } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                ],
                folderAssignments: [],
                tags: [
                    {
                        tagId: 'existing-tag',
                        tagKey: 'existing-tag',
                        sortKey: '00000001',
                        display: { t: 'plain', v: { label: 'existing-tag' } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                tagAssignments: [],
                orderEntries: [
                    {
                        scopeKind: 'folder',
                        scopeKey: 'existing-folder',
                        itemKind: 'session',
                        itemKey: 's1',
                        sortKey: '00000001',
                    },
                ],
                labels: [
                    {
                        labelKind: 'workspace',
                        scopeKey: 'server:server-a:workspace:/existing',
                        display: { t: 'plain', v: { label: 'Existing' } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
        });

        const [missingFolder] = plan.request.folders;
        if (!missingFolder?.folderId) {
            throw new Error('expected missing long legacy folder to remain importable');
        }
        const [missingTag] = plan.request.tags;
        if (!missingTag?.tagId) {
            throw new Error('expected missing long legacy tag to remain importable');
        }

        expect(plan.request.folders).toHaveLength(1);
        expect(missingFolder).toEqual(expect.objectContaining({
            folderKey: missingFolderId,
        }));
        expect(plan.request.tags).toEqual([expect.objectContaining({
            tagId: missingTag.tagId,
            tagKey: missingTagId,
        })]);
        expect(plan.request.tagAssignments).toEqual([
            { sessionId: 's1', tagIds: ['existing-tag', missingTag.tagId] },
        ]);
        expect(plan.request.orderEntries).toEqual([
            {
                scopeKind: 'group',
                scopeKey: `folder:${missingFolder.folderId}`,
                itemKind: 'session',
                itemKey: 's1',
                sortKey: '00000001',
            },
        ]);
        expect(plan.request.labels).toEqual([
            {
                labelKind: 'workspace',
                scopeKey: 'server:server-a:workspace:/missing',
                display: { t: 'plain', v: { label: 'Missing' } },
            },
        ]);
        expect(plan.hasImportableLegacyOrganization).toBe(true);
    });

    it('marks a legacy organization import complete per account settings scope', () => {
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        const otherScope = { serverId: 'server-a', accountId: 'account-b' };

        expect(hasCompletedLegacySessionOrganizationImport(scope)).toBe(false);
        markLegacySessionOrganizationImportComplete(scope);

        expect(hasCompletedLegacySessionOrganizationImport(scope)).toBe(true);
        expect(hasCompletedLegacySessionOrganizationImport(otherScope)).toBe(false);
    });
});
