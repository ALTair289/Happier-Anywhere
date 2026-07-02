import { resolvePermissionIntentFromSessionMetadata } from '../sessionControls/metadata.js';
import type { PermissionIntent } from '../types.js';

import { parsePermissionIntentAlias } from './index.js';

export type PermissionPrivilegeOrdinal = 0 | 1 | 2 | 3;

export type PermissionEscalationDecision =
    | {
        ok: true;
        requestedMode: string;
        requestedOrdinal: PermissionPrivilegeOrdinal;
        callerMode: string;
        callerOrdinal: PermissionPrivilegeOrdinal;
    }
    | {
        ok: false;
        reason: 'permission_escalation_denied';
        requestedMode: string;
        requestedOrdinal: PermissionPrivilegeOrdinal;
        callerMode: string;
        callerOrdinal: PermissionPrivilegeOrdinal;
    };

export type ResolvedPermissionPrivilege = Readonly<{
    mode: PermissionIntent;
    ordinal: PermissionPrivilegeOrdinal;
}>;

function isProvidedMode(rawMode: unknown): rawMode is string {
    return typeof rawMode === 'string' && rawMode.trim().length > 0;
}

function resolvePermissionPrivilege(rawMode: unknown): ResolvedPermissionPrivilege | null {
    if (!isProvidedMode(rawMode)) return null;
    const mode = parsePermissionIntentAlias(rawMode);
    if (!mode) return null;
    return {
        mode,
        ordinal: permissionIntentToPrivilegeOrdinal(mode),
    };
}

function resolveCallerPermissionPrivilege(rawMode: unknown): ResolvedPermissionPrivilege {
    return resolvePermissionPrivilege(rawMode) ?? {
        mode: 'default',
        ordinal: 1,
    };
}

function permissionIntentToPrivilegeOrdinal(mode: PermissionIntent): PermissionPrivilegeOrdinal {
    switch (mode) {
        case 'plan':
        case 'read-only':
            return 0;
        case 'default':
            return 1;
        case 'safe-yolo':
            return 2;
        case 'yolo':
            return 3;
    }
}

export function resolvePermissionPrivilegeOrdinal(rawMode: unknown): PermissionPrivilegeOrdinal | null {
    return resolvePermissionPrivilege(rawMode)?.ordinal ?? null;
}

export function resolvePermissionPrivilegeFromSessionMetadata(metadata: unknown): ResolvedPermissionPrivilege {
    const resolved = resolvePermissionIntentFromSessionMetadata(metadata);
    return resolveCallerPermissionPrivilege(resolved?.intent);
}

function buildDecision(params: Readonly<{
    requested: ResolvedPermissionPrivilege;
    caller: ResolvedPermissionPrivilege;
}>): PermissionEscalationDecision {
    if (params.requested.ordinal > params.caller.ordinal) {
        return {
            ok: false,
            reason: 'permission_escalation_denied',
            requestedMode: params.requested.mode,
            requestedOrdinal: params.requested.ordinal,
            callerMode: params.caller.mode,
            callerOrdinal: params.caller.ordinal,
        };
    }

    return {
        ok: true,
        requestedMode: params.requested.mode,
        requestedOrdinal: params.requested.ordinal,
        callerMode: params.caller.mode,
        callerOrdinal: params.caller.ordinal,
    };
}

function resolveSupportedModeAtOrBelow(params: Readonly<{
    caller: ResolvedPermissionPrivilege;
    supportedModes?: readonly string[];
}>): ResolvedPermissionPrivilege | null {
    if (!params.supportedModes || params.supportedModes.length === 0) {
        return params.caller;
    }

    let best: ResolvedPermissionPrivilege | null = null;
    for (const supportedMode of params.supportedModes) {
        const resolved = resolvePermissionPrivilege(supportedMode);
        if (!resolved || resolved.ordinal > params.caller.ordinal) continue;
        if (!best || resolved.ordinal > best.ordinal) {
            best = resolved;
        }
    }
    return best;
}

export function resolveNearestPermissionModeAtOrBelow(params: Readonly<{
    requestedMode: unknown;
    callerMode: unknown;
    supportedModes?: readonly string[];
}>): PermissionEscalationDecision {
    const caller = resolveCallerPermissionPrivilege(params.callerMode);
    const explicitRequested = resolvePermissionPrivilege(params.requestedMode);

    if (explicitRequested) {
        return buildDecision({ requested: explicitRequested, caller });
    }

    const requested = resolveSupportedModeAtOrBelow({
        caller,
        supportedModes: params.supportedModes,
    }) ?? {
        mode: 'default',
        ordinal: 1,
    };

    return buildDecision({ requested, caller });
}

export function assertNonEscalatingPermissionMode(params: Readonly<{
    requestedMode: unknown;
    callerMode: unknown;
    supportedModes?: readonly string[];
}>): PermissionEscalationDecision {
    return resolveNearestPermissionModeAtOrBelow(params);
}
