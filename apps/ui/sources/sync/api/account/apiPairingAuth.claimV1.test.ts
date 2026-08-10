import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serverFetchMock = vi.hoisted(() => vi.fn());
const pairingClaimFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({ serverFetch: serverFetchMock }));
vi.mock('./pairingClaimTransport', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./pairingClaimTransport')>()),
    pairingClaimFetch: pairingClaimFetchMock,
}));

import { pairingClaimConsume, pairingClaimStart } from './apiPairingAuth';
import { PairingClaimFetchTimeoutError, PairingClaimFetchTransportError } from './pairingClaimTransport';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('apiPairingAuth claim-v1', () => {
    beforeEach(() => {
        serverFetchMock.mockReset();
        pairingClaimFetchMock.mockReset();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-09T11:59:00.000Z'));
    });

    afterEach(() => vi.useRealTimers());

    it('starts a claim using only the normalized HTTPS origin', async () => {
        const claimId = `claim_${'a'.repeat(43)}`;
        serverFetchMock.mockResolvedValueOnce(jsonResponse({
            protocol: 'claim-v1',
            claimId,
            origin: 'https://relay.example.test',
            expiresAt: '2026-08-09T12:00:00.000Z',
        }));

        await expect(pairingClaimStart({ origin: 'https://Relay.Example.test/' })).resolves.toEqual({
            ok: true,
            data: {
                protocol: 'claim-v1',
                claimId,
                origin: 'https://relay.example.test',
                expiresAt: '2026-08-09T12:00:00.000Z',
            },
        });

        expect(serverFetchMock).toHaveBeenCalledWith(
            '/v1/auth/pairing/claim/start',
            expect.objectContaining({ body: JSON.stringify({ origin: 'https://relay.example.test' }) }),
            { includeAuth: true },
        );
        expect(serverFetchMock.mock.calls[0]?.[1]?.body).not.toContain('secret');
    });

    it('reports only explicit missing-route statuses as unsupported', async () => {
        serverFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'not_found' }, 404));
        await expect(pairingClaimStart({ origin: 'https://relay.example.test' })).resolves.toEqual({
            ok: false,
            reason: 'unsupported',
            status: 404,
        });

        serverFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'internal' }, 500));
        await expect(pairingClaimStart({ origin: 'https://relay.example.test' })).resolves.toEqual({
            ok: false,
            reason: 'http_error',
            status: 500,
        });
    });

    it('rejects a claim start response that changes the requested Relay origin', async () => {
        const claimId = `claim_${'c'.repeat(43)}`;
        serverFetchMock.mockResolvedValueOnce(jsonResponse({
            protocol: 'claim-v1',
            claimId,
            origin: 'https://other-relay.example.test',
            expiresAt: '2026-08-09T12:00:00.000Z',
        }));

        await expect(pairingClaimStart({ origin: 'https://relay.example.test' })).resolves.toEqual({
            ok: false,
            reason: 'http_error',
            status: 502,
        });
    });

    it('accepts only a future claim expiry within the local 600-second protocol bound', async () => {
        const claimId = `claim_${'d'.repeat(43)}`;
        const origin = 'https://relay.example.test';
        const now = Date.now();

        for (const expiresAtMs of [now - 1, now, now + 600_001]) {
            serverFetchMock.mockResolvedValueOnce(jsonResponse({
                protocol: 'claim-v1',
                claimId,
                origin,
                expiresAt: new Date(expiresAtMs).toISOString(),
            }));
            await expect(pairingClaimStart({ origin })).resolves.toEqual({
                ok: false,
                reason: 'http_error',
                status: 502,
            });
        }

        const maxExpiresAt = new Date(now + 600_000).toISOString();
        serverFetchMock.mockResolvedValueOnce(jsonResponse({
            protocol: 'claim-v1',
            claimId,
            origin,
            expiresAt: maxExpiresAt,
        }));
        await expect(pairingClaimStart({ origin })).resolves.toEqual({
            ok: true,
            data: { protocol: 'claim-v1', claimId, origin, expiresAt: maxExpiresAt },
        });
    });

    it('consumes an origin-bound claim without auth or a secret', async () => {
        const claimId = `claim_${'b'.repeat(43)}`;
        pairingClaimFetchMock.mockResolvedValueOnce(jsonResponse({ state: 'requested', confirmCode: '123 456' }));
        await expect(pairingClaimConsume({
            claimId,
            origin: 'https://Relay.Example.test/',
            publicKey: 'phone-public-key',
            deviceLabel: 'Phone',
        })).resolves.toEqual({ ok: true, data: { state: 'requested', confirmCode: '123 456' } });

        expect(pairingClaimFetchMock).toHaveBeenCalledWith(
            'https://relay.example.test',
            '/v1/auth/pairing/claim/consume',
            expect.objectContaining({
                body: JSON.stringify({
                    claimId,
                    origin: 'https://relay.example.test',
                    publicKey: 'phone-public-key',
                    deviceLabel: 'Phone',
                }),
            }),
        );
        expect(pairingClaimFetchMock.mock.calls[0]?.[2]?.body).not.toContain('secret');
    });

    it('replays one ambiguous transport failure with the exact same request body', async () => {
        const claimId = `claim_${'r'.repeat(43)}`;
        pairingClaimFetchMock
            .mockRejectedValueOnce(new PairingClaimFetchTransportError())
            .mockResolvedValueOnce(jsonResponse({ state: 'requested', confirmCode: '654 321' }));

        await expect(pairingClaimConsume({
            claimId,
            origin: 'https://relay.example.test',
            publicKey: 'same-phone-public-key',
            deviceLabel: 'Phone',
        })).resolves.toEqual({ ok: true, data: { state: 'requested', confirmCode: '654 321' } });

        expect(pairingClaimFetchMock).toHaveBeenCalledTimes(2);
        expect(pairingClaimFetchMock.mock.calls[0]?.[2]?.body).toBe(pairingClaimFetchMock.mock.calls[1]?.[2]?.body);
    });

    it('replays one timeout but never performs a third consume attempt', async () => {
        const claimId = `claim_${'t'.repeat(43)}`;
        pairingClaimFetchMock.mockRejectedValue(new PairingClaimFetchTimeoutError());

        await expect(pairingClaimConsume({
            claimId,
            origin: 'https://relay.example.test',
            publicKey: 'same-phone-public-key',
        })).rejects.toBeInstanceOf(PairingClaimFetchTimeoutError);
        expect(pairingClaimFetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not replay HTTP or protocol responses', async () => {
        const claimId = `claim_${'n'.repeat(43)}`;
        pairingClaimFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'not_found' }, 404));
        await expect(pairingClaimConsume({
            claimId,
            origin: 'https://relay.example.test',
            publicKey: 'phone-public-key',
        })).resolves.toEqual({ ok: false, reason: 'not_found', status: 404 });
        expect(pairingClaimFetchMock).toHaveBeenCalledTimes(1);

        pairingClaimFetchMock.mockReset();
        pairingClaimFetchMock.mockResolvedValueOnce(jsonResponse({ state: 'unexpected' }));
        await expect(pairingClaimConsume({
            claimId,
            origin: 'https://relay.example.test',
            publicKey: 'phone-public-key',
        })).resolves.toEqual({ ok: false, reason: 'http_error', status: 502 });
        expect(pairingClaimFetchMock).toHaveBeenCalledTimes(1);
    });
});
