import { serverFetch } from '@/sync/http/client';
import { isRetryablePairingClaimFetchError, pairingClaimFetch } from './pairingClaimTransport';
import {
    PAIRING_CLAIM_V1_MAX_TTL_MS,
    PairingClaimConsumeRequestV1Schema,
    PairingClaimConsumeResponseV1Schema,
    PairingClaimStartRequestV1Schema,
    PairingClaimStartResponseV1Schema,
    type PairingClaimStartResponseV1,
} from '@happier-dev/protocol';

export type PairingStartResponse = Readonly<{
    pairId: string;
    expiresAt: string;
}>;

export type PairingStatus =
    | Readonly<{
        state: 'pending';
        pairId: string;
        expiresAt: string;
    }>
    | Readonly<{
        state: 'requested';
        pairId: string;
        expiresAt: string;
        requestedPublicKey: string;
        requestedDeviceLabel: string | null;
        confirmCode: string;
    }>;

export type PairingRequestOk = Readonly<{ state: 'requested'; confirmCode: string }>;

export type PairingRequestErrorReason = 'not_found' | 'already_requested' | 'invalid_public_key' | 'http_error';

export type PairingRequestResult =
    | Readonly<{ ok: true; data: PairingRequestOk }>
    | Readonly<{ ok: false; reason: PairingRequestErrorReason; status: number }>;

export type PairingConsumeResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: 'not_found' | 'http_error'; status: number }>;

export type PairingStartResult =
    | Readonly<{ ok: true; data: PairingStartResponse }>
    | Readonly<{ ok: false; reason: 'http_error'; status: number }>;

export type PairingClaimStartResult =
    | Readonly<{ ok: true; data: PairingClaimStartResponseV1 }>
    | Readonly<{ ok: false; reason: 'unsupported' | 'http_error'; status: number }>;

export type PairingClaimConsumeResult =
    | Readonly<{ ok: true; data: PairingRequestOk }>
    | Readonly<{ ok: false; reason: 'not_found' | 'invalid_public_key' | 'http_error'; status: number }>;

export type PairingStatusResult =
    | Readonly<{ ok: true; data: PairingStatus }>
    | Readonly<{ ok: false; reason: 'not_found' | 'http_error'; status: number }>;

async function safeReadJson(res: Response): Promise<any | null> {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

export async function pairingStart(params: { secretHash: string }): Promise<PairingStartResult> {
    const res = await serverFetch(
        '/v1/auth/pairing/start',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secretHash: params.secretHash }),
        },
        { includeAuth: true },
    );
    if (!res.ok) {
        return { ok: false, reason: 'http_error', status: res.status };
    }
    const json = await safeReadJson(res);
    if (!json || typeof json.pairId !== 'string' || typeof json.expiresAt !== 'string') {
        return { ok: false, reason: 'http_error', status: 502 };
    }
    return { ok: true, data: { pairId: json.pairId, expiresAt: json.expiresAt } };
}

export async function pairingClaimStart(params: { origin: string }): Promise<PairingClaimStartResult> {
    const request = PairingClaimStartRequestV1Schema.safeParse(params);
    if (!request.success) {
        return { ok: false, reason: 'http_error', status: 400 };
    }

    const res = await serverFetch(
        '/v1/auth/pairing/claim/start',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.data),
        },
        { includeAuth: true },
    );
    if (!res.ok) {
        if (res.status === 404 || res.status === 405) {
            return { ok: false, reason: 'unsupported', status: res.status };
        }
        return { ok: false, reason: 'http_error', status: res.status };
    }

    const parsed = PairingClaimStartResponseV1Schema.safeParse(await safeReadJson(res));
    const localNowMs = Date.now();
    const expiresAtMs = parsed.success ? Date.parse(parsed.data.expiresAt) : Number.NaN;
    if (
        !parsed.success
        || parsed.data.origin !== request.data.origin
        || !Number.isFinite(expiresAtMs)
        || expiresAtMs <= localNowMs
        || expiresAtMs > localNowMs + PAIRING_CLAIM_V1_MAX_TTL_MS
    ) {
        return { ok: false, reason: 'http_error', status: 502 };
    }
    return { ok: true, data: parsed.data };
}

export async function pairingClaimConsume(
    params: Readonly<{ claimId: string; origin: string; publicKey: string; deviceLabel?: string }>,
): Promise<PairingClaimConsumeResult> {
    const request = PairingClaimConsumeRequestV1Schema.safeParse(params);
    if (!request.success) {
        return { ok: false, reason: 'http_error', status: 400 };
    }

    const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.data),
    };
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            res = await pairingClaimFetch(
                request.data.origin,
                '/v1/auth/pairing/claim/consume',
                requestInit,
            );
            break;
        } catch (error) {
            if (attempt === 0 && isRetryablePairingClaimFetchError(error)) continue;
            throw error;
        }
    }
    if (!res) throw new Error('Pairing claim consume completed without a response');
    if (res.ok) {
        const parsed = PairingClaimConsumeResponseV1Schema.safeParse(await safeReadJson(res));
        if (!parsed.success) return { ok: false, reason: 'http_error', status: 502 };
        return { ok: true, data: parsed.data };
    }
    if (res.status === 404) return { ok: false, reason: 'not_found', status: 404 };
    if (res.status === 401) return { ok: false, reason: 'invalid_public_key', status: 401 };
    return { ok: false, reason: 'http_error', status: res.status };
}

export async function pairingStatus(params: { pairId: string }): Promise<PairingStatusResult> {
    const res = await serverFetch(`/v1/auth/pairing/status?pairId=${encodeURIComponent(params.pairId)}`, undefined, {
        includeAuth: true,
    });
    if (!res.ok) {
        if (res.status === 404) {
            return { ok: false, reason: 'not_found', status: 404 };
        }
        return { ok: false, reason: 'http_error', status: res.status };
    }
    const json = await safeReadJson(res);
    if (!json || (json.state !== 'pending' && json.state !== 'requested') || typeof json.pairId !== 'string') {
        return { ok: false, reason: 'http_error', status: 502 };
    }
    return { ok: true, data: json };
}

export async function pairingRequest(params: {
    pairId: string;
    secret: string;
    publicKey: string;
    deviceLabel?: string;
}): Promise<PairingRequestResult> {
    const res = await serverFetch(
        '/v1/auth/pairing/request',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pairId: params.pairId,
                secret: params.secret,
                publicKey: params.publicKey,
                ...(params.deviceLabel ? { deviceLabel: params.deviceLabel } : null),
            }),
        },
        { includeAuth: false },
    );

    if (res.ok) {
        const json = await safeReadJson(res);
        if (json && json.state === 'requested' && typeof json.confirmCode === 'string') {
            return { ok: true, data: { state: 'requested', confirmCode: json.confirmCode } };
        }
        return { ok: false, reason: 'http_error', status: 502 };
    }

    if (res.status === 404) {
        return { ok: false, reason: 'not_found', status: 404 };
    }

    if (res.status === 401) {
        const json = await safeReadJson(res);
        if (json?.error === 'already_requested') {
            return { ok: false, reason: 'already_requested', status: 401 };
        }
        if (json?.error === 'Invalid public key') {
            return { ok: false, reason: 'invalid_public_key', status: 401 };
        }
        return { ok: false, reason: 'http_error', status: 401 };
    }

    return { ok: false, reason: 'http_error', status: res.status };
}

export async function pairingConsume(params: { pairId: string }): Promise<PairingConsumeResult> {
    const res = await serverFetch(
        '/v1/auth/pairing/consume',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairId: params.pairId }),
        },
        { includeAuth: true },
    );
    if (res.ok) {
        return { ok: true };
    }
    if (res.status === 404) {
        return { ok: false, reason: 'not_found', status: 404 };
    }
    return { ok: false, reason: 'http_error', status: res.status };
}
