import type { ResumeSessionOptions } from '@/sync/ops';
import type { Session } from '../state/storageTypes';
import { resolveAgentIdFromFlavor, buildWakeResumeExtras } from '@/agents/catalog/catalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { deriveSessionInputReadinessState } from '@/sync/domains/session/control/deriveSessionInputReadinessState';
import { getSessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';
import {
    deriveLatestPendingRequestObservedAtFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';

export type PendingQueueWakeResumeOptions = ResumeSessionOptions;

type PendingQueueWakeTargetOverride = Readonly<{
    machineId?: string | null;
    directory?: string | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function getPendingQueueWakeResumeOptions(opts: {
    sessionId: string;
    session: Session;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    resumeTargetOverride?: PendingQueueWakeTargetOverride | null;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
    nowMs?: number;
    // Optional: gate waking behind an external capability check (e.g. local machine encryption).
    // This is used to avoid attempting machine RPCs in contexts where the client cannot encrypt them.
    canWakeMachineId?: (machineId: string) => boolean;
}): PendingQueueWakeResumeOptions | null {
    const { sessionId, session, resumeCapabilityOptions, resumeTargetOverride, permissionOverride, canWakeMachineId } = opts;

    // Only gate waking on foreground input readiness when the session is actively running.
    // For inactive/archived sessions, `thinking` / `agentState.requests` can be stale; blocking wake would
    // strand pending-queue messages until the user sends another message (or the state refreshes).
    const isSessionActive = session.active === true && session.presence === 'online';
    if (isSessionActive) {
        const localControl = getSessionLocalControlState(session);
        if (localControl?.attached === true && localControl.remoteWritable !== true) {
            return null;
        }
        const requests = session.agentState?.requests;
        const hasRuntimeRequests = Boolean(requests && Object.keys(requests).length > 0);
        const inputReadiness = deriveSessionInputReadinessState({
            active: session.active,
            activeAt: session.activeAt,
            presence: session.presence,
            thinking: session.thinking,
            thinkingAt: session.thinkingAt,
            latestTurnStatus: session.latestTurnStatus,
            latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
            hasPendingPermissionRequests: hasRuntimeRequests,
            hasPendingUserActionRequests: hasRuntimeRequests,
            pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session),
        }, opts.nowMs ?? Date.now());
        if (!inputReadiness.canWakePendingQueue) {
            return null;
        }
    }

    const reachableTarget = readMachineControlTargetForSession(sessionId);
    const machineId = normalizeNonEmptyString(resumeTargetOverride?.machineId)
        ?? normalizeNonEmptyString(reachableTarget?.machineId);
    const directory = normalizeNonEmptyString(resumeTargetOverride?.directory)
        ?? normalizeNonEmptyString(reachableTarget?.basePath);
    if (!machineId || !directory) return null;
    if (canWakeMachineId && canWakeMachineId(machineId) === false) return null;

    const agentId = resolveAgentIdFromSessionMetadata(session.metadata) ?? resolveAgentIdFromFlavor(session.metadata?.flavor);
    if (!agentId) return null;

    const base = buildResumeSessionBaseOptionsFromSession({
        sessionId,
        session,
        resumeCapabilityOptions,
        resumeTargetOverride,
        permissionOverride,
    });
    if (!base) return null;

    const currentSeq = typeof session.seq === 'number' && Number.isFinite(session.seq) && session.seq >= 0
        ? Math.trunc(session.seq)
        : null;

    return {
        ...base,
        ...(currentSeq !== null ? { initialTranscriptAfterSeq: currentSeq } : {}),
        ...buildWakeResumeExtras({ agentId, resumeCapabilityOptions, session }),
    };
}
