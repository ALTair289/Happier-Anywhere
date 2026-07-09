import axios from 'axios';
import { SessionEndAckResponseSchema } from '@happier-dev/protocol/updates';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

import type { SessionEndMutationV1 } from './sessionMutationTypes';
import type { SessionMutationDeliveredPath } from './sessionMutationOutboxFailureHandling';

type SessionEndSocket = {
    connected?: boolean;
    emit: (event: string, payload: unknown) => unknown;
    emitWithAck?: (event: string, payload: unknown) => Promise<unknown>;
};

const DEFAULT_SESSION_END_DELIVERY_CONCURRENCY = 2;
const MAX_SESSION_END_DELIVERY_CONCURRENCY = 16;

export type SessionEndMutationDeliveryResult =
    | Readonly<{
        status: 'delivered';
        path: Extract<SessionMutationDeliveredPath, 'http' | 'legacy_socket_ack' | 'legacy_socket_proof'>;
    }>
    | Readonly<{ status: 'retryable'; reason: 'session_end_http_unavailable' }>
    | Readonly<{
        status: 'unsupported_capability';
        reason: 'session_end_http_unsupported_without_legacy_proof';
    }>;

let activeSessionEndDeliveries = 0;
const pendingSessionEndDeliverySlots: Array<() => void> = [];

function resolveSessionEndDeliveryConcurrency(): number {
    const raw = String(process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY ?? '').trim();
    if (!raw) return DEFAULT_SESSION_END_DELIVERY_CONCURRENCY;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_SESSION_END_DELIVERY_CONCURRENCY;
    return Math.min(parsed, MAX_SESSION_END_DELIVERY_CONCURRENCY);
}

function drainPendingSessionEndDeliverySlots(): void {
    const limit = resolveSessionEndDeliveryConcurrency();
    while (activeSessionEndDeliveries < limit) {
        const resolve = pendingSessionEndDeliverySlots.shift();
        if (!resolve) return;
        activeSessionEndDeliveries += 1;
        resolve();
    }
}

async function acquireSessionEndDeliverySlot(): Promise<void> {
    if (activeSessionEndDeliveries < resolveSessionEndDeliveryConcurrency()) {
        activeSessionEndDeliveries += 1;
        return;
    }
    await new Promise<void>((resolve) => {
        pendingSessionEndDeliverySlots.push(resolve);
    });
}

async function withSessionEndDeliverySlot<T>(fn: () => Promise<T>): Promise<T> {
    await acquireSessionEndDeliverySlot();
    try {
        return await fn();
    } finally {
        activeSessionEndDeliveries = Math.max(0, activeSessionEndDeliveries - 1);
        drainPendingSessionEndDeliverySlots();
    }
}

function isUnsupportedHttpError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const directStatus = (error as { status?: unknown }).status;
    if (directStatus === 404 || directStatus === 405 || directStatus === 501) return true;
    const code = (error as { code?: unknown }).code;
    if (code === 'ERR_BAD_REQUEST' || code === 'ERR_BAD_RESPONSE') {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string' && /\b(404|405|501)\b/.test(message)) return true;
    }
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return false;
    const status = (response as { status?: unknown }).status;
    return status === 404 || status === 405 || status === 501;
}

function isInactiveSessionRecord(value: unknown, sessionId: string): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.id === sessionId && record.active === false;
}

function readInactiveSessionProof(body: unknown, sessionId: string): boolean {
    if (!body || typeof body !== 'object') return false;
    const record = body as Record<string, unknown>;
    if (isInactiveSessionRecord(record.session, sessionId)) return true;
    const sessions = record.sessions;
    return Array.isArray(sessions) && sessions.some((session) => isInactiveSessionRecord(session, sessionId));
}

function readLegacySocketSessionEndAckDelivered(value: unknown): boolean {
    const parsed = SessionEndAckResponseSchema.safeParse(value);
    return parsed.success && parsed.data.ok === true && parsed.data.active === false;
}

async function fetchSessionEndProof(params: Readonly<{
    serverUrl: string;
    token: string;
    sessionId: string;
}>): Promise<boolean> {
    const headers = { Authorization: `Bearer ${params.token}` };
    const urls = [
        `${params.serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}`,
        `${params.serverUrl}/v1/sessions`,
    ];
    for (const url of urls) {
        try {
            const response = await axios.get(url, {
                headers,
                timeout: 10_000,
            });
            if (readInactiveSessionProof(response?.data, params.sessionId)) {
                return true;
            }
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
        }
    }
    return false;
}

export async function deliverSessionEndMutation(params: Readonly<{
    token: string;
    socket: SessionEndSocket;
    mutation: SessionEndMutationV1;
}>): Promise<SessionEndMutationDeliveryResult> {
    return await withSessionEndDeliverySlot(async () => {
        const serverUrl = resolveServerHttpBaseUrl();
        try {
            const response = await axios.post(
                `${serverUrl}/v1/sessions/${encodeURIComponent(params.mutation.sessionId)}/end`,
                { time: params.mutation.observedAt },
                {
                    headers: {
                        Authorization: `Bearer ${params.token}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 10_000,
                },
            );
            const data = response?.data as Record<string, unknown> | undefined;
            if (data && (
                data.ok === false
                || data.result === 'error'
                || data.success === false
            )) {
                return { status: 'retryable', reason: 'session_end_http_unavailable' };
            }
            return { status: 'delivered', path: 'http' };
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
            if (isUnsupportedHttpError(error)) {
                if (params.socket.connected !== true) {
                    return { status: 'retryable', reason: 'session_end_http_unavailable' };
                }
                const payload = {
                    sid: params.mutation.sessionId,
                    time: params.mutation.observedAt,
                    ...(params.mutation.exit !== undefined ? { exit: params.mutation.exit } : {}),
                };
                if (typeof params.socket.emitWithAck === 'function') {
                    try {
                        const ack = await params.socket.emitWithAck('session-end', payload);
                        if (readLegacySocketSessionEndAckDelivered(ack)) {
                            return { status: 'delivered', path: 'legacy_socket_ack' };
                        }
                    } catch {
                        // Fall through to proof polling; the socket event may still have reached older runtimes.
                    }
                } else {
                    params.socket.emit('session-end', payload);
                }
                const delivered = await fetchSessionEndProof({
                    serverUrl,
                    token: params.token,
                    sessionId: params.mutation.sessionId,
                });
                if (delivered) return { status: 'delivered', path: 'legacy_socket_proof' };
                return {
                    status: 'unsupported_capability',
                    reason: 'session_end_http_unsupported_without_legacy_proof',
                };
            }
            return { status: 'retryable', reason: 'session_end_http_unavailable' };
        }
    });
}
