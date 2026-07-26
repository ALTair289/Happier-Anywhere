import {
    SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
    SessionRuntimeActivitySnapshotAckSchema,
    SessionRuntimeActivitySnapshotRequestSchema,
} from '@happier-dev/protocol';

import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { createAuthenticationHttpStatusError, isAuthenticationError } from '@/api/client/httpStatusError';

import type { SessionMutationDeliveryOutcome } from './sessionMutationOutboxFailureHandling';
import type { RuntimeActivitySnapshotMutationV1 } from './sessionMutationTypes';

type RuntimeActivitySnapshotSocket = Readonly<{
    connected?: boolean;
    emitWithAck: (event: string, ...args: unknown[]) => Promise<unknown>;
    timeout?: (ms: number) => RuntimeActivitySnapshotSocket;
}>;

function matchesMutationIdentity(
    mutation: RuntimeActivitySnapshotMutationV1,
    acknowledgement: Readonly<{ sessionId?: string; mutationId?: string }>,
): boolean {
    return acknowledgement.sessionId === mutation.sessionId
        && acknowledgement.mutationId === mutation.mutationId;
}

function matchesRequestedProjection(
    mutation: RuntimeActivitySnapshotMutationV1,
    acknowledgement: Readonly<{
        projection: Readonly<{ state: string; activeCount: number }>;
    }>,
): boolean {
    return acknowledgement.projection.state === mutation.snapshot.state
        && acknowledgement.projection.activeCount === mutation.snapshot.activeCount;
}

export async function deliverRuntimeActivitySnapshot(params: Readonly<{
    socket: RuntimeActivitySnapshotSocket;
    mutation: RuntimeActivitySnapshotMutationV1;
}>): Promise<SessionMutationDeliveryOutcome> {
    if (params.socket.connected === false) {
        return { status: 'retryable', reason: 'runtime_activity_snapshot_transport_unavailable' };
    }

    const request = SessionRuntimeActivitySnapshotRequestSchema.parse({
        sessionId: params.mutation.sessionId,
        mutationId: params.mutation.mutationId,
        snapshot: params.mutation.snapshot,
    });

    try {
        const rawAcknowledgement = await emitSocketWithAck({
            socket: params.socket,
            event: SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
            payload: request,
        });
        const parsed = SessionRuntimeActivitySnapshotAckSchema.safeParse(rawAcknowledgement);
        if (!parsed.success) {
            return { status: 'retryable', reason: 'runtime_activity_snapshot_ack_invalid' };
        }

        const acknowledgement = parsed.data;
        if (!('sessionId' in acknowledgement)
            || !('mutationId' in acknowledgement)
            || !matchesMutationIdentity(params.mutation, acknowledgement)) {
            return { status: 'retryable', reason: 'runtime_activity_snapshot_ack_invalid' };
        }
        if ((acknowledgement.status === 'applied' || acknowledgement.status === 'unchanged')
            && matchesRequestedProjection(params.mutation, acknowledgement)) {
            return {
                status: 'delivered',
                path: 'socket',
                runtimeActivityEvidence: {
                    disposition: acknowledgement.status,
                    projection: acknowledgement.projection,
                },
            };
        }
        if (acknowledgement.status === 'applied' || acknowledgement.status === 'unchanged') {
            return { status: 'retryable', reason: 'runtime_activity_snapshot_ack_invalid' };
        }
        if (acknowledgement.status === 'retryable' || acknowledgement.reason === 'superseded') {
            return {
                status: 'retryable',
                reason: `runtime_activity_snapshot_${acknowledgement.reason}`,
            };
        }
        if (acknowledgement.reason === 'unauthorized') {
            throw createAuthenticationHttpStatusError(403, 'Runtime Activity snapshot authorization failed');
        }
        return {
            status: 'permanent_invalid_payload',
            reason: `runtime_activity_snapshot_${acknowledgement.reason}`,
        };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return { status: 'retryable', reason: 'runtime_activity_snapshot_transport_unavailable' };
    }
}
