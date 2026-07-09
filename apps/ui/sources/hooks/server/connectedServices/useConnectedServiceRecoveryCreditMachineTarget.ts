import * as React from 'react';

import {
    readSessionMetadataConnectedServiceBindings,
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
    ConnectedServiceBindingsV1Schema,
    type AccountProfile,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import { useAllMachines, useProfile, useSessions } from '@/sync/domains/state/storage';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

type AccountProfileConnectedService = AccountProfile['connectedServicesV2'][number];

function buildRecordById<T extends Readonly<{ id: string }>>(items: ReadonlyArray<T>): Record<string, T> {
    const record: Record<string, T> = {};
    for (const item of items) {
        record[item.id] = item;
    }
    return record;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readSessionConnectedServiceBindings(
    session: Session,
    agentId: string,
): ConnectedServiceBindingsV1 | null {
    const metadata = readRecord(session.metadata);
    const connectedServices = readRecord(metadata?.connectedServices);
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(connectedServices);
    if (parsed.success) return parsed.data;

    const descriptorBindings = readSessionMetadataConnectedServiceBindings(session.metadata, agentId);
    const parsedDescriptorBindings = ConnectedServiceBindingsV1Schema.safeParse({
        v: 1,
        bindingsByServiceId: descriptorBindings,
    });
    return parsedDescriptorBindings.success ? parsedDescriptorBindings.data : null;
}

function bindingTargetsProfile(params: Readonly<{
    binding: ConnectedServiceBindingSelectionV1 | undefined;
    services: ReadonlyArray<AccountProfileConnectedService>;
    serviceId: ConnectedServiceId;
    profileId: string;
}>): boolean {
    const { binding, services, serviceId, profileId } = params;
    if (!binding || binding.source !== 'connected') return false;
    if (binding.selection !== 'group') return binding.profileId === profileId;
    if (binding.profileId === profileId) return true;

    const service = services.find((candidate) => candidate.serviceId === serviceId) ?? null;
    const group = service?.groups.find((candidate) => candidate.groupId === binding.groupId) ?? null;
    return group?.activeProfileId === profileId;
}

function bindingTargetsGroup(params: Readonly<{
    binding: ConnectedServiceBindingSelectionV1 | undefined;
    groupId: string;
}>): boolean {
    const { binding, groupId } = params;
    return binding?.source === 'connected'
        && binding.selection === 'group'
        && binding.groupId === groupId;
}

/**
 * Typed reason a live hot-apply machine target could not be resolved, so callers
 * can explain WHY instead of collapsing every miss to a generic "request failed":
 * - `no_bound_session`: no active session is currently bound to this profile/pool,
 *   so there is nothing to hot-apply to right now (it applies on next resume).
 * - `machine_offline`: an active session IS bound, but its controlling machine is
 *   offline/unreachable, so the change cannot reach a running session.
 */
export type ConnectedServiceBindingMachineTargetReason = 'no_bound_session' | 'machine_offline';

export type ConnectedServiceBindingMachineTargetStatus =
    | Readonly<{ machineId: string; reason?: undefined }>
    | Readonly<{ machineId: null; reason: ConnectedServiceBindingMachineTargetReason }>;

function resolveConnectedServiceBindingMachineTargetStatus(params: Readonly<{
    serviceId: ConnectedServiceId;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
    matchesBinding: (binding: ConnectedServiceBindingSelectionV1 | undefined) => boolean;
}>): ConnectedServiceBindingMachineTargetStatus {
    if (!params.sessions || params.sessions.length === 0) {
        return { machineId: null, reason: 'no_bound_session' };
    }

    const machineById = buildRecordById(params.machines);
    const state = {
        sessions: buildRecordById(params.sessions),
        machines: machineById,
    };

    let hadMatchingBinding = false;
    for (const session of params.sessions) {
        if (!session.active) continue;

        const agentId = resolveAgentIdFromSessionMetadata(session.metadata);
        if (!agentId) continue;

        const bindings = readSessionConnectedServiceBindings(session, agentId);
        if (!params.matchesBinding(bindings?.bindingsByServiceId[params.serviceId])) continue;

        hadMatchingBinding = true;
        const target = resolveMachineControlTargetForSessionFromState(state, session.id);
        const machineId = target?.machineId ?? null;
        if (!machineId) continue;

        const machine = machineById[machineId];
        if (machine && isMachineOnline(machine)) return { machineId: machine.id };
    }

    return { machineId: null, reason: hadMatchingBinding ? 'machine_offline' : 'no_bound_session' };
}

function resolveConnectedServiceBindingMachineTarget(params: Readonly<{
    serviceId: ConnectedServiceId;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
    matchesBinding: (binding: ConnectedServiceBindingSelectionV1 | undefined) => boolean;
}>): string | null {
    return resolveConnectedServiceBindingMachineTargetStatus(params).machineId;
}

export function resolveConnectedServiceRecoveryCreditMachineTarget(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
    connectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
}>): string | null {
    return resolveConnectedServiceBindingMachineTarget({
        serviceId: params.serviceId,
        sessions: params.sessions,
        machines: params.machines,
        matchesBinding: (binding) => bindingTargetsProfile({
            binding,
            services: params.connectedServicesV2,
            serviceId: params.serviceId,
            profileId: params.profileId,
        }),
    });
}

export function resolveConnectedServiceGroupBindingMachineTarget(params: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
}>): string | null {
    return resolveConnectedServiceBindingMachineTarget({
        serviceId: params.serviceId,
        sessions: params.sessions,
        machines: params.machines,
        matchesBinding: (binding) => bindingTargetsGroup({ binding, groupId: params.groupId }),
    });
}

export function useConnectedServiceRecoveryCreditMachineTarget(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
}>): string | null {
    const sessions = useSessions();
    const machines = useAllMachines();
    const profile = useProfile();

    return React.useMemo(() => resolveConnectedServiceRecoveryCreditMachineTarget({
        serviceId: params.serviceId,
        profileId: params.profileId,
        sessions,
        machines,
        connectedServicesV2: profile.connectedServicesV2 ?? [],
    }), [machines, params.profileId, params.serviceId, profile.connectedServicesV2, sessions]);
}

export function resolveConnectedServiceGroupBindingMachineTargetStatus(params: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
}>): ConnectedServiceBindingMachineTargetStatus {
    return resolveConnectedServiceBindingMachineTargetStatus({
        serviceId: params.serviceId,
        sessions: params.sessions,
        machines: params.machines,
        matchesBinding: (binding) => bindingTargetsGroup({ binding, groupId: params.groupId }),
    });
}

export function useConnectedServiceGroupBindingMachineTarget(params: Readonly<{
    serviceId: ConnectedServiceId | null;
    groupId: string;
}>): string | null {
    return useConnectedServiceGroupBindingMachineTargetStatus(params).machineId;
}

export function useConnectedServiceGroupBindingMachineTargetStatus(params: Readonly<{
    serviceId: ConnectedServiceId | null;
    groupId: string;
}>): ConnectedServiceBindingMachineTargetStatus {
    const sessions = useSessions();
    const machines = useAllMachines();

    return React.useMemo(() => {
        if (!params.serviceId || !params.groupId) return { machineId: null, reason: 'no_bound_session' };
        return resolveConnectedServiceGroupBindingMachineTargetStatus({
            serviceId: params.serviceId,
            groupId: params.groupId,
            sessions,
            machines,
        });
    }, [machines, params.groupId, params.serviceId, sessions]);
}
