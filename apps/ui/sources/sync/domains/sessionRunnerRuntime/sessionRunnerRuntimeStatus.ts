import {
    SESSION_RUNNER_RUNTIME_STATE_FIELD_ID,
    SessionRunnerRuntimeStateV1Schema,
    type SessionRunnerRestartDisabledReason,
    type SessionRunnerRuntimeStateV1,
} from '@happier-dev/protocol';

export { SESSION_RUNNER_RUNTIME_STATE_FIELD_ID };

export type ActionableStaleSessionRunnerStatus = Readonly<{
    sessionId: string;
    machineId: string;
    expectedRunnerPid: number;
    expectedProcessCommandHash: string;
    expectedRunnerEntrypointIdentity: string;
    currentEntrypointIdentity: string;
    disabledReason: SessionRunnerRestartDisabledReason | null;
    fingerprint: string;
}>;

type ReadActionableStaleSessionRunnerStatusParams = Readonly<{
    sessionId: string;
    machineId?: string | null;
    metadata: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readRunnerEntrypointIdentity(
    runner: SessionRunnerRuntimeStateV1['runner'],
): string | null {
    if (runner.entrypointSource === 'unknown') return null;
    return readNonEmptyString(runner.runtimeId);
}

function readCurrentEntrypointIdentity(
    daemon: SessionRunnerRuntimeStateV1['daemon'],
): string | null {
    if (daemon.currentEntrypointSource === 'unknown') return null;
    return readNonEmptyString(daemon.currentEntrypointVersion);
}

export function readActionableStaleSessionRunnerStatus(
    params: ReadActionableStaleSessionRunnerStatusParams,
): ActionableStaleSessionRunnerStatus | null {
    const sessionId = readNonEmptyString(params.sessionId);
    const machineId = readNonEmptyString(params.machineId);
    if (!sessionId || !machineId) return null;
    if (!isRecord(params.metadata)) return null;

    const parsedState = SessionRunnerRuntimeStateV1Schema.safeParse(
        params.metadata[SESSION_RUNNER_RUNTIME_STATE_FIELD_ID],
    );
    if (!parsedState.success) return null;

    const state = parsedState.data;
    if (state.sessionId !== sessionId) return null;

    const stateMachineId = readNonEmptyString(state.machineId);
    if (stateMachineId !== machineId) return null;
    if (state.versionState !== 'stale') return null;

    const { runner, daemon, plannedRestart } = state;
    if (plannedRestart.supported !== true || plannedRestart.eligible !== true) return null;

    const disabledReason = plannedRestart.disabledReason ?? null;
    if (disabledReason) return null;

    const expectedRunnerPid = runner.pid ?? null;
    const expectedProcessCommandHash = readNonEmptyString(runner.processCommandHash);
    const expectedRunnerEntrypointIdentity = readRunnerEntrypointIdentity(runner);
    const currentEntrypointIdentity = readCurrentEntrypointIdentity(daemon);
    if (
        expectedRunnerPid === null
        || !expectedProcessCommandHash
        || !expectedRunnerEntrypointIdentity
        || !currentEntrypointIdentity
    ) {
        return null;
    }

    const fingerprint = [
        sessionId,
        machineId,
        String(expectedRunnerPid),
        expectedProcessCommandHash,
        expectedRunnerEntrypointIdentity,
        currentEntrypointIdentity,
        disabledReason ?? 'eligible',
    ].join('|');

    return {
        sessionId,
        machineId,
        expectedRunnerPid,
        expectedProcessCommandHash,
        expectedRunnerEntrypointIdentity,
        currentEntrypointIdentity,
        disabledReason,
        fingerprint,
    };
}
