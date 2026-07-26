import axios from 'axios';
import { buildCurrentCliClientCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import {
    isServerHttpEndpointConnectionFailure,
    resolveServerHttpBaseUrl,
} from '@/session/transport/http/serverHttpBaseUrl';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    ExactSessionTurnEndMutationV1Schema,
    SessionTurnMutationReceiptV1Schema,
    isExactSessionTurnMutationPositiveReceiptV1,
    type ExactSessionTurnEndMutationV1,
    type SessionTurnMutationDecisionV1,
} from '@happier-dev/protocol';

import type { SessionTurnMutationV1 } from './sessionMutationTypes';

type SessionTurnMutationSocket = {
    connected?: boolean;
    emitWithAck: (event: string, ...args: unknown[]) => Promise<unknown>;
    timeout?: (ms: number) => SessionTurnMutationSocket;
};

export type SessionTurnMutationDeliveryResult =
    | Readonly<{ status: 'delivered'; path: 'socket' | 'http' }>
    | Readonly<{
        status: 'ignored_lossy';
        reason: 'touch_active_incompatible_session_turn_mutation_http';
        httpStatus: 400 | 422;
    }>
    | Readonly<{
        status: 'unsupported_capability';
        reason: 'session_turn_mutation_unsupported';
        diagnostic: UnsupportedSessionTurnMutationDiagnostic;
    }>
    | Readonly<{
        status: 'retryable';
        reason: 'incompatible_session_turn_mutation_http';
        httpStatus: 400 | 422;
    }>
    | Readonly<{
        status: 'retryable';
        reason: 'exact_session_turn_mutation_not_delivered';
        diagnostic: ExactSessionTurnMutationNonDeliveryDiagnostic;
    }>
    | Readonly<{ status: 'retryable'; reason: 'session_turn_mutation_transport_unavailable' }>;

type UnsupportedSessionTurnSocketEvidence = Readonly<{
    transport: 'socket';
    evidence: 'unsupported_ack' | 'no_ack';
    code?: string;
}>;

type UnsupportedSessionTurnHttpEvidence = Readonly<{
    transport: 'http';
    evidence: 'unsupported_status';
    status: 404 | 405 | 501;
}>;

type SessionTurnMutationSocketResult =
    | Readonly<{ status: 'delivered' }>
    | Readonly<{ status: 'unsupported'; evidence: UnsupportedSessionTurnSocketEvidence }>
    | Readonly<{ status: 'exact_non_delivery'; diagnostic: ExactReceiptDiagnostic }>
    | Readonly<{ status: 'failed'; evidence?: ExactTransportEvidence }>;

type SessionTurnMutationHttpResult =
    | Readonly<{ status: 'delivered' }>
    | Readonly<{ status: 'unsupported'; evidence: UnsupportedSessionTurnHttpEvidence }>
    | Readonly<{ status: 'exact_non_delivery'; diagnostic: ExactReceiptDiagnostic }>
    | Readonly<{ status: 'incompatible'; statusCode: 400 | 422 }>
    | Readonly<{ status: 'failed'; error?: unknown }>;

type ExactReceiptDiagnostic = Readonly<{
    classification: 'semantic_non_positive' | 'receipt_mismatch';
    decision?: SessionTurnMutationDecisionV1;
}>;

type ExactTransportEvidence = Readonly<{
    evidence: 'transport_unavailable' | 'no_ack';
    code?: string;
}>;

type ExactSocketDiagnosticEvidence = Readonly<{
    transport: 'socket';
    evidence: 'unsupported_ack' | 'no_ack' | 'transport_unavailable' | 'semantic_non_positive' | 'receipt_mismatch';
    code?: string;
    decision?: SessionTurnMutationDecisionV1;
}>;

type ExactHttpDiagnosticEvidence = Readonly<{
    transport: 'http';
    evidence: 'unsupported_status' | 'transport_unavailable' | 'semantic_non_positive' | 'receipt_mismatch';
    status?: number;
    decision?: SessionTurnMutationDecisionV1;
}>;

export type ExactSessionTurnMutationNonDeliveryDiagnostic = Readonly<{
    classification: 'semantic_non_positive' | 'receipt_mismatch' | 'transport_unsupported' | 'transport_unavailable';
    serverOrigin: string;
    sessionId: string;
    mutationId: string;
    action: 'end_session';
    turnId: string;
    observedAt: number;
    decision?: SessionTurnMutationDecisionV1;
    socket?: ExactSocketDiagnosticEvidence;
    http?: ExactHttpDiagnosticEvidence;
}>;

export type UnsupportedSessionTurnMutationDiagnostic = Readonly<{
    reason: 'session_turn_mutation_unsupported';
    classification?: 'transport_unsupported';
    serverOrigin: string;
    sessionId: string;
    mutationId: string;
    action: SessionTurnMutationV1['action'];
    turnId?: string;
    observedAt: number;
    socket: UnsupportedSessionTurnSocketEvidence;
    http: UnsupportedSessionTurnHttpEvidence;
}>;

function doesExactReceiptIdentityMatch(
    mutation: ExactSessionTurnEndMutationV1,
    receiptValue: unknown,
): receiptValue is ReturnType<typeof SessionTurnMutationReceiptV1Schema.parse> {
    const receipt = SessionTurnMutationReceiptV1Schema.safeParse(receiptValue);
    return receipt.success
        && receipt.data.v === mutation.v
        && receipt.data.sessionId === mutation.sessionId
        && receipt.data.mutationId === mutation.mutationId
        && receipt.data.action === mutation.action
        && receipt.data.turnId === mutation.turnId
        && receipt.data.observedAt === mutation.observedAt;
}

function classifyExactReceipt(
    mutation: ExactSessionTurnEndMutationV1,
    receiptValue: unknown,
): Readonly<{ delivered: true }> | Readonly<{ delivered: false; diagnostic: ExactReceiptDiagnostic }> {
    if (isExactSessionTurnMutationPositiveReceiptV1(mutation, receiptValue)) return { delivered: true };
    if (doesExactReceiptIdentityMatch(mutation, receiptValue)) {
        const receipt = SessionTurnMutationReceiptV1Schema.parse(receiptValue);
        return {
            delivered: false,
            diagnostic: {
                classification: 'semantic_non_positive',
                decision: receipt.decision,
            },
        };
    }
    return { delivered: false, diagnostic: { classification: 'receipt_mismatch' } };
}

function isSuccessAck(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.ok === true || record.result === 'success' || record.status === 'ok';
}

function isUnsupportedAck(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    const code = typeof record.errorCode === 'string' ? record.errorCode : typeof record.code === 'string' ? record.code : '';
    const message = typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : '';
    return /unsupported|unknown|not[_ -]?found/i.test(code) || /unsupported|unknown event|not found/i.test(message);
}

function readUnsupportedAckCode(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const code = typeof record.errorCode === 'string' ? record.errorCode : typeof record.code === 'string' ? record.code : '';
    return /unsupported|unknown|not[_ -]?found/i.test(code) ? code : undefined;
}

function readHttpErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return null;
    const status = (response as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
}

function resolveServerOrigin(serverUrl: string): string {
    try {
        return new URL(serverUrl).origin;
    } catch {
        return 'configured-server';
    }
}

function buildUnsupportedDiagnostic(params: Readonly<{
    serverOrigin: string;
    mutation: SessionTurnMutationV1;
    socket: UnsupportedSessionTurnSocketEvidence;
    http: UnsupportedSessionTurnHttpEvidence;
}>): UnsupportedSessionTurnMutationDiagnostic {
    return {
        reason: 'session_turn_mutation_unsupported',
        serverOrigin: params.serverOrigin,
        sessionId: params.mutation.sessionId,
        mutationId: params.mutation.mutationId,
        action: params.mutation.action,
        ...(params.mutation.turnId ? { turnId: params.mutation.turnId } : {}),
        observedAt: params.mutation.observedAt,
        socket: params.socket,
        http: params.http,
    };
}

async function trySocketSessionTurnMutation(params: Readonly<{
    socket: SessionTurnMutationSocket;
    mutation: SessionTurnMutationV1;
    exactMutation?: ExactSessionTurnEndMutationV1;
}>): Promise<SessionTurnMutationSocketResult> {
    if (params.socket.connected === false) return { status: 'failed' };
    try {
        const ack = await emitSocketWithAck({
            socket: params.socket,
            event: 'session-turn-mutation',
            payload: params.mutation,
        });
        if (params.exactMutation) {
            if (isUnsupportedAck(ack)) {
                const code = readUnsupportedAckCode(ack);
                return {
                    status: 'unsupported',
                    evidence: {
                        transport: 'socket',
                        evidence: 'unsupported_ack',
                        ...(code ? { code } : {}),
                    },
                };
            }
            const record = ack && typeof ack === 'object' ? ack as Record<string, unknown> : null;
            const classified = classifyExactReceipt(params.exactMutation, record?.receipt);
            return classified.delivered
                ? { status: 'delivered' }
                : { status: 'exact_non_delivery', diagnostic: classified.diagnostic };
        }
        if (isSuccessAck(ack)) return { status: 'delivered' };
        if (isUnsupportedAck(ack)) {
            const code = readUnsupportedAckCode(ack);
            return {
                status: 'unsupported',
                evidence: {
                    transport: 'socket',
                    evidence: 'unsupported_ack',
                    ...(code ? { code } : {}),
                },
            };
        }
        return { status: 'failed' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : undefined;
        return {
            status: 'failed',
            ...(params.exactMutation
                ? { evidence: { evidence: code === 'socket_ack_timeout' ? 'no_ack' : 'transport_unavailable', ...(code ? { code } : {}) } }
                : {}),
        };
    }
}

async function tryHttpSessionTurnMutation(params: Readonly<{
    token: string;
    mutation: SessionTurnMutationV1;
    serverUrl: string;
    exactMutation?: ExactSessionTurnEndMutationV1;
}>): Promise<SessionTurnMutationHttpResult> {
    try {
        const response = await axios.post(
            `${params.serverUrl}/v1/sessions/${encodeURIComponent(params.mutation.sessionId)}/turns/mutations`,
            params.mutation,
            {
                headers: {
                    Authorization: `Bearer ${params.token}`,
                    'Content-Type': 'application/json',
                    ...buildCurrentCliClientCompatibilityHttpHeaders('session-runner'),
                },
                timeout: 10_000,
            },
        );
        const data = response?.data as Record<string, unknown> | undefined;
        if (data && (data.ok === false || data.result === 'error')) return { status: 'failed' };
        if (params.exactMutation) {
            const classified = classifyExactReceipt(params.exactMutation, data?.receipt);
            return classified.delivered
                ? { status: 'delivered' }
                : { status: 'exact_non_delivery', diagnostic: classified.diagnostic };
        }
        return { status: 'delivered' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        const status = readHttpErrorStatus(error);
        if (status === 404 || status === 405 || status === 501) {
            return { status: 'unsupported', evidence: { transport: 'http', evidence: 'unsupported_status', status } };
        }
        if (status === 400 || status === 422) return { status: 'incompatible', statusCode: status };
        return { status: 'failed', error };
    }
}

export async function deliverSessionTurnMutation(params: Readonly<{
    token: string;
    socket: SessionTurnMutationSocket;
    mutation: SessionTurnMutationV1;
}>): Promise<SessionTurnMutationDeliveryResult> {
    const exactMutation = ExactSessionTurnEndMutationV1Schema.safeParse(params.mutation);
    const serverUrl = resolveServerHttpBaseUrl();
    const socketResult = params.socket.connected === true
        ? await trySocketSessionTurnMutation({
            socket: params.socket,
            mutation: params.mutation,
            ...(exactMutation.success ? { exactMutation: exactMutation.data } : {}),
        })
        : { status: 'failed' as const };
    if (socketResult.status === 'delivered') return { status: 'delivered', path: 'socket' };

    let httpServerUrl = serverUrl;
    let httpResult = await tryHttpSessionTurnMutation({
        token: params.token,
        mutation: params.mutation,
        serverUrl,
        ...(exactMutation.success ? { exactMutation: exactMutation.data } : {}),
    });
    if (httpResult.status === 'failed' && isServerHttpEndpointConnectionFailure(httpResult.error)) {
        const refreshedServerUrl = resolveServerHttpBaseUrl();
        if (refreshedServerUrl !== serverUrl) {
            httpServerUrl = refreshedServerUrl;
            httpResult = await tryHttpSessionTurnMutation({
                token: params.token,
                mutation: params.mutation,
                serverUrl: refreshedServerUrl,
                ...(exactMutation.success ? { exactMutation: exactMutation.data } : {}),
            });
        }
    }
    if (httpResult.status === 'delivered') return { status: 'delivered', path: 'http' };

    if (exactMutation.success) {
        const socketEvidence: ExactSocketDiagnosticEvidence | undefined = socketResult.status === 'unsupported'
            ? socketResult.evidence
            : socketResult.status === 'exact_non_delivery'
                ? {
                    transport: 'socket',
                    evidence: socketResult.diagnostic.classification,
                    ...(socketResult.diagnostic.decision ? { decision: socketResult.diagnostic.decision } : {}),
                }
            : socketResult.status === 'failed' && socketResult.evidence
                ? { transport: 'socket', ...socketResult.evidence }
                : undefined;
        const httpEvidence: ExactHttpDiagnosticEvidence | undefined = httpResult.status === 'unsupported'
            ? httpResult.evidence
            : httpResult.status === 'exact_non_delivery'
                ? {
                    transport: 'http',
                    evidence: httpResult.diagnostic.classification,
                    ...(httpResult.diagnostic.decision ? { decision: httpResult.diagnostic.decision } : {}),
                }
            : httpResult.status === 'failed'
                ? { transport: 'http', evidence: 'transport_unavailable' }
                : undefined;

        if (
            (socketEvidence?.evidence === 'no_ack' || socketEvidence?.evidence === 'unsupported_ack')
            && httpResult.status === 'unsupported'
        ) {
            return {
                status: 'unsupported_capability',
                reason: 'session_turn_mutation_unsupported',
                diagnostic: {
                    reason: 'session_turn_mutation_unsupported',
                    classification: 'transport_unsupported',
                    serverOrigin: resolveServerOrigin(httpServerUrl),
                    sessionId: exactMutation.data.sessionId,
                    mutationId: exactMutation.data.mutationId,
                    action: exactMutation.data.action,
                    turnId: exactMutation.data.turnId,
                    observedAt: exactMutation.data.observedAt,
                    socket: {
                        transport: 'socket',
                        evidence: socketEvidence.evidence,
                        ...(socketEvidence.code ? { code: socketEvidence.code } : {}),
                    },
                    http: httpResult.evidence,
                },
            };
        }

        const receiptDiagnostic = httpResult.status === 'exact_non_delivery'
            ? httpResult.diagnostic
            : socketResult.status === 'exact_non_delivery'
                ? socketResult.diagnostic
                : null;
        return {
            status: 'retryable',
            reason: 'exact_session_turn_mutation_not_delivered',
            diagnostic: {
                classification: receiptDiagnostic?.classification ?? 'transport_unavailable',
                serverOrigin: resolveServerOrigin(httpServerUrl),
                sessionId: exactMutation.data.sessionId,
                mutationId: exactMutation.data.mutationId,
                action: exactMutation.data.action,
                turnId: exactMutation.data.turnId,
                observedAt: exactMutation.data.observedAt,
                ...(receiptDiagnostic?.decision ? { decision: receiptDiagnostic.decision } : {}),
                ...(socketEvidence ? { socket: socketEvidence } : {}),
                ...(httpEvidence ? { http: httpEvidence } : {}),
            },
        };
    }

    if (
        socketResult.status === 'unsupported'
        && httpResult.status === 'unsupported'
    ) {
        return {
            status: 'unsupported_capability',
            reason: 'session_turn_mutation_unsupported',
            diagnostic: buildUnsupportedDiagnostic({
                serverOrigin: resolveServerOrigin(httpServerUrl),
                mutation: params.mutation,
                socket: socketResult.evidence,
                http: httpResult.evidence,
            }),
        };
    }

    if (httpResult.status === 'incompatible') {
        if (params.mutation.action === 'touch_active') {
            return {
                status: 'ignored_lossy',
                reason: 'touch_active_incompatible_session_turn_mutation_http',
                httpStatus: httpResult.statusCode,
            };
        }
        return {
            status: 'retryable',
            reason: 'incompatible_session_turn_mutation_http',
            httpStatus: httpResult.statusCode,
        };
    }
    return { status: 'retryable', reason: 'session_turn_mutation_transport_unavailable' };
}
