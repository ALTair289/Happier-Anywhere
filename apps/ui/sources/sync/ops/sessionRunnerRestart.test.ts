import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

describe('sessionRunnerRestart', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('calls the daemon-owned session-runner restart RPC with expected runner identity', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        });

        const { restartStaleSessionRunner } = await import('./sessionRunnerRestart');

        await expect(restartStaleSessionRunner({
            sessionId: 's1',
            machineId: 'machine-1',
            serverId: 'server-1',
            expectedRunnerPid: 123,
            expectedProcessCommandHash: 'hash-old',
            expectedRunnerEntrypointIdentity: 'version:cli-old',
        })).resolves.toEqual({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
            payload: {
                sessionId: 's1',
                mode: 'if_stale',
                reason: 'ui_stale_runner_banner',
                expectedRunnerPid: 123,
                expectedProcessCommandHash: 'hash-old',
                expectedRunnerEntrypointIdentity: 'version:cli-old',
            },
            authorization: {
                kind: 'session.write',
                sessionId: 's1',
            },
        });
    });

    it('normalizes daemon restart statuses and fails closed on malformed results', async () => {
        const { normalizeRestartSessionRunnerResult } = await import('./sessionRunnerRestart');

        expect(normalizeRestartSessionRunnerResult({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: true, status: 'restarted', sessionId: 's1' });

        expect(normalizeRestartSessionRunnerResult({
            ok: false,
            status: 'runner_identity_changed',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: false, status: 'runner_identity_changed', sessionId: 's1' });

        expect(normalizeRestartSessionRunnerResult({ ok: true, status: 'surprise' }, 's1')).toEqual({
            ok: false,
            status: 'failure',
            sessionId: 's1',
            error: 'malformed_session_runner_restart_result',
        });
    });

    it('maps canonical daemon skip and failure statuses into UI states', async () => {
        const { normalizeRestartSessionRunnerResult } = await import('./sessionRunnerRestart');

        expect(normalizeRestartSessionRunnerResult({
            ok: false,
            status: 'not_tracked',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: false, status: 'ineligible', sessionId: 's1' });

        expect(normalizeRestartSessionRunnerResult({
            ok: false,
            status: 'busy',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: false, status: 'busy', sessionId: 's1' });

        expect(normalizeRestartSessionRunnerResult({
            ok: false,
            status: 'spawn_failed',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: false, status: 'failure', sessionId: 's1' });
    });

    it('reports unsupported daemon when the restart RPC is unavailable', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        const { restartStaleSessionRunner } = await import('./sessionRunnerRestart');

        await expect(restartStaleSessionRunner({
            sessionId: 's1',
            machineId: 'machine-1',
            expectedRunnerPid: 123,
            expectedProcessCommandHash: 'hash-old',
            expectedRunnerEntrypointIdentity: 'version:cli-old',
        })).resolves.toEqual({
            ok: false,
            status: 'unsupported_daemon',
            sessionId: 's1',
            error: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
    });

    it('fetches daemon-owned session runner runtime status through the status RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            v: 1,
            sessionId: 's1',
            machineId: 'machine-1',
            daemonId: 'daemon-1',
            observedAtMs: 123,
            runner: {
                pid: 123,
                runtimeId: 'version:cli-old',
                cliVersion: 'cli-old',
                entrypointVersion: 'cli-old',
                processCommandHash: 'hash-old',
                entrypointSource: 'process_command',
                startedBy: 'daemon',
                startingMode: 'remote',
            },
            daemon: {
                cliVersion: 'cli-new',
                startedWithCliVersion: 'cli-new',
                currentEntrypointVersion: 'version:cli-new',
                currentEntrypointSource: 'launch_spec',
            },
            versionState: 'stale',
            statusSource: 'daemon_tracking',
            plannedRestart: { supported: true, eligible: true, disabledReason: null },
        });

        const { getSessionRunnerRuntimeStatus } = await import('./sessionRunnerRestart');

        await expect(getSessionRunnerRuntimeStatus({
            sessionId: 's1',
            machineId: 'machine-1',
            serverId: 'server-1',
        })).resolves.toMatchObject({
            sessionId: 's1',
            machineId: 'machine-1',
            versionState: 'stale',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
            payload: { sessionId: 's1' },
        });
    });

    it('fails closed when daemon status RPC is unavailable or malformed', async () => {
        const { getSessionRunnerRuntimeStatus } = await import('./sessionRunnerRestart');

        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        await expect(getSessionRunnerRuntimeStatus({
            sessionId: 's1',
            machineId: 'machine-1',
        })).resolves.toBeNull();

        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true });
        await expect(getSessionRunnerRuntimeStatus({
            sessionId: 's1',
            machineId: 'machine-1',
        })).resolves.toBeNull();
    });
});
