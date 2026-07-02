import * as React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { installConnectionStatusCommonModuleMocks } from './connectionStatusTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let endpointStatus: import('@happier-dev/connection-supervisor').ManagedConnectionPhase = 'online';
let endpointReason: import('@happier-dev/connection-supervisor').ManagedConnectionReason = null;
let socketStatus: import('./connectionHealthTypes').ConnectionSocketStatus = 'connected';
let syncErrorKind: 'auth' | 'network' | null = null;
let syncErrorServerId: string | null = null;
let accountSettingsSyncStatus:
    | { state: 'idle' | 'synced'; lastSyncedAt: number | null }
    | { state: 'retrying' | 'failed'; message: string; retryable: boolean; kind: 'auth' | 'config' | 'network' | 'server' | 'unknown'; at: number }
    = { state: 'idle', lastSyncedAt: null };
let machines: Array<Record<string, unknown>> = [];

installConnectionStatusCommonModuleMocks({
    activeSelectionMachineGroups: () => ({
        useActiveSelectionMachineGroups: () => ({
            visibleMachineGroups: [{ status: 'idle', machines }],
        }),
    }),
    serverProfiles: () => ({
        getActiveServerSnapshot: () => ({ serverId: 'server-a', generation: 1 }),
        listServerProfiles: () => [{ id: 'server-a', name: 'Server A', serverUrl: 'https://api.example.test' }],
    }),
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useEndpointConnectivity: () => ({
                status: endpointStatus,
                reason: endpointReason,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            }),
            useSocketStatus: () => ({ status: socketStatus }),
            useSyncError: () =>
                syncErrorKind
                    ? {
                        message: 'boom',
                        retryable: syncErrorKind !== 'auth',
                        kind: syncErrorKind,
                        at: Date.now(),
                        ...(syncErrorServerId ? { serverId: syncErrorServerId } : {}),
                    }
                    : null,
            useAccountSettingsSyncStatus: () => accountSettingsSyncStatus,
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useSetting: () => null,
        });
    },
});

describe('useConnectionHealth (endpoint connectivity integration)', () => {
    beforeEach(() => {
        endpointStatus = 'online';
        endpointReason = null;
        socketStatus = 'connected';
        syncErrorKind = null;
        syncErrorServerId = null;
        accountSettingsSyncStatus = { state: 'idle', lastSyncedAt: null };
        machines = [];
    });

    it('prioritizes endpoint offline over socket connected + sync errors', async () => {
        endpointStatus = 'offline';
        socketStatus = 'connected';
        syncErrorKind = 'network';

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('server_unreachable');
    });

    it('renders planned server restarts as neutral reconnect with known machine state', async () => {
        endpointStatus = 'offline';
        endpointReason = 'server_restarting';
        socketStatus = 'disconnected';
        machines = [
            { id: 'm1', active: true, activeAt: Date.now(), revokedAt: null, daemonState: { status: 'running' } },
        ];

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('server_restarting');
        expect(hook.getCurrent().tone).toBe('neutral');
        expect(hook.getCurrent().statusLabelKey).toBe('status.connecting');
        expect(hook.getCurrent().machineLabelKey).toBe('status.online');
    });

    it('surfaces auth_required when endpoint auth_failed', async () => {
        endpointStatus = 'auth_failed';
        socketStatus = 'connected';

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('auth_required');
        expect(hook.getCurrent().statusLabelKey).toBe('status.actionRequired');
    });

    it('surfaces auth_required when a terminal auth sync error is present', async () => {
        endpointStatus = 'online';
        socketStatus = 'error';
        syncErrorKind = 'auth';

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('auth_required');
        expect(hook.getCurrent().statusLabelKey).toBe('status.actionRequired');
    });

    it('ignores auth sync errors that belong to a different server profile', async () => {
        endpointStatus = 'online';
        socketStatus = 'connected';
        syncErrorKind = 'auth';
        syncErrorServerId = 'server-b';

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('no_machine');
    });

    it('surfaces account settings retry state through the connection health model', async () => {
        endpointStatus = 'online';
        socketStatus = 'connected';
        accountSettingsSyncStatus = {
            state: 'retrying',
            message: 'settings sync failed',
            retryable: true,
            kind: 'network',
            at: Date.now(),
        };

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('server_error');
        expect(hook.getCurrent().statusLabelKey).toBe('status.error');
    });

    it('surfaces machine_not_ready when machines are online but none are ready', async () => {
        endpointStatus = 'online';
        socketStatus = 'connected';
        machines = [
            { id: 'm1', active: true, activeAt: Date.now(), revokedAt: null, daemonState: { status: 'offline' } },
            { id: 'm2', active: true, activeAt: Date.now(), revokedAt: null, daemonState: { status: 'offline' } },
        ];

        const { useConnectionHealth } = await import('./useConnectionHealth');
        const hook = await renderHook(() => useConnectionHealth());

        expect(hook.getCurrent().kind).toBe('machine_not_ready');
        expect(hook.getCurrent().statusLabelKey).toBe('status.actionRequired');
        expect(hook.getCurrent().machineLabelKey).toBe('status.online');
    });
});
