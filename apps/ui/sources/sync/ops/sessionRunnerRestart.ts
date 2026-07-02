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
