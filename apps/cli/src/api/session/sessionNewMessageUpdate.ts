import { decodeBase64, decrypt } from '../encryption';
import type {
    Update,
    UserMessage,
} from '../types';
import { SessionMessageContentSchema, UserMessageSchema } from '../types';
import { coerceSessionUserPromptV1 } from '@happier-dev/protocol';
import { summarizeValueShapeForLog } from '@/diagnostics/eventShapeForLog';
import { readSessionHistoryReplayProvenance } from './sessionMessageCatchUp';

type ReceivedMessageIdStore = {
    has(value: string): boolean;
    add(value: string): unknown;
};

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function handleSessionNewMessageUpdate(params: {
    update: Update;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    receivedMessageIds: ReceivedMessageIdStore;
    replayPreviouslyObservedMessageIdsForObservation?: boolean;
    lastObservedMessageSeq: number;
    lastObservedUserMessageSeq: number;
    hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
    hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
    deleteMaterializedLocalId: (localId: string) => void;
    onObservedMessage?: (message: {
        body: unknown;
        seq: number | null;
        localId: string | null;
        sidechainId: string | null;
        createdAt: number | null;
    }) => void;
    emit: (event: 'user-message' | 'message', payload: unknown) => void;
    debug: (message: string, data?: unknown) => void;
    debugLargeJson: (message: string, data: unknown) => void;
}): {
    handled: boolean;
    lastObservedMessageSeq: number;
    lastObservedUserMessageSeq: number;
} {
    if (params.update.body?.t !== 'new-message') {
        return {
            handled: false,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }
    if (params.update.body.sid !== params.sessionId) {
        return {
            handled: true,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }

    const parsedContent = SessionMessageContentSchema.safeParse((params.update.body as any).message?.content);
    if (!parsedContent.success) {
        const rawContent = (params.update.body as any).message?.content;
        params.debug('[SOCKET] [UPDATE] Ignoring new-message with invalid content envelope', {
            issues: parsedContent.error.issues.map((i) => ({
                code: i.code,
                path: i.path,
                expected: 'expected' in i ? (i as any).expected : undefined,
                received: 'received' in i ? (i as any).received : undefined,
            })),
            contentShape: summarizeValueShapeForLog(rawContent),
        });
        return {
            handled: true,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }

    const messageId = params.update.body.message.id;
    if (typeof messageId === 'string' && messageId.length > 0) {
        if (
            params.receivedMessageIds.has(messageId)
            && params.replayPreviouslyObservedMessageIdsForObservation !== true
        ) {
            return {
                handled: true,
                lastObservedMessageSeq: params.lastObservedMessageSeq,
                lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
            };
        }
        params.receivedMessageIds.add(messageId);
    }

    let nextLastObservedMessageSeq = params.lastObservedMessageSeq;
    let nextLastObservedUserMessageSeq = params.lastObservedUserMessageSeq;
    const msgSeq = params.update.body.message.seq;
    if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
        nextLastObservedMessageSeq = Math.max(nextLastObservedMessageSeq, msgSeq);
    }

    const localId = readNonEmptyString(params.update.body.message.localId);
    const isSelfEchoSuppressedLocalId = Boolean(localId && params.hasSelfEchoSuppressedLocalId(localId));
    const isPendingQueueMaterializedLocalId = Boolean(localId && params.hasPendingQueueMaterializedLocalId(localId));
    if (localId && isSelfEchoSuppressedLocalId && !isPendingQueueMaterializedLocalId) {
        // We observed a provider-native self echo; cancel any local recovery path. Pending-queue
        // materialized ids stay owned by provider-acceptance cleanup.
        params.deleteMaterializedLocalId(localId);
    }

    let body: unknown;
    if (parsedContent.data.t === 'plain') {
        body = parsedContent.data.v;
    } else {
        try {
            body = decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(parsedContent.data.c));
        } catch (error) {
            params.debug('[SOCKET] [UPDATE] Failed to decrypt new-message payload', {
                error,
                messageId: typeof messageId === 'string' ? messageId : null,
                localId,
                msgSeq: typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
            });
            return {
                handled: true,
                lastObservedMessageSeq: nextLastObservedMessageSeq,
                lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
            };
        }
    }
    const bodyWithLocalId =
        params.update.body.message.localId === undefined
            ? body
            : {
                ...(body as any),
                localId: params.update.body.message.localId,
            };
    const transportCreatedAt =
        typeof params.update.body.message.createdAt === 'number' && Number.isFinite(params.update.body.message.createdAt)
            ? params.update.body.message.createdAt
            : typeof params.update.createdAt === 'number' && Number.isFinite(params.update.createdAt)
                ? params.update.createdAt
                : undefined;
    const historyReplayProvenance = readSessionHistoryReplayProvenance(params.update);
    const bodyWithTransportFields = {
        ...(bodyWithLocalId as any),
        // Attach server timestamps so downstream consumers can make clock-safe decisions.
        ...(transportCreatedAt === undefined ? {} : {
            createdAt: historyReplayProvenance?.sourceCreatedAt ?? transportCreatedAt,
        }),
        ...(transportCreatedAt === undefined ? {} : { serverCreatedAt: transportCreatedAt }),
    };

    params.debugLargeJson('[SOCKET] [UPDATE] Received update:', bodyWithTransportFields);
    // Catch-up rows remain transcript observations but cannot feed current-turn/progress inference.
    // Their provenance is process-local and cannot be forged by a remote row.
    if (historyReplayProvenance === null) {
        params.onObservedMessage?.({
            body: bodyWithTransportFields,
            seq: typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
            localId,
            sidechainId: typeof params.update.body.message.sidechainId === 'string' ? params.update.body.message.sidechainId : null,
            createdAt: transportCreatedAt ?? null,
        });
    }

    const observeUserMessage = (message: UserMessage): void => {
        if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
            nextLastObservedUserMessageSeq = Math.max(nextLastObservedUserMessageSeq, msgSeq);
        }
        params.emit('user-message', message);
    };

    // Transcript rows are observations only. Provider input is delivered exclusively by the
    // Queue materialization owner in ApiSessionClient; neither live echo nor catch-up can call it.
    const userResult = UserMessageSchema.safeParse(bodyWithTransportFields);
    if (userResult.success) {
        observeUserMessage(userResult.data);
    } else {
        const coerced = coerceSessionUserPromptV1(bodyWithTransportFields);
        if (coerced) {
            const candidate = {
                role: 'user' as const,
                content: { type: 'text' as const, text: coerced.text },
                createdAt: (bodyWithTransportFields as any).createdAt,
                localId: (bodyWithTransportFields as any).localId,
                localKey: (bodyWithTransportFields as any).localKey,
                meta: (bodyWithTransportFields as any).meta,
            };
            const parsedCandidate = UserMessageSchema.safeParse(candidate);
            if (parsedCandidate.success) {
                observeUserMessage(parsedCandidate.data);
                return {
                    handled: true,
                    lastObservedMessageSeq: nextLastObservedMessageSeq,
                    lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
                };
            }
        }

        const rawRole = (bodyWithTransportFields as any)?.role;
        if (rawRole === 'user') {
            params.debug('[SOCKET] [UPDATE] Dropping user prompt delivery: unable to coerce into a UserMessage', {
                issues: userResult.error.issues.map((i) => ({
                    code: i.code,
                    path: i.path,
                    expected: 'expected' in i ? (i as any).expected : undefined,
                    received: 'received' in i ? (i as any).received : undefined,
                })),
                bodyShape: summarizeValueShapeForLog(bodyWithTransportFields),
            });
        }
        params.emit('message', bodyWithTransportFields);
    }

    return {
        handled: true,
        lastObservedMessageSeq: nextLastObservedMessageSeq,
        lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
    };
}
