import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { installErrorUtilityCommonModuleMocks } from './errorUtilityTestHelpers';

const modalAlertSpy = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}));

installErrorUtilityCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (key === 'status.lastSeen') return `status.lastSeen:${String(params?.time ?? '')}`;
                if (key === 'time.minutesAgo') return `time.minutesAgo:${String(params?.count ?? '')}`;
                if (key === 'time.hoursAgo') return `time.hoursAgo:${String(params?.count ?? '')}`;
                if (key === 'sessionHistory.daysAgo') return `sessionHistory.daysAgo:${String(params?.count ?? '')}`;
                return key;
            },
        });
    },
});

describe('daemonUnavailableAlert', () => {
    it('shows a translated alert with machine status and Retry/Cancel buttons', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { showDaemonUnavailableAlert } = await import('./daemonUnavailableAlert');

        const onRetry = vi.fn();
        showDaemonUnavailableAlert({
            titleKey: 'errors.daemonUnavailableTitle',
            bodyKey: 'errors.daemonUnavailableBody',
            machine: {
                active: false,
                activeAt: Date.now() - 5 * 60_000,
                metadata: { host: 'devbox' },
            },
            onRetry,
        });

        expect(modalAlertSpy).toHaveBeenCalled();
        const args = modalAlertSpy.mock.calls[0] ?? [];
        expect(args[0]).toBe('errors.daemonUnavailableTitle');
        expect(String(args[1] ?? '')).toContain('errors.daemonUnavailableBody');
        expect(String(args[1] ?? '')).toContain('status.lastSeen:time.minutesAgo:5');

        const buttons = args[2] as any[];
        expect(Array.isArray(buttons)).toBe(true);
        expect(buttons.some((b) => b?.text === 'common.retry' && typeof b?.onPress === 'function')).toBe(true);
        expect(buttons.some((b) => b?.text === 'common.cancel')).toBe(true);
    });

    it('guards Retry when shouldContinue returns false', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { showDaemonUnavailableAlert } = await import('./daemonUnavailableAlert');

        const onRetry = vi.fn();
        showDaemonUnavailableAlert({
            titleKey: 'errors.daemonUnavailableTitle',
            bodyKey: 'errors.daemonUnavailableBody',
            onRetry,
            shouldContinue: () => false,
        });

        const args = modalAlertSpy.mock.calls[0] ?? [];
        const buttons = args[2] as any[];
        const retry = buttons.find((b) => b?.text === 'common.retry');
        expect(typeof retry?.onPress).toBe('function');

        retry.onPress();
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('reports "unknown" when activeAt is not a valid timestamp and active=false', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { showDaemonUnavailableAlert } = await import('./daemonUnavailableAlert');

        showDaemonUnavailableAlert({
            titleKey: 'errors.daemonUnavailableTitle',
            bodyKey: 'errors.daemonUnavailableBody',
            machine: {
                active: false,
                activeAt: 0,
                metadata: { host: 'devbox' },
            },
            onRetry: vi.fn(),
        });

        expect(modalAlertSpy).toHaveBeenCalled();
        const args = modalAlertSpy.mock.calls[0] ?? [];
        expect(String(args[1] ?? '')).toContain('status.unknown');
    });

    it('reports last-seen time instead of "online" for stale machines even when active=true', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { showDaemonUnavailableAlert } = await import('./daemonUnavailableAlert');

        showDaemonUnavailableAlert({
            titleKey: 'errors.daemonUnavailableTitle',
            bodyKey: 'errors.daemonUnavailableBody',
            machine: {
                active: true,
                activeAt: Date.now() - 60 * 60_000,
                metadata: { host: 'devbox' },
            },
            onRetry: vi.fn(),
        });

        expect(modalAlertSpy).toHaveBeenCalled();
        const args = modalAlertSpy.mock.calls[0] ?? [];
        expect(String(args[1] ?? '')).toContain('status.lastSeen:time.hoursAgo:1');
    });

    it('shows an alert for RPC method-not-available failure objects (code/message)', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { tryShowDaemonUnavailableAlertForRpcFailure, DAEMON_UNAVAILABLE_RPC_ERROR_CODE } = await import('./daemonUnavailableAlert');

        const onRetry = vi.fn();
        const shown = tryShowDaemonUnavailableAlertForRpcFailure({
            rpcErrorCode: DAEMON_UNAVAILABLE_RPC_ERROR_CODE,
            message: 'RPC method not available',
            onRetry,
        });

        expect(shown).toBe(true);
        expect(modalAlertSpy).toHaveBeenCalled();
    });

    it('does not match by message when a non-daemon rpcErrorCode is present on an Error', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { tryShowDaemonUnavailableAlertForRpcError } = await import('./daemonUnavailableAlert');

        const err = Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'SOME_OTHER_CODE' });
        const shown = tryShowDaemonUnavailableAlertForRpcError({
            error: err,
            onRetry: vi.fn(),
        });

        expect(shown).toBe(false);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('shows an alert for session machine target unavailable errors', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { tryShowDaemonUnavailableAlertForRpcError } = await import('./daemonUnavailableAlert');

        const err = Object.assign(new Error('Machine target not available for session'), {
            rpcErrorCode: 'SESSION_MACHINE_TARGET_UNAVAILABLE',
        });
        const shown = tryShowDaemonUnavailableAlertForRpcError({
            error: err,
            onRetry: vi.fn(),
        });

        expect(shown).toBe(true);
        expect(modalAlertSpy).toHaveBeenCalled();
    });

    it('classifies spawn daemon RPC unavailable results as retryable launch failures', async () => {
        vi.resetModules();
        const mod = await import('./daemonUnavailableAlert');

        expect(mod.classifyLaunchRetryFailure?.({
            phase: 'spawn',
            failure: {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Daemon RPC is not available',
            },
        })).toEqual({
            kind: 'retryable',
            reason: 'daemon_unavailable',
            titleKey: 'newSession.daemonRpcUnavailableTitle',
            bodyKey: 'newSession.daemonRpcUnavailableBody',
            retryButtonKey: 'common.retry',
            cancelButtonKey: 'common.cancel',
        });
    });

    it('classifies spawn webhook timeouts as retryable launch failures', async () => {
        vi.resetModules();
        const mod = await import('./daemonUnavailableAlert');

        expect(mod.classifyLaunchRetryFailure?.({
            phase: 'spawn',
            failure: {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                errorMessage: 'Session startup timed out',
            },
        })).toMatchObject({
            kind: 'retryable',
            reason: 'launch_still_pending',
            titleKey: 'newSession.launchStillPendingTitle',
            bodyKey: 'newSession.launchStillPendingBody',
        });
    });

    it('classifies session machine target unavailable errors as retryable launch failures', async () => {
        vi.resetModules();
        const mod = await import('./daemonUnavailableAlert');

        expect(mod.classifyLaunchRetryFailure?.({
            phase: 'upload',
            failure: {
                success: false,
                error: 'Machine target not available for session',
                errorCode: 'SESSION_MACHINE_TARGET_UNAVAILABLE',
            },
        })).toEqual({
            kind: 'retryable',
            reason: 'session_target_unavailable',
            titleKey: 'errors.daemonUnavailableTitle',
            bodyKey: 'errors.daemonUnavailableBody',
            retryButtonKey: 'common.retry',
            cancelButtonKey: 'common.cancel',
        });
    });

    it('classifies inactive session transfer unavailable results as retryable launch failures', async () => {
        vi.resetModules();
        const mod = await import('./daemonUnavailableAlert');

        expect(mod.classifyLaunchRetryFailure?.({
            phase: 'upload',
            failure: {
                success: false,
                error: 'Session RPC unavailable for inactive session',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        })).toMatchObject({
            kind: 'retryable',
            reason: 'session_target_unavailable',
        });
    });

    it('keeps known validation and domain failures fatal for launch retry classification', async () => {
        vi.resetModules();
        const mod = await import('./daemonUnavailableAlert');

        const fatalFailures = [
            {
                success: false,
                error: 'File exceeds the server-routed transfer size limit',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
            {
                success: false,
                error: 'Server-routed transfer is disabled on the selected server',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
            {
                ok: false,
                error: 'not_authenticated',
                errorCode: 'not_authenticated',
            },
            {
                ok: false,
                error: 'invalid_parameters',
                errorCode: 'invalid_parameters',
            },
            {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'The selected backend target requires a compatible daemon build.',
            },
        ] as const;

        for (const failure of fatalFailures) {
            expect(mod.classifyLaunchRetryFailure?.({
                phase: 'upload',
                failure,
            })).toMatchObject({
                kind: 'fatal',
            });
        }
    });

    it('classifies retry attempts from the current failure instead of a previous failure', async () => {
        vi.resetModules();
        const mod = await import('./daemonUnavailableAlert');

        const previousRetryable = {
            rpcErrorCode: 'SESSION_MACHINE_TARGET_UNAVAILABLE',
            message: 'Machine target not available for session',
        };
        const currentFatal = {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'The configured backend rejected the request',
        };

        expect(mod.classifyLaunchRetryFailure?.({
            phase: 'spawn',
            failure: currentFatal,
            previousFailure: previousRetryable,
        })).toEqual({
            kind: 'fatal',
            reason: 'domain_error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            message: 'The configured backend rejected the request',
        });
    });

    it('does not match by message when a non-daemon rpcErrorCode is present', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { tryShowDaemonUnavailableAlertForRpcFailure } = await import('./daemonUnavailableAlert');

        const shown = tryShowDaemonUnavailableAlertForRpcFailure({
            rpcErrorCode: 'SOME_OTHER_CODE',
            message: 'RPC method not available',
            onRetry: vi.fn(),
        });

        expect(shown).toBe(false);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('returns false and does not alert for non-RPC method-not-available errors', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { tryShowDaemonUnavailableAlertForRpcError, tryShowDaemonUnavailableAlertForRpcFailure } = await import('./daemonUnavailableAlert');

        const shown = tryShowDaemonUnavailableAlertForRpcError({
            error: new Error('boom'),
            onRetry: vi.fn(),
        });

        expect(shown).toBe(false);
        expect(modalAlertSpy).not.toHaveBeenCalled();

        const shown2 = tryShowDaemonUnavailableAlertForRpcFailure({
            rpcErrorCode: 'OTHER',
            message: 'boom',
            onRetry: vi.fn(),
        });
        expect(shown2).toBe(false);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('resolves a retry prompt when the Retry button is pressed', async () => {
        modalAlertSpy.mockClear();
        vi.resetModules();
        const { promptDaemonUnavailableRetry } = await import('./daemonUnavailableAlert');

        const pending = promptDaemonUnavailableRetry({
            titleKey: 'errors.daemonUnavailableTitle',
            bodyKey: 'errors.daemonUnavailableBody',
        });
        const args = modalAlertSpy.mock.calls[0] ?? [];
        const buttons = args[2] as any[];
        const retry = buttons.find((button) => button?.text === 'common.retry');
        retry?.onPress?.();

        await expect(pending).resolves.toBe('retry');
    });
});
