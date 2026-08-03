import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installSessionUtilsCommonModuleMocks } from './sessionUtilsTestHelpers';
import type { Session } from '@/sync/domains/state/storageTypes';

type StorageState = {
    sessions?: Record<string, unknown>;
    machines?: Record<string, unknown>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
};

let storageState: StorageState = {};

installSessionUtilsCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => storageState,
            },
        });
    },
});

function createSession(input: Readonly<{
    id: string;
    machineId: string;
    path: string;
    updatedAt?: number;
    sessionWorkspaceLocationV1?: Readonly<{
        v: 1;
        machineId: string;
        agentPath: string;
        machinePath: string;
    }>;
}>): Session {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: input.updatedAt ?? 1,
        active: true,
        activeAt: 1,
        metadata: {
            machineId: input.machineId,
            path: input.path,
            homeDir: '/Users/test',
            host: 'host.local',
            flavor: 'claude',
            ...(input.sessionWorkspaceLocationV1 ? { sessionWorkspaceLocationV1: input.sessionWorkspaceLocationV1 } : {}),
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('getRecentPathsForMachine', () => {
    beforeEach(() => {
        storageState = {
            sessions: {},
            machines: {
                'machine-target': {
                    id: 'machine-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'target.local' },
                },
            },
            getProjectForSession: () => null,
        };
    });

    it('lists the machine-visible root for a session whose agent uses a sandbox path', async () => {
        const { getRecentPathsForMachine } = await import('./recentPaths');
        const session = createSession({
            id: 'session-1',
            machineId: 'machine-target',
            path: '/home/coder/project',
            sessionWorkspaceLocationV1: {
                v: 1,
                machineId: 'machine-target',
                agentPath: '/home/coder/project',
                machinePath: '/Users/alice/project',
            },
        });
        storageState.sessions = { [session.id]: session };

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [session],
        })).toEqual(['/Users/alice/project']);
    });

    it('does not include same-host session paths that have no explicit replacement', async () => {
        const { getRecentPathsForMachine } = await import('./recentPaths');

        const session = createSession({
            id: 'session-1',
            machineId: 'machine-other',
            path: '/Users/test/workspace/rebound',
            updatedAt: 25,
        });

        storageState = {
            ...storageState,
            machines: {
                'machine-target': {
                    id: 'machine-target',
                    active: true,
                    activeAt: 100,
                    metadata: { host: 'host.local' },
                },
                'machine-other': {
                    id: 'machine-other',
                    active: false,
                    activeAt: 1,
                    metadata: { host: 'host.local' },
                },
            },
            sessions: {
                'session-1': {
                    active: false,
                    updatedAt: 25,
                    metadata: session.metadata,
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? {
                        key: {
                            machineId: 'machine-other',
                            path: '/Users/test/workspace/rebound',
                        },
                    }
                    : null,
        };

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [session],
        })).toEqual([]);
    });

    it('includes paths from explicitly replaced old machines for the current machine', async () => {
        const { getRecentPathsForMachine } = await import('./recentPaths');

        const session = createSession({
            id: 'session-1',
            machineId: 'machine-old',
            path: '/Users/test/workspace/stale',
            updatedAt: 25,
        });

        storageState = {
            ...storageState,
            machines: {
                'machine-old': {
                    id: 'machine-old',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'machine-target',
                    replacedAt: 100,
                    replacementReason: 'manual_repair',
                    replacementSource: 'manual',
                    metadata: { host: 'target.local' },
                },
                'machine-target': {
                    id: 'machine-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'target.local' },
                },
            },
            sessions: {
                'session-1': {
                    active: false,
                    updatedAt: 25,
                    metadata: session.metadata,
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? {
                        key: {
                            machineId: 'machine-target',
                            path: '/Volumes/target/workspace/rebound',
                        },
                    }
                    : null,
        };

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [session],
        })).toEqual(['/Volumes/target/workspace/rebound']);
    });

    it('canonicalizes local recent path entries through explicit machine replacement', async () => {
        const { getRecentPathsForMachine } = await import('./recentPaths');

        storageState = {
            ...storageState,
            machines: {
                'machine-old': {
                    id: 'machine-old',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'machine-target',
                    replacedAt: 100,
                    replacementReason: 'manual_repair',
                    replacementSource: 'manual',
                    metadata: { host: 'target.local' },
                },
                'machine-target': {
                    id: 'machine-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'target.local' },
                },
            },
        };

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [{ machineId: 'machine-old', path: '/Users/test/workspace/local' }],
            sessions: [],
        })).toEqual(['/Users/test/workspace/local']);
    });

    it('includes projected session path entries without requiring full volatile session objects', async () => {
        const { encodeSessionRecentPathEntry } = await import('./recentPathEntries');
        const { getRecentPathsForMachine } = await import('./recentPaths');

        storageState = {
            ...storageState,
            machines: {
                'machine-target': {
                    id: 'machine-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'target.local' },
                },
            },
        };

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [
                encodeSessionRecentPathEntry({
                    sessionId: 'session-later',
                    machineId: 'machine-target',
                    path: '/Users/test/workspace/later',
                    createdAt: 20,
                }),
                encodeSessionRecentPathEntry({
                    sessionId: 'session-earlier',
                    machineId: 'machine-target',
                    path: '/Users/test/workspace/earlier',
                    createdAt: 10,
                }),
            ],
        })).toEqual([
            '/Users/test/workspace/later',
            '/Users/test/workspace/earlier',
        ]);
    });

    it('keeps recent paths stable when same-host activeAt values flip', async () => {
        const { getRecentPathsForMachine } = await import('./recentPaths');

        const session = createSession({
            id: 'session-1',
            machineId: 'machine-b',
            path: '/Users/test/workspace/other',
            updatedAt: 25,
        });

        storageState = {
            ...storageState,
            machines: {
                'machine-target': {
                    id: 'machine-target',
                    active: true,
                    activeAt: 100,
                    metadata: { host: 'host.local' },
                },
                'machine-b': {
                    id: 'machine-b',
                    active: true,
                    activeAt: 200,
                    metadata: { host: 'host.local' },
                },
            },
            sessions: {
                'session-1': {
                    active: true,
                    updatedAt: 25,
                    metadata: session.metadata,
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? {
                        key: {
                            machineId: 'machine-b',
                            path: '/Users/test/workspace/other',
                        },
                    }
                    : null,
        };

        const first = getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [{ machineId: 'machine-target', path: '/Users/test/workspace/current' }],
            sessions: [session],
        });

        storageState = {
            ...storageState,
            machines: {
                'machine-target': {
                    id: 'machine-target',
                    active: true,
                    activeAt: 300,
                    metadata: { host: 'host.local' },
                },
                'machine-b': {
                    id: 'machine-b',
                    active: true,
                    activeAt: 100,
                    metadata: { host: 'host.local' },
                },
            },
        };

        const second = getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [{ machineId: 'machine-target', path: '/Users/test/workspace/current' }],
            sessions: [session],
        });

        expect(first).toEqual(['/Users/test/workspace/current']);
        expect(second).toEqual(first);
    });
});
