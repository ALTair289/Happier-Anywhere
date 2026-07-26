import { SessionRuntimeActivitySnapshotSchema } from '@happier-dev/protocol';
import type { SessionRuntimeActivitySnapshot } from '@happier-dev/protocol';

import type { SessionRuntimeActivitySnapshotPublisher } from '@/session/runtimeActivity/types';

import type { SessionMutationOutbox } from './createSessionMutationOutbox';
import {
    createRuntimeActivitySnapshotMutation,
} from './sessionMutationTypes';

export type CreateRuntimeActivitySnapshotSessionMutationPublisherParams = Readonly<{
    sessionId: string;
    journal: SessionMutationOutbox;
}>;

export const RUNTIME_ACTIVITY_DESIRED_REOFFER_REQUEST = Symbol('runtimeActivityDesiredReofferRequest');

export type RuntimeActivitySnapshotSessionMutationPublisher = SessionRuntimeActivitySnapshotPublisher & Readonly<{
    subscribeDesiredReoffer(listener: () => Promise<void>): () => void;
    [RUNTIME_ACTIVITY_DESIRED_REOFFER_REQUEST](): Promise<void>;
}>;

export function createRuntimeActivitySnapshotSessionMutationPublisher(
    params: CreateRuntimeActivitySnapshotSessionMutationPublisherParams,
): RuntimeActivitySnapshotSessionMutationPublisher {
    let accepting = true;
    let operationTail: Promise<void> = Promise.resolve();
    const desiredReofferListeners = new Set<() => Promise<void>>();

    const enqueueOperation = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = operationTail.then(operation, operation);
        operationTail = result.then(() => undefined, () => undefined);
        return result;
    };

    const publish = async (snapshot: SessionRuntimeActivitySnapshot): Promise<void> => {
        if (!accepting) throw new Error('Cannot publish runtime Activity after publisher close');
        const canonicalSnapshot = SessionRuntimeActivitySnapshotSchema.parse(snapshot);
        await enqueueOperation(async () => {
            const mutation = createRuntimeActivitySnapshotMutation({
                sessionId: params.sessionId,
                snapshot: canonicalSnapshot,
            });
            const result = await params.journal.enqueueRuntimeActivitySnapshot(mutation);
            if (!result.persisted) {
                throw new Error('Runtime Activity snapshot was not persisted');
            }
        });
    };

    const subscribeDesiredReoffer = (listener: () => Promise<void>): (() => void) => {
        if (!accepting) return () => undefined;
        desiredReofferListeners.add(listener);
        return () => {
            desiredReofferListeners.delete(listener);
        };
    };

    const close = async (): Promise<void> => {
        if (!accepting) {
            await operationTail;
            return;
        }
        accepting = false;
        await operationTail;
        desiredReofferListeners.clear();
    };

    return {
        publish,
        subscribeDesiredReoffer,
        close,
        async [RUNTIME_ACTIVITY_DESIRED_REOFFER_REQUEST]() {
            if (!accepting) return;
            for (const listener of [...desiredReofferListeners]) {
                await listener();
            }
        },
    };
}
