import { describe, expect, it } from 'vitest';

import {
    resolveConnectedServiceGroupBindingMachineTargetStatus,
} from './useConnectedServiceRecoveryCreditMachineTarget';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';

const SERVICE_ID = 'openai-codex' as const;
const GROUP_ID = 'team';

function machine(id: string, online: boolean): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: online,
        activeAt: online ? Date.now() : 0,
        revokedAt: null,
        metadata: {
            host: id,
            platform: 'darwin',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/tmp/happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    } as unknown as Machine;
}

function groupBoundSession(id: string, machineId: string): Session {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        presence: 'online',
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        metadata: {
            path: '/repo',
            machineId,
            flavor: 'codex',
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    [SERVICE_ID]: { source: 'connected', selection: 'group', groupId: GROUP_ID },
                },
            },
        },
        agentState: null,
    } as unknown as Session;
}

describe('resolveConnectedServiceGroupBindingMachineTargetStatus', () => {
    it('returns no_bound_session when no active session is bound to the pool', () => {
        const status = resolveConnectedServiceGroupBindingMachineTargetStatus({
            serviceId: SERVICE_ID,
            groupId: GROUP_ID,
            sessions: [],
            machines: [machine('machine-1', true)],
        });
        expect(status).toEqual({ machineId: null, reason: 'no_bound_session' });
    });

    it('returns machine_offline when a bound session exists but its machine is offline', () => {
        const status = resolveConnectedServiceGroupBindingMachineTargetStatus({
            serviceId: SERVICE_ID,
            groupId: GROUP_ID,
            sessions: [groupBoundSession('session-1', 'machine-1')],
            machines: [machine('machine-1', false)],
        });
        expect(status).toEqual({ machineId: null, reason: 'machine_offline' });
    });

    it('resolves the online machine hosting a bound session', () => {
        const status = resolveConnectedServiceGroupBindingMachineTargetStatus({
            serviceId: SERVICE_ID,
            groupId: GROUP_ID,
            sessions: [groupBoundSession('session-1', 'machine-1')],
            machines: [machine('machine-1', true)],
        });
        expect(status).toEqual({ machineId: 'machine-1' });
    });
});
