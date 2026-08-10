import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    PairingClaimFetchAbortedError,
    PairingClaimFetchConfigurationError,
    PairingClaimFetchTimeoutError,
    pairingClaimFetch,
} from './pairingClaimTransport';

describe('pairingClaimFetch', () => {
    afterEach(() => {
        vi.useRealTimers();
        resetRuntimeFetch();
    });

    it('rejects non-canonical or non-HTTPS origins before invoking the transport', async () => {
        const runtimeFetchMock = vi.fn();
        setRuntimeFetch(runtimeFetchMock);

        for (const origin of [
            'http://relay.example.test',
            'https://Relay.Example.test/',
            'https://user:pass@relay.example.test',
        ]) {
            await expect(pairingClaimFetch(
                origin,
                '/v1/auth/pairing/claim/consume',
                { method: 'POST' },
            )).rejects.toBeInstanceOf(PairingClaimFetchConfigurationError);
        }

        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('uses only the pinned endpoint and strips ambient credential behavior', async () => {
        const runtimeFetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
            new Response(null, { status: 426 })
        ));
        setRuntimeFetch(runtimeFetchMock);

        const response = await pairingClaimFetch(
            'https://relay.example.test',
            '/v1/auth/account/request',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{"publicKey":"public"}',
                credentials: 'include',
            },
        );

        expect(response.status).toBe(426);
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        expect(runtimeFetchMock.mock.calls[0]?.[0]).toBe('https://relay.example.test/v1/auth/account/request');
        expect(runtimeFetchMock.mock.calls[0]?.[1]).toMatchObject({
            method: 'POST',
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
        });
        expect(new Headers(runtimeFetchMock.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
    });

    it('propagates caller cancellation through the composed request signal', async () => {
        const caller = new AbortController();
        const requestSignals: AbortSignal[] = [];
        setRuntimeFetch(async (_input, init) => {
            const requestSignal = init?.signal;
            if (requestSignal) requestSignals.push(requestSignal);
            return await new Promise<Response>((_resolve, reject) => {
                requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
                    once: true,
                });
            });
        });

        const pending = pairingClaimFetch(
            'https://relay.example.test',
            '/v2/auth/account/request',
            { method: 'POST', signal: caller.signal },
        );
        await Promise.resolve();
        caller.abort();

        await expect(pending).rejects.toBeInstanceOf(PairingClaimFetchAbortedError);
        expect(requestSignals[0]?.aborted).toBe(true);
    });

    it('enforces its own bounded timeout even when the runtime fetch never settles', async () => {
        vi.useFakeTimers();
        const requestSignals: AbortSignal[] = [];
        setRuntimeFetch(async (_input, init) => {
            const requestSignal = init?.signal;
            if (requestSignal) requestSignals.push(requestSignal);
            return await new Promise<Response>(() => undefined);
        });

        const pending = pairingClaimFetch(
            'https://relay.example.test',
            '/v1/auth/pairing/claim/consume',
            { method: 'POST' },
            { timeoutMs: 25 },
        );
        const rejected = expect(pending).rejects.toBeInstanceOf(PairingClaimFetchTimeoutError);
        await vi.advanceTimersByTimeAsync(25);

        await rejected;
        expect(requestSignals[0]?.aborted).toBe(true);
    });
});
