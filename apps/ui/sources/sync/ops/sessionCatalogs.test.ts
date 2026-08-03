import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const {
    applySessionsMock,
    machineRpcWithServerScopeMock,
    sessionRpcWithServerScopeMock,
    readMachineControlTargetForSessionMock,
} = vi.hoisted(() => ({
    applySessionsMock: vi.fn(),
    machineRpcWithServerScopeMock: vi.fn(),
    sessionRpcWithServerScopeMock: vi.fn(),
    readMachineControlTargetForSessionMock: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            sessions: {
                'session-1': {
                    id: 'session-1',
                    active: false,
                    metadata: {
                        path: '/home/coder/project',
                    },
                },
            },
            applySessions: applySessionsMock,
        }),
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server-1',
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params),
}));

vi.mock('./sessionMachineTarget', () => ({
    readMachineControlTargetForSession: (sessionId: string) => readMachineControlTargetForSessionMock(sessionId),
}));

import { ensureSessionSuggestionCatalogs } from './sessionCatalogs';

describe('ensureSessionSuggestionCatalogs', () => {
    beforeEach(() => {
        applySessionsMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        sessionRpcWithServerScopeMock.mockReset();
        readMachineControlTargetForSessionMock.mockReset();
    });

    it('uses the machine-visible workspace root for inactive-session catalog discovery', async () => {
        readMachineControlTargetForSessionMock.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/Users/alice/project',
            agentBasePath: '/home/coder/project',
            confidence: 'reachable',
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ skills: [] });

        await ensureSessionSuggestionCatalogs('session-1', { skills: true });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST,
            payload: {
                sessionId: 'session-1',
                cwd: '/Users/alice/project',
            },
        });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
