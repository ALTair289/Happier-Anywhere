import {
    RestartSessionRunnerRequestV1Schema,
    RestartSessionRunnerResultV1Schema,
    SessionRunnerRuntimeStateV1Schema,
    SessionRunnerStatusGetRequestV1Schema,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
    type RestartSessionRunnerRequestV1,
    type RestartSessionRunnerStatusV1,
    type SessionRunnerRuntimeStateV1,
    type SessionRunnerStatusGetRequestV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type RestartStaleSessionRunnerRequest = Readonly<{
    sessionId: string;
    machineId: string;
    serverId?: string | null;
    expectedRunnerPid: number;
    expectedProcessCommandHash: string;
    expectedRunnerEntrypointIdentity: string;
}>;

export type GetSessionRunnerRuntimeStatusRequest = Readonly<{
    sessionId: string;
    machineId: string;
    serverId?: string | null;
}>;

type RestartStaleSessionRunnerSuccessStatus = Extract<
    RestartSessionRunnerStatusV1,
    'restarted' | 'already_current'
>;

type RestartStaleSessionRunnerSkipStatus = Extract<
    RestartSessionRunnerStatusV1,
    'runner_identity_changed' | 'busy' | 'ineligible' | 'version_unknown' | 'unsupported_daemon'
>;

export type RestartStaleSessionRunnerStatus =
    | RestartStaleSessionRunnerSuccessStatus
    | RestartStaleSessionRunnerSkipStatus
    | 'refresh_unsupported'
    | 'failure';

export type RestartStaleSessionRunnerResult =
    | Readonly<{ ok: true; status: RestartStaleSessionRunnerSuccessStatus; sessionId: string }>
    | Readonly<{ ok: false; status: Exclude<RestartStaleSessionRunnerStatus, RestartStaleSessionRunnerSuccessStatus>; sessionId: string; error?: string }>;

const SUCCESS_STATUSES = new Set<RestartSessionRunnerStatusV1>([
    'restarted',
    'already_current',
]);

const INELIGIBLE_STATUSES = new Set<RestartSessionRunnerStatusV1>([
    'not_found',
    'not_tracked',
    'not_daemon_started',
    'runner_not_active',
    'missing_resume_snapshot',
    'missing_spawn_options',
    'ineligible',
]);

export function normalizeRestartSessionRunnerResult(
    value: unknown,
    fallbackSessionId: string,
): RestartStaleSessionRunnerResult {
    const parsedResult = RestartSessionRunnerResultV1Schema.safeParse(value);
    if (!parsedResult.success) {
        return {
            ok: false,
            status: 'failure',
            sessionId: fallbackSessionId,
            error: 'malformed_session_runner_restart_result',
        };
    }

    const result = parsedResult.data;
    if (SUCCESS_STATUSES.has(result.status) && result.ok === true) {
        return { ok: true, status: result.status as RestartStaleSessionRunnerSuccessStatus, sessionId: result.sessionId };
    }

    if (result.ok === false) {
        if (result.status === 'runner_identity_changed') {
            return { ok: false, status: 'runner_identity_changed', sessionId: result.sessionId };
        }
        if (result.status === 'busy') {
            return { ok: false, status: 'busy', sessionId: result.sessionId };
        }
        if (result.status === 'version_unknown') {
            return { ok: false, status: 'version_unknown', sessionId: result.sessionId };
        }
        if (result.status === 'unsupported_daemon') {
            return { ok: false, status: 'unsupported_daemon', sessionId: result.sessionId };
        }
        if (
            result.status === 'ineligible'
            && result.reasonCode === 'non_destructive_refresh_unsupported'
        ) {
            return { ok: false, status: 'refresh_unsupported', sessionId: result.sessionId };
        }
        if (INELIGIBLE_STATUSES.has(result.status)) {
            return { ok: false, status: 'ineligible', sessionId: result.sessionId };
        }
        if (
            result.status === 'stop_failed'
            || result.status === 'spawn_failed'
            || result.status === 'partial_failure'
        ) {
            return { ok: false, status: 'failure', sessionId: result.sessionId };
        }
    }

    return {
        ok: false,
        status: 'failure',
        sessionId: parsedResult.data.sessionId || fallbackSessionId,
        error: 'malformed_session_runner_restart_result',
    };
}

export async function restartStaleSessionRunner(
    request: RestartStaleSessionRunnerRequest,
): Promise<RestartStaleSessionRunnerResult> {
    try {
        const payload = RestartSessionRunnerRequestV1Schema.parse({
            sessionId: request.sessionId,
            mode: 'if_stale',
            reason: 'ui_stale_runner_banner',
            expectedRunnerPid: request.expectedRunnerPid,
            expectedProcessCommandHash: request.expectedProcessCommandHash,
            expectedRunnerEntrypointIdentity: request.expectedRunnerEntrypointIdentity,
        } satisfies RestartSessionRunnerRequestV1);
        const result = await machineRpcWithServerScope<unknown, RestartSessionRunnerRequestV1>({
            machineId: request.machineId,
            serverId: request.serverId ?? null,
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
            payload,
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: request.sessionId,
            },
        });
        return normalizeRestartSessionRunnerResult(result, request.sessionId);
    } catch (error) {
        const errorCode = readRpcErrorCode(error);
        return {
            ok: false,
            status: isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)
                ? 'unsupported_daemon'
                : 'failure',
            sessionId: request.sessionId,
            error: errorCode ?? (error instanceof Error ? error.message : 'session_runner_restart_failed'),
        };
    }
}

/**
 * Restart operations are accepted-then-observed: the daemon signals the tracked runner to exit and
 * respawns it on the current CLI asynchronously. A single "restarted" ack rides a control-plane
 * request that can be torn down (transport timeout / severed socket) before the respawn completes,
 * so a succeeding restart can surface to the caller as a generic `failure`. `didSessionRunnerRestartLand`
 * lets the caller confirm the outcome from the daemon-owned runtime status instead of trusting the
 * possibly-lost ack: the targeted stale runner is gone once the runtime is re-attested `current` or a
 * new live process has replaced the PID we asked to restart.
 */
export function didSessionRunnerRestartLand(input: Readonly<{
    state: SessionRunnerRuntimeStateV1 | null;
    expectedRunnerPid: number;
}>): boolean {
    const state = input.state;
    if (!state) return false;
    if (state.versionState === 'current') return true;
    const pid = state.runner.pid;
    const expectedRunnerPid = input.expectedRunnerPid;
    return (
        typeof pid === 'number'
        && pid > 0
        && Number.isInteger(expectedRunnerPid)
        && expectedRunnerPid > 0
        && pid !== expectedRunnerPid
    );
}

export type RestartStaleSessionRunnerWithObserveDeps = Readonly<{
    restart?: (request: RestartStaleSessionRunnerRequest) => Promise<RestartStaleSessionRunnerResult>;
    getStatus?: (request: GetSessionRunnerRuntimeStatusRequest) => Promise<SessionRunnerRuntimeStateV1 | null>;
    sleep?: (ms: number) => Promise<void>;
    observeAttempts?: number;
    observeIntervalMs?: number;
}>;

const DEFAULT_RESTART_OBSERVE_ATTEMPTS = 8;
const DEFAULT_RESTART_OBSERVE_INTERVAL_MS = 1_500;

/**
 * Restart the stale runner, then — only when the ack came back as an ambiguous `failure`
 * (transport timeout / severed ack channel / spawn ambiguity) — observe the daemon-owned runtime
 * status to see whether the restart actually landed. Definitive negatives (busy, ineligible,
 * runner_identity_changed, version_unknown, unsupported_daemon) mean the runner was NOT restarted and
 * are surfaced unchanged, so their dedicated UX is preserved. This prevents the false-negative where a
 * succeeding restart tears down its own ack channel and the caller reports failure on a working op.
 */
export async function restartStaleSessionRunnerWithObserve(
    request: RestartStaleSessionRunnerRequest,
    deps: RestartStaleSessionRunnerWithObserveDeps = {},
): Promise<RestartStaleSessionRunnerResult> {
    const restart = deps.restart ?? restartStaleSessionRunner;
    const getStatus = deps.getStatus ?? getSessionRunnerRuntimeStatus;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    const attempts = Math.max(1, Math.trunc(deps.observeAttempts ?? DEFAULT_RESTART_OBSERVE_ATTEMPTS));
    const intervalMs = Math.max(0, Math.trunc(deps.observeIntervalMs ?? DEFAULT_RESTART_OBSERVE_INTERVAL_MS));

    const result = await restart(request);
    if (result.ok) return result;
    // Only an ambiguous `failure` is eligible for observe; every other negative is a definitive answer.
    if (result.status !== 'failure') return result;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const state = await getStatus({
            sessionId: request.sessionId,
            machineId: request.machineId,
            serverId: request.serverId ?? null,
        });
        if (didSessionRunnerRestartLand({ state, expectedRunnerPid: request.expectedRunnerPid })) {
            return { ok: true, status: 'restarted', sessionId: request.sessionId };
        }
        if (attempt < attempts - 1 && intervalMs > 0) {
            await sleep(intervalMs);
        }
    }
    return result;
}

export async function getSessionRunnerRuntimeStatus(
    request: GetSessionRunnerRuntimeStatusRequest,
): Promise<SessionRunnerRuntimeStateV1 | null> {
    try {
        const payload = SessionRunnerStatusGetRequestV1Schema.parse({
            sessionId: request.sessionId,
        } satisfies SessionRunnerStatusGetRequestV1);
        const result = await machineRpcWithServerScope<unknown, SessionRunnerStatusGetRequestV1>({
            machineId: request.machineId,
            serverId: request.serverId ?? null,
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
            payload,
        });
        const parsed = SessionRunnerRuntimeStateV1Schema.safeParse(result);
        if (!parsed.success || parsed.data.sessionId !== payload.sessionId) return null;
        return parsed.data;
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) return null;
        return null;
    }
}
