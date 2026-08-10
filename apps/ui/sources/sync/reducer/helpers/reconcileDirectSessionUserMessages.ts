import type { NormalizedMessage } from '../../typesRaw';
import { isDirectSessionUserMessageMeta } from '../../domains/messages/directSessionUserMessageProvenance';
import { normalizeTranscriptSeq } from '../../domains/messages/transcriptOrdering';
import type { ReducerMessage, ReducerState } from '../reducer';

type IndexedUserMessage = Readonly<{
    messageId: string;
    message: ReducerMessage;
}>;

type UserMessageIndexEntry = {
    canonical: IndexedUserMessage[];
    direct: IndexedUserMessage[];
};

function getOrCreateEntry(
    index: Map<string, UserMessageIndexEntry>,
    localId: string,
): UserMessageIndexEntry {
    const existing = index.get(localId);
    if (existing) return existing;
    const created: UserMessageIndexEntry = { canonical: [], direct: [] };
    index.set(localId, created);
    return created;
}

function indexExistingUserMessages(state: ReducerState): Map<string, UserMessageIndexEntry> {
    const index = new Map<string, UserMessageIndexEntry>();
    for (const [messageId, message] of state.messages) {
        if (message.role !== 'user' || !message.localId) continue;
        const entry = getOrCreateEntry(index, message.localId);
        const indexed = { messageId, message };
        if (isDirectSessionUserMessageMeta(message.meta) && normalizeTranscriptSeq(message.seq) === null) {
            entry.direct.push(indexed);
        } else if (!isDirectSessionUserMessageMeta(message.meta) && normalizeTranscriptSeq(message.seq) !== null) {
            entry.canonical.push(indexed);
        }
    }
    return index;
}

function promoteDirectMessageToCanonical(params: Readonly<{
    state: ReducerState;
    direct: IndexedUserMessage;
    incoming: Extract<NormalizedMessage, { role: 'user' }>;
    seq: number;
    changed: Set<string>;
}>): ReducerMessage {
    const promoted: ReducerMessage = {
        ...params.direct.message,
        realID: params.incoming.id,
        seq: params.seq,
        localId: params.incoming.localId,
        createdAt: params.incoming.createdAt,
        role: 'user',
        text: params.incoming.content.text,
        tool: null,
        event: null,
        meta: params.incoming.meta,
        sourceCreatedAt: params.incoming.sourceCreatedAt,
        sourceUpdatedAt: params.incoming.sourceUpdatedAt,
        transcriptObservationProvenance: params.incoming.transcriptObservationProvenance,
        deliveryResolution: params.incoming.deliveryResolution,
    };
    params.state.messages.set(params.direct.messageId, promoted);
    params.state.messageIds.set(params.incoming.id, params.direct.messageId);
    if (params.incoming.localId) {
        params.state.localIds.set(params.incoming.localId, params.direct.messageId);
    }
    params.changed.add(params.direct.messageId);
    return promoted;
}

/**
 * Reconciles only an exact Codex Direct observation/canonical server pair.
 * Text, timestamps and provider turn ids are deliberately not considered.
 */
export function reconcileDirectSessionUserMessages(params: Readonly<{
    state: ReducerState;
    messages: readonly NormalizedMessage[];
    changed: Set<string>;
}>): NormalizedMessage[] {
    const existingByLocalId = indexExistingUserMessages(params.state);
    const canonicalLocalIdsInBatch = new Set<string>();
    const out: NormalizedMessage[] = [];

    for (const message of params.messages) {
        if (message.role !== 'user' || !message.localId) {
            out.push(message);
            continue;
        }

        const entry = getOrCreateEntry(existingByLocalId, message.localId);
        const incomingIsDirect = isDirectSessionUserMessageMeta(message.meta);
        const incomingSeq = normalizeTranscriptSeq(message.seq);

        if (incomingIsDirect) {
            if (entry.canonical.length > 0 || canonicalLocalIdsInBatch.has(message.localId)) {
                continue;
            }
            out.push(message);
            continue;
        }

        if (incomingSeq !== null) {
            if (entry.canonical.length === 0 && entry.direct.length === 1) {
                const promoted = promoteDirectMessageToCanonical({
                    state: params.state,
                    direct: entry.direct[0]!,
                    incoming: message,
                    seq: incomingSeq,
                    changed: params.changed,
                });
                entry.direct = [];
                entry.canonical = [{ messageId: promoted.id, message: promoted }];
                continue;
            }
            canonicalLocalIdsInBatch.add(message.localId);
        }

        out.push(message);
    }

    return out;
}
