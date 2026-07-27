import { describe, expect, it, vi } from 'vitest';

import type { DisposableCodexAppServerClient } from './client/createCodexAppServerClient';
import { forkCodexAppServerConversationNative } from './nativeFork';

function createClientDouble(requestImpl: DisposableCodexAppServerClient['request']): DisposableCodexAppServerClient {
    return {
        request: requestImpl,
        notify: vi.fn(async () => {}),
        registerRequestHandler: vi.fn(() => () => {}),
        registerNotificationHandler: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {}),
        dispose: vi.fn(async () => {}),
    };
}

describe('forkCodexAppServerConversationNative', () => {
    it('returns null without creating a client when the parent session id is blank', async () => {
        const createClient = vi.fn(async () => createClientDouble(vi.fn()));

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: '   ',
            }, { createClient }),
        ).resolves.toBeNull();

        expect(createClient).not.toHaveBeenCalled();
    });

    it('prefers thread/fork and reads nested thread ids from the response payload', async () => {
        const request = vi.fn(async () => ({ thread: { id: ' forked-thread ' } }));
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: ' parent-thread ',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toEqual({ vendorSessionId: 'forked-thread' });

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith('thread/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('falls back to conversation/fork when thread/fork fails', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValueOnce(new Error('method not found'))
            .mockResolvedValueOnce({ id: 'compat-thread' });
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toEqual({ vendorSessionId: 'compat-thread' });

        expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(request).toHaveBeenNthCalledWith(2, 'conversation/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('falls back to conversation/fork when thread/fork returns no usable thread id', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockResolvedValueOnce({ threadId: '   ' })
            .mockResolvedValueOnce({ thread: { threadId: 'compat-thread' } });
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toEqual({ vendorSessionId: 'compat-thread' });

        expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(request).toHaveBeenNthCalledWith(2, 'conversation/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
    });

    it('returns null when neither fork method yields a usable thread id', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ threadId: '' });
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toBeNull();

        expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(request).toHaveBeenNthCalledWith(2, 'conversation/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('emits structured diagnostics for method failures and fallback exhaustion', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValueOnce(new Error('method not found'))
            .mockResolvedValueOnce({ threadId: '' });
        const client = createClientDouble(request);
        const diagnosticsLogger = { debug: vi.fn() };

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
                logger: diagnosticsLogger,
            }),
        ).resolves.toBeNull();

        expect(diagnosticsLogger.debug).toHaveBeenCalledWith(
            '[CodexAppServerNativeFork] method failed',
            expect.objectContaining({
                method: 'thread/fork',
                hasParentCodexSessionId: true,
                errorMessage: 'method not found',
                fallbackResult: 'try_next_method',
            }),
        );
        expect(diagnosticsLogger.debug).toHaveBeenCalledWith(
            '[CodexAppServerNativeFork] method returned no forked thread id',
            expect.objectContaining({
                method: 'conversation/fork',
                hasParentCodexSessionId: true,
                fallbackResult: 'try_next_method',
            }),
        );
        expect(diagnosticsLogger.debug).toHaveBeenCalledWith(
            '[CodexAppServerNativeFork] exhausted native fork methods',
            expect.objectContaining({
                hasParentCodexSessionId: true,
                fallbackResult: 'native_fork_unavailable',
            }),
        );
    });

    it('does not include raw provider resume ids in diagnostics', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValue(new Error('method unavailable'));
        const client = createClientDouble(request);
        const diagnosticsLogger = { debug: vi.fn() };

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'raw-parent-provider-thread-id',
            }, {
                createClient: async () => client,
                logger: diagnosticsLogger,
            }),
        ).resolves.toBeNull();

        expect(JSON.stringify(diagnosticsLogger.debug.mock.calls)).not.toContain('raw-parent-provider-thread-id');
    });

    it('redacts sensitive values embedded in native fork error diagnostics while keeping safe metadata', async () => {
        const parentCodexSessionId = '019d94f3-0a6f-7c41-bb18-d26425384658';
        const bearerToken = 'sk-proj-native-fork-secret-token-1234567890';
        const threadId = 'thread_native_fork_secret_abcdef';
        const failure = Object.assign(
            new Error(`cannot fork parent ${parentCodexSessionId}; Authorization: Bearer ${bearerToken}; CODEX_THREAD_ID=${threadId}`),
            { code: 'E_NATIVE_FORK' },
        );
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValue(failure);
        const client = createClientDouble(request);
        const diagnosticsLogger = { debug: vi.fn() };

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId,
            }, {
                createClient: async () => client,
                logger: diagnosticsLogger,
            }),
        ).resolves.toBeNull();

        const serializedDiagnostics = JSON.stringify(diagnosticsLogger.debug.mock.calls);
        expect(serializedDiagnostics).not.toContain(parentCodexSessionId);
        expect(serializedDiagnostics).not.toContain(bearerToken);
        expect(serializedDiagnostics).not.toContain(threadId);

        const failedMethodCall = diagnosticsLogger.debug.mock.calls.find(([message]) => message === '[CodexAppServerNativeFork] method failed');
        expect(failedMethodCall?.[1]).toEqual(expect.objectContaining({
            errorName: 'Error',
            errorCode: 'E_NATIVE_FORK',
            fallbackResult: 'try_next_method',
        }));
        const errorMessage = String((failedMethodCall?.[1] as { errorMessage?: unknown } | undefined)?.errorMessage ?? '');
        expect(errorMessage).toContain('cannot fork parent');
        expect(errorMessage).toContain('[REDACTED]');
    });
});
