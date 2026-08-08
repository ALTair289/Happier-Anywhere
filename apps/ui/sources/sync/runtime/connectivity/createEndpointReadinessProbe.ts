import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { probeAuthenticatedServerAuthPingEndpoint } from '@/sync/api/capabilities/probeAuthenticatedServerAuthPingEndpoint';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

import { buildRetryLaterProbeResultFromResponse } from './retryLaterProbeResult';
import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';

function normalizeAbsoluteHttpBaseUrl(raw: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null;
        }
        url.hash = '';
        url.search = '';
        return url.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

function joinBaseAndPath(baseUrl: string, path: string): string {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
}

/**
 * Bounds one probe attempt: aborts after `timeoutMs`, and stays linked to the caller's signal so a
 * released supervisor cancels the in-flight probe instead of leaking it.
 */
function createProbeAbort(timeoutMs: number, upstream: AbortSignal | undefined): {
    signal: AbortSignal | undefined;
    dispose: () => void;
} {
    if (typeof AbortController !== 'function') {
        return { signal: upstream, dispose: () => {} };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
    let removeListener = () => {};
    if (upstream) {
        if (upstream.aborted) {
            controller.abort();
        } else {
            const onAbort = () => controller.abort();
            upstream.addEventListener('abort', onAbort, { once: true });
            removeListener = () => upstream.removeEventListener('abort', onAbort);
        }
    }

    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            removeListener();
        },
    };
}

/**
 * Unauthenticated fallback for the case the authenticated owner cannot serve: no credentials are
 * available for this endpoint yet. It proves transport reachability only — never token acceptance.
 */
async function probeUnauthenticatedHealth(
    endpoint: string,
    signal: AbortSignal | undefined,
): Promise<ReadinessProbeResult> {
    try {
        const response = await runtimeFetch(joinBaseAndPath(endpoint, '/health'), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            ...(signal ? { signal } : {}),
        });

        if (response.status === 429 || response.status >= 500) {
            return buildRetryLaterProbeResultFromResponse(response, `Health probe returned ${response.status}`);
        }
        if (!response.ok) {
            return {
                status: 'server_unreachable',
                errorMessage: `Health probe returned ${response.status}`,
            };
        }
        return { status: 'ready' };
    } catch (error) {
        return {
            status: 'server_unreachable',
            errorMessage: sanitizeEndpointErrorMessage(error) ?? 'Network request failed',
        };
    }
}

/**
 * Readiness for the HTTP endpoint supervisor. The readiness *decision* is not made here: it is
 * delegated to `probeAuthenticatedServerAuthPingEndpoint`, the single owner shared with the socket
 * reachability lane, so both lanes classify a 404 from a foreign host and a captive-portal HTML 200
 * identically. This adapter owns only what is specific to the supervisor pool: the background/hidden
 * runtime gate, fail-closed endpoint validation, the per-probe timeout, and lazy token resolution.
 */
export function createEndpointReadinessProbe(params: Readonly<{
    endpoint: string;
    token: string | null | (() => string | null) | (() => Promise<string | null>);
    timeoutMs?: number;
    signal?: AbortSignal;
}>): () => Promise<ReadinessProbeResult> {
    const endpoint = normalizeAbsoluteHttpBaseUrl(params.endpoint);
    const timeoutMs = params.timeoutMs ?? 800;
    const backgroundRetryAfterMs = 60_000;
    const resolveToken = async (): Promise<string | null> => {
        try {
            const raw = typeof params.token === 'function' ? params.token() : params.token;
            const resolved = raw instanceof Promise ? await raw : raw;
            const value = typeof resolved === 'string' ? resolved.trim() : '';
            return value.length > 0 ? value : null;
        } catch {
            return null;
        }
    };

    return async () => {
        if (!isRuntimeActive()) {
            return {
                status: 'retry_later',
                retryAfterMs: backgroundRetryAfterMs,
                errorMessage: 'Runtime is inactive',
            };
        }
        if (!endpoint) {
            return {
                status: 'server_unreachable',
                errorMessage: 'Invalid endpoint URL',
            };
        }

        const token = await resolveToken();
        const abort = createProbeAbort(timeoutMs, params.signal);
        try {
            if (!token) {
                return await probeUnauthenticatedHealth(endpoint, abort.signal);
            }
            return await probeAuthenticatedServerAuthPingEndpoint({
                endpoint,
                token,
                ...(abort.signal ? { signal: abort.signal } : {}),
            });
        } finally {
            abort.dispose();
        }
    };
}
