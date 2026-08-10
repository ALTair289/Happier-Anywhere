import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { normalizePairingClaimOriginV1 } from '@happier-dev/protocol';

export const PAIRING_CLAIM_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
const PAIRING_CLAIM_FETCH_MAX_TIMEOUT_MS = 30_000;

export type PairingClaimEndpointPath =
    | '/v1/auth/pairing/claim/consume'
    | '/v1/auth/account/request'
    | '/v2/auth/account/request';

export class PairingClaimFetchConfigurationError extends Error {
    constructor() {
        super('Invalid endpoint-pinned pairing claim request');
        this.name = 'PairingClaimFetchConfigurationError';
    }
}

export class PairingClaimFetchAbortedError extends Error {
    constructor() {
        super('Endpoint-pinned pairing claim request was cancelled');
        this.name = 'PairingClaimFetchAbortedError';
    }
}

export class PairingClaimFetchTimeoutError extends Error {
    constructor() {
        super('Endpoint-pinned pairing claim request timed out');
        this.name = 'PairingClaimFetchTimeoutError';
    }
}

export class PairingClaimFetchTransportError extends Error {
    constructor(cause?: unknown) {
        super('Endpoint-pinned pairing claim transport failed');
        this.name = 'PairingClaimFetchTransportError';
        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}

export function isRetryablePairingClaimFetchError(error: unknown): boolean {
    return error instanceof PairingClaimFetchTimeoutError || error instanceof PairingClaimFetchTransportError;
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
    const candidate = timeoutMs ?? PAIRING_CLAIM_FETCH_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(candidate) || candidate < 1 || candidate > PAIRING_CLAIM_FETCH_MAX_TIMEOUT_MS) {
        throw new PairingClaimFetchConfigurationError();
    }
    return Math.trunc(candidate);
}

function assertCredentialFreeHeaders(headers: Headers): void {
    for (const name of ['authorization', 'cookie', 'proxy-authorization']) {
        if (headers.has(name)) throw new PairingClaimFetchConfigurationError();
    }
}

/**
 * A deliberately isolated transport for the pre-authorization claim handshake.
 * It never consults active-server state and never participates in the authenticated
 * serverFetch lifecycle (global aborts, reachability, token refresh, or upgrade state).
 */
export async function pairingClaimFetch(
    origin: string,
    path: PairingClaimEndpointPath,
    init: RequestInit = {},
    options: Readonly<{ timeoutMs?: number }> = {},
): Promise<Response> {
    const normalizedOrigin = normalizePairingClaimOriginV1(origin);
    if (!normalizedOrigin || normalizedOrigin !== origin) {
        throw new PairingClaimFetchConfigurationError();
    }

    const timeoutMs = resolveTimeoutMs(options.timeoutMs);
    const headers = new Headers(init.headers);
    assertCredentialFreeHeaders(headers);

    const callerSignal = init.signal;
    if (callerSignal?.aborted) throw new PairingClaimFetchAbortedError();

    const requestController = new AbortController();
    let callerAborted = false;
    let timedOut = false;
    let rejectBoundary!: (error: Error) => void;
    const boundary = new Promise<never>((_resolve, reject) => {
        rejectBoundary = reject;
    });

    const onCallerAbort = () => {
        callerAborted = true;
        requestController.abort();
        rejectBoundary(new PairingClaimFetchAbortedError());
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        requestController.abort();
        rejectBoundary(new PairingClaimFetchTimeoutError());
    }, timeoutMs);

    const transport = Promise.resolve().then(() => {
        if (callerAborted || callerSignal?.aborted) throw new PairingClaimFetchAbortedError();
        return runtimeFetch(
            `${origin}${path}`,
            {
                ...init,
                headers,
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                signal: requestController.signal,
            },
        );
    }).catch((error: unknown) => {
        if (timedOut) throw new PairingClaimFetchTimeoutError();
        if (callerAborted || callerSignal?.aborted) throw new PairingClaimFetchAbortedError();
        if (
            error instanceof PairingClaimFetchConfigurationError
            || error instanceof PairingClaimFetchAbortedError
            || error instanceof PairingClaimFetchTimeoutError
            || error instanceof PairingClaimFetchTransportError
        ) {
            throw error;
        }
        throw new PairingClaimFetchTransportError(error);
    });

    try {
        return await Promise.race([transport, boundary]);
    } finally {
        clearTimeout(timeoutHandle);
        callerSignal?.removeEventListener('abort', onCallerAbort);
    }
}
