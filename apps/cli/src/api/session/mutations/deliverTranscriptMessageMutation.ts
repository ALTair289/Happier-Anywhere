import axios from 'axios';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { MessageAckResponseSchema } from '@/api/types';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';

import type { TranscriptMessageAppendMutationV1 } from './sessionMutationTypes';

type TranscriptMessageMutationSocket = {
    connected?: boolean;
    emitWithAck: (event: string, ...args: unknown[]) => Promise<unknown>;
    timeout?: (ms: number) => TranscriptMessageMutationSocket;
};

export type TranscriptMessageMutationDeliveryResult =
    | Readonly<{ status: 'delivered'; path: 'socket' | 'http' }>
    | Readonly<{ status: 'retryable'; reason: 'transcript_message_transport_unavailable'; httpStatus?: number }>;

function readHttpErrorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const directStatus = (error as { status?: unknown }).status;
    if (typeof directStatus === 'number') return directStatus;
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return undefined;
    const status = (response as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
}

async function trySocketTranscriptMutation(params: Readonly<{
    socket: TranscriptMessageMutationSocket;
    mutation: TranscriptMessageAppendMutationV1;
}>): Promise<boolean> {
    if (params.socket.connected !== true) return false;
    try {
        const raw = await emitSocketWithAck({
            socket: params.socket,
            event: 'message',
            payload: {
                sid: params.mutation.sessionId,
                message: params.mutation.content,
                localId: params.mutation.localId,
                echoToSender: true,
                sidechainId: params.mutation.sidechainId ?? null,
                ...(params.mutation.messageRole ? { messageRole: params.mutation.messageRole } : {}),
                ...(params.mutation.sessionEventType ? { sessionEventType: params.mutation.sessionEventType } : {}),
            },
        });
        const parsed = MessageAckResponseSchema.safeParse(raw);
        return parsed.success && parsed.data.ok === true;
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return false;
    }
}

async function tryHttpTranscriptMutation(params: Readonly<{
    token: string;
    mutation: TranscriptMessageAppendMutationV1;
    serverUrl: string;
}>): Promise<TranscriptMessageMutationDeliveryResult> {
    try {
        const body = typeof params.mutation.content === 'string'
            ? {
                ciphertext: params.mutation.content,
                localId: params.mutation.localId,
                sidechainId: params.mutation.sidechainId ?? null,
                ...(params.mutation.messageRole ? { messageRole: params.mutation.messageRole } : {}),
                ...(params.mutation.sessionEventType ? { sessionEventType: params.mutation.sessionEventType } : {}),
            }
            : {
                content: params.mutation.content,
                localId: params.mutation.localId,
                sidechainId: params.mutation.sidechainId ?? null,
                ...(params.mutation.messageRole ? { messageRole: params.mutation.messageRole } : {}),
                ...(params.mutation.sessionEventType ? { sessionEventType: params.mutation.sessionEventType } : {}),
            };
        const response = await axios.post(
            `${params.serverUrl}/v2/sessions/${encodeURIComponent(params.mutation.sessionId)}/messages`,
            body,
            {
                headers: {
                    Authorization: `Bearer ${params.token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': params.mutation.localId,
                },
                timeout: 10_000,
            },
        );
        const data = response?.data as Record<string, unknown> | undefined;
        if (data && (data.ok === false || data.result === 'error')) {
            return { status: 'retryable', reason: 'transcript_message_transport_unavailable' };
        }
        return { status: 'delivered', path: 'http' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return {
            status: 'retryable',
            reason: 'transcript_message_transport_unavailable',
            httpStatus: readHttpErrorStatus(error),
        };
    }
}

export async function deliverTranscriptMessageMutation(params: Readonly<{
    token: string;
    socket: TranscriptMessageMutationSocket;
    mutation: TranscriptMessageAppendMutationV1;
}>): Promise<TranscriptMessageMutationDeliveryResult> {
    const socketDelivered = await trySocketTranscriptMutation({
        socket: params.socket,
        mutation: params.mutation,
    });
    if (socketDelivered) return { status: 'delivered', path: 'socket' };

    const serverUrl = resolveServerHttpBaseUrl();
    return await tryHttpTranscriptMutation({
        token: params.token,
        mutation: params.mutation,
        serverUrl,
    });
}
