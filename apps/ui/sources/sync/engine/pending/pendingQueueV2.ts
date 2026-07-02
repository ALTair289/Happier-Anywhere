import { storage } from '@/sync/domains/state/storage';
import type { Encryption } from '@/sync/encryption/encryption';
import { nowServerMs } from '@/sync/runtime/time';
import { RawRecordSchema, type RawRecord } from '@/sync/typesRaw';
import { randomUUID } from '@/platform/randomUUID';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type {
    DiscardedPendingMessage,
    PendingDeliveryStatus,
    PendingMessage,
} from '@/sync/domains/state/storageTypes';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { resolveSentFrom } from '@/sync/domains/messages/sentFrom';
import { buildSendMessageMeta } from '@/sync/domains/messages/buildSendMessageMeta';
import { throwAuthenticationResponseErrorIfNeeded } from '@/sync/runtime/connectivity/authErrors';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import {
    normalizePendingDeliveryBlockedReason,
    SessionStoredMessageContentSchema,
    type PendingDeliveryBlockedReason,
    type SessionStoredMessageContent,
} from '@happier-dev/protocol';
import { t } from '@/text';

type PendingStatus = 'queued' | 'delivering' | 'blocked' | 'discarded' | 'unknown';

type PendingRow = {
    localId: string;
    content: SessionStoredMessageContent;
    status: PendingStatus;
    statusRaw: string;
    deliveryStateRaw: string | null;
    position: number;
    createdAt: number;
    updatedAt: number;
    discardedAt: number | null;
    discardedReason: string | null;
    deliveryBlockedReason: string | null;
    authorAccountId: string | null;
};

type PendingDecryptFailure = Readonly<{
    kind: 'decrypt_failed';
}>;

function assertPendingResponseOk(response: Response, message: string): void {
    if (response.ok) return;
    throwAuthenticationResponseErrorIfNeeded(response.status);
    throw new Error(`${message} (${response.status})`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePendingRows(raw: unknown): PendingRow[] | null {
    if (!isPlainObject(raw)) return null;
    const pending = raw.pending;
    if (!Array.isArray(pending)) return null;

    const out: PendingRow[] = [];
    for (const item of pending) {
        if (!isPlainObject(item)) continue;
        const localId = item.localId;
        const content = item.content;
        const status = item.status;
        const deliveryState = item.deliveryState;
        const position = item.position;
        const createdAt = item.createdAt;
        const updatedAt = item.updatedAt;
        const discardedAt = item.discardedAt;
        const discardedReason = item.discardedReason;
        const deliveryBlockedReason = item.deliveryBlockedReason;
        const authorAccountId = item.authorAccountId;

        if (typeof localId !== 'string' || localId.length === 0) continue;
        if (!isPlainObject(content)) continue;
        const contentParsed = SessionStoredMessageContentSchema.safeParse(content);
        if (!contentParsed.success) continue;
        const statusRaw = typeof status === 'string' && status.length > 0 ? status : 'unknown';
        const legacyStatus: PendingStatus =
            statusRaw === 'queued' || statusRaw === 'delivering' || statusRaw === 'blocked' || statusRaw === 'discarded'
                ? statusRaw
                : 'unknown';
        const deliveryStateRaw = typeof deliveryState === 'string' && deliveryState.length > 0
            ? deliveryState
            : null;
        const parsedStatus: PendingStatus = legacyStatus !== 'discarded' && deliveryStateRaw
            ? (
                deliveryStateRaw === 'queued' || deliveryStateRaw === 'delivering' || deliveryStateRaw === 'blocked'
                    ? deliveryStateRaw
                    : 'unknown'
            )
            : legacyStatus;
        if (typeof position !== 'number' || !Number.isFinite(position)) continue;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue;

        out.push({
            localId,
            content: contentParsed.data,
            status: parsedStatus,
            statusRaw: legacyStatus !== 'discarded' && deliveryStateRaw ? deliveryStateRaw : statusRaw,
            deliveryStateRaw,
            position,
            createdAt,
            updatedAt,
            discardedAt: typeof discardedAt === 'number' && Number.isFinite(discardedAt) ? discardedAt : null,
            discardedReason: typeof discardedReason === 'string' && discardedReason.length > 0 ? discardedReason : null,
            deliveryBlockedReason:
                typeof deliveryBlockedReason === 'string' && deliveryBlockedReason.length > 0
                    ? deliveryBlockedReason
                    : null,
            authorAccountId: typeof authorAccountId === 'string' && authorAccountId.length > 0 ? authorAccountId : null,
        });
    }
    return out;
}

function resolvePendingDeliveryStatus(row: Pick<PendingRow, 'status'>): PendingDeliveryStatus {
    if (row.status === 'delivering') return 'server_delivering';
    if (row.status === 'blocked' || row.status === 'unknown') return 'blocked';
    return 'server_queued';
}

function resolvePendingDeliveryBlockedReason(row: Pick<PendingRow, 'status' | 'deliveryBlockedReason'>): {
    reason?: PendingDeliveryBlockedReason;
    rawReason?: string;
} {
    if (row.status !== 'blocked' && row.status !== 'unknown') return {};
    if (!row.deliveryBlockedReason) return { reason: 'unknown' };
    const reason = normalizePendingDeliveryBlockedReason(row.deliveryBlockedReason);
    return reason ? { reason } : { reason: 'unknown', rawReason: row.deliveryBlockedReason };
}

function coerceDiscardReason(value: string | null): 'switch_to_local' | 'manual' {
    if (value === 'switch_to_local') return 'switch_to_local';
    return 'manual';
}

function coercePendingUserTextRecord(decrypted: unknown): { rawRecord: RawRecord; text: string; displayText?: string } | null {
    const parsed = RawRecordSchema.safeParse(decrypted);
    if (!parsed.success) return null;
    const record = parsed.data;
    if (record.role !== 'user') return null;

    const text = record.content.text;
    if (typeof text !== 'string' || text.trim().length === 0) return null;

    const displayTextRaw = record.meta?.displayText;
    const displayText = typeof displayTextRaw === 'string' && displayTextRaw.trim().length > 0 ? displayTextRaw : undefined;

    return { rawRecord: record, text, displayText };
}

const enqueueCommitTailsBySessionId = new Map<string, Promise<void>>();
const deletedPendingLocalIdsBySessionId = new Map<string, Set<string>>();

function runPendingEnqueueCommitInOrder<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    const prev = enqueueCommitTailsBySessionId.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    const settled = next.then(
        () => undefined,
        () => undefined,
    );
    const tail = settled.finally(() => {
        if (enqueueCommitTailsBySessionId.get(sessionId) === tail) {
            enqueueCommitTailsBySessionId.delete(sessionId);
        }
    });
    enqueueCommitTailsBySessionId.set(sessionId, tail);
    return next;
}

function markPendingLocalIdDeleted(sessionId: string, localId: string): void {
    const deleted = deletedPendingLocalIdsBySessionId.get(sessionId) ?? new Set<string>();
    deleted.add(localId);
    deletedPendingLocalIdsBySessionId.set(sessionId, deleted);
}

function isPendingLocalIdDeleted(sessionId: string, localId: string): boolean {
    return deletedPendingLocalIdsBySessionId.get(sessionId)?.has(localId) === true;
}

function clearDeletedPendingLocalId(sessionId: string, localId: string): void {
    const deleted = deletedPendingLocalIdsBySessionId.get(sessionId);
    if (!deleted) return;
    deleted.delete(localId);
    if (deleted.size === 0) {
        deletedPendingLocalIdsBySessionId.delete(sessionId);
    }
}

function filterDeletedPendingRows<T extends Pick<PendingRow, 'localId'>>(sessionId: string, rows: T[]): T[] {
    const deleted = deletedPendingLocalIdsBySessionId.get(sessionId);
    if (!deleted || deleted.size === 0) return rows;
    return rows.filter((row) => !deleted.has(row.localId));
}

function pruneDeletedPendingLocalIds(sessionId: string, rows: Pick<PendingRow, 'localId'>[]): void {
    const deleted = deletedPendingLocalIdsBySessionId.get(sessionId);
    if (!deleted || deleted.size === 0) return;

    const presentLocalIds = new Set(rows.map((row) => row.localId));
    for (const localId of deleted) {
        if (!presentLocalIds.has(localId)) {
            deleted.delete(localId);
        }
    }

    if (deleted.size === 0) {
        deletedPendingLocalIdsBySessionId.delete(sessionId);
    }
}

async function deleteAcceptedTombstonedPendingMessage(params: {
    sessionId: string;
    localId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    try {
        const response = await params.request(`/v2/sessions/${params.sessionId}/pending/${params.localId}`, { method: 'DELETE' });
        if (!response.ok) {
            assertPendingResponseOk(response, 'Failed to delete pending message');
        }
        clearDeletedPendingLocalId(params.sessionId, params.localId);
    } catch {
        return;
    }
}

function buildPendingDecryptFailureMessage(params: {
    row: Pick<PendingRow, 'localId' | 'createdAt' | 'updatedAt'>;
}): {
    id: string;
    localId: string;
    createdAt: number;
    updatedAt: number;
    source: 'server_pending';
    text: string;
    displayText: string;
    rawRecord: { pendingDecryptFailure: PendingDecryptFailure };
    pendingDecryptFailure: PendingDecryptFailure;
} {
    const pendingDecryptFailure: PendingDecryptFailure = { kind: 'decrypt_failed' };

    return {
        id: params.row.localId,
        localId: params.row.localId,
        createdAt: params.row.createdAt,
        updatedAt: params.row.updatedAt,
        source: 'server_pending',
        text: '',
        displayText: t('session.pendingMessages.decryptFailed'),
        rawRecord: { pendingDecryptFailure },
        pendingDecryptFailure,
    };
}

function withPendingDeliveryState<T extends PendingMessage>(row: PendingRow, message: T): T {
    const pendingDeliveryStatus = resolvePendingDeliveryStatus(row);
    const { reason: pendingDeliveryBlockedReason, rawReason: pendingDeliveryBlockedReasonRaw } = resolvePendingDeliveryBlockedReason(row);
    return {
        ...message,
        pendingDeliveryStatus,
        ...(pendingDeliveryBlockedReason ? { pendingDeliveryBlockedReason } : {}),
        ...(pendingDeliveryBlockedReasonRaw ? { pendingDeliveryBlockedReasonRaw } : {}),
        ...(row.status === 'unknown' ? { pendingDeliveryStatusRaw: row.statusRaw } : {}),
    };
}

function mergeServerPendingMessagesWithLocalOutbound(params: Readonly<{
    sessionId: string;
    serverPendingMessages: PendingMessage[];
    serverDiscardedMessages: DiscardedPendingMessage[];
}>): PendingMessage[] {
    const existing = storage.getState().sessionPending[params.sessionId]?.messages ?? [];
    if (existing.length === 0) return params.serverPendingMessages;

    const serverLocalIds = new Set<string>();
    for (const message of params.serverPendingMessages) {
        if (message.localId) serverLocalIds.add(message.localId);
    }
    for (const message of params.serverDiscardedMessages) {
        if (message.localId) serverLocalIds.add(message.localId);
    }

    const preservedLocalOutbound = existing.filter((message) => {
        if (message.localId && serverLocalIds.has(message.localId)) return false;
        return message.source === 'local_outbound'
            || (message.source == null && message.deliveryStatus === 'accepted');
    });
    if (preservedLocalOutbound.length === 0) return params.serverPendingMessages;

    const merged = [...params.serverPendingMessages];
    const mergedIds = new Set(merged.map((message) => message.id));
    for (const message of preservedLocalOutbound) {
        if (mergedIds.has(message.id)) continue;
        merged.push(message);
        mergedIds.add(message.id);
    }
    return merged;
}

async function readPendingRowDecryptedContent(params: {
    row: Pick<PendingRow, 'content' | 'localId' | 'createdAt' | 'updatedAt'>;
    sessionEncryption: ReturnType<Encryption['getSessionEncryption']>;
}): Promise<
    | { kind: 'ok'; value: unknown }
    | { kind: 'decrypt_failed'; message: ReturnType<typeof buildPendingDecryptFailureMessage> }
> {
    if (params.row.content.t !== 'encrypted') {
        return { kind: 'ok', value: params.row.content.v };
    }

    if (!params.sessionEncryption) {
        return {
            kind: 'decrypt_failed',
            message: buildPendingDecryptFailureMessage({ row: params.row }),
        };
    }

    try {
        const decrypted = await params.sessionEncryption.decryptRaw(params.row.content.c);
        if (decrypted == null) {
            return {
                kind: 'decrypt_failed',
                message: buildPendingDecryptFailureMessage({ row: params.row }),
            };
        }

        return {
            kind: 'ok',
            value: decrypted,
        };
    } catch {
        return {
            kind: 'decrypt_failed',
            message: buildPendingDecryptFailureMessage({ row: params.row }),
        };
    }
}

export async function fetchAndApplyPendingMessagesV2(params: {
    sessionId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, encryption, request } = params;

    const session = storage.getState().sessions[sessionId] ?? null;
    const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);

    const response = await request(`/v2/sessions/${sessionId}/pending?includeDiscarded=1`, { method: 'GET' });
    if (!response.ok) {
        throwAuthenticationResponseErrorIfNeeded(response.status);
        storage.getState().applyPendingLoaded(sessionId);
        storage.getState().applyDiscardedPendingMessages(sessionId, []);
        return;
    }

    const json = await response.json().catch(() => null);
    const rows = parsePendingRows(json);
    if (!rows) {
        storage.getState().applyPendingLoaded(sessionId);
        storage.getState().applyDiscardedPendingMessages(sessionId, []);
        return;
    }

    pruneDeletedPendingLocalIds(sessionId, rows);
    const visibleRows = filterDeletedPendingRows(sessionId, rows);

    const queued = visibleRows
        .filter((r) => r.status !== 'discarded')
        .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.localId.localeCompare(b.localId));
    const discarded = visibleRows
        .filter((r) => r.status === 'discarded')
        .sort((a, b) => (a.discardedAt ?? a.updatedAt) - (b.discardedAt ?? b.updatedAt));

    const pendingMessages: PendingMessage[] = [];
    for (const r of queued) {
        const decrypted = await readPendingRowDecryptedContent({
            row: r,
            sessionEncryption,
        });
        if (decrypted.kind === 'decrypt_failed') {
            pendingMessages.push(withPendingDeliveryState(r, decrypted.message));
            continue;
        }

        const coerced = coercePendingUserTextRecord(decrypted.value);
        if (!coerced) {
            pendingMessages.push(withPendingDeliveryState(r, buildPendingDecryptFailureMessage({ row: r })));
            continue;
        }
        pendingMessages.push(withPendingDeliveryState(r, {
            id: r.localId,
            localId: r.localId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            source: 'server_pending',
            text: coerced.text,
            displayText: coerced.displayText,
            rawRecord: coerced.rawRecord,
        }));
    }

    const discardedMessages: DiscardedPendingMessage[] = [];
    for (const r of discarded) {
        const decrypted = await readPendingRowDecryptedContent({
            row: r,
            sessionEncryption,
        });
        if (decrypted.kind === 'decrypt_failed') {
            discardedMessages.push({
                ...decrypted.message,
                discardedAt: r.discardedAt ?? r.updatedAt,
                discardedReason: coerceDiscardReason(r.discardedReason),
            });
            continue;
        }

        const coerced = coercePendingUserTextRecord(decrypted.value);
        if (!coerced) {
            discardedMessages.push({
                ...buildPendingDecryptFailureMessage({ row: r }),
                discardedAt: r.discardedAt ?? r.updatedAt,
                discardedReason: coerceDiscardReason(r.discardedReason),
            });
            continue;
        }
        discardedMessages.push({
            id: r.localId,
            localId: r.localId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            source: 'server_pending',
            text: coerced.text,
            displayText: coerced.displayText,
            rawRecord: coerced.rawRecord,
            discardedAt: r.discardedAt ?? r.updatedAt,
            discardedReason: coerceDiscardReason(r.discardedReason),
        });
    }

    storage.getState().applyPendingMessages(sessionId, mergeServerPendingMessagesWithLocalOutbound({
        sessionId,
        serverPendingMessages: pendingMessages,
        serverDiscardedMessages: discardedMessages,
    }));
    storage.getState().applyDiscardedPendingMessages(sessionId, discardedMessages);
}

export async function enqueuePendingMessageV2(params: {
    sessionId: string;
    text: string;
    displayText?: string;
    encryption: Encryption;
    metaOverrides?: Record<string, unknown>;
    fetchArtifactWithBody?: (artifactId: string) => Promise<DecryptedArtifact | null>;
    updateArtifact?: (artifact: DecryptedArtifact) => void;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
}): Promise<Readonly<{ localId: string; accepted: boolean }>> {
    const { sessionId, text, displayText, encryption, request, metaOverrides } = params;

    storage.getState().markSessionOptimisticThinking(sessionId);

    const session = storage.getState().sessions[sessionId];
    if (!session) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error(`Session ${sessionId} not found in storage`);
    }
    const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);
    if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error(`Session ${sessionId} not found`);
    }

    const permissionMode = session.permissionMode || 'default';
    const flavor = session.metadata?.flavor;
    const agentId = resolveAgentIdFromFlavor(flavor);
    const modelMode = session.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');
    const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;
    const localId = randomUUID();
    const rawRecord: RawRecord = {
        role: 'user',
        content: { type: 'text', text },
        meta: buildSendMessageMeta({
            sentFrom: resolveSentFrom(),
            permissionMode: permissionMode || 'default',
            model,
            displayText,
            agentId,
            settings: storage.getState().settings,
            session,
            metaOverrides: metaOverrides as any,
        }),
    };

    const createdAt = nowServerMs();
    const updatedAt = createdAt;

    storage.getState().upsertPendingMessage(sessionId, {
        id: localId,
        localId,
        createdAt,
        updatedAt,
        source: 'local_outbound',
        deliveryStatus: 'queued',
        text,
        displayText,
        rawRecord,
    });
    params.onLocalPendingProjectionCreated?.({ localId });

    try {
        const outcome = await runPendingEnqueueCommitInOrder(sessionId, async () => {
            if (isPendingLocalIdDeleted(sessionId, localId)) {
                return { committed: false };
            }

            let writeBody: Record<string, unknown>;
            if (sessionEncryptionMode === 'plain') {
                writeBody = { localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' };
            } else {
                const ciphertext = await sessionEncryption!.encryptRawRecord(rawRecord);
                writeBody = { localId, ciphertext, messageRole: 'user' };
            }

            const response = await request(`/v2/sessions/${sessionId}/pending`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(writeBody),
            });
            if (!response.ok) {
                assertPendingResponseOk(response, 'Failed to enqueue pending message');
            }
            return { committed: true };
        });

        if (isPendingLocalIdDeleted(sessionId, localId)) {
            if (outcome.committed) {
                await deleteAcceptedTombstonedPendingMessage({ sessionId, localId, request });
            } else {
                clearDeletedPendingLocalId(sessionId, localId);
            }
            return { localId, accepted: true };
        }

        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt,
            updatedAt: nowServerMs(),
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            text,
            displayText,
            rawRecord,
        });
        return { localId, accepted: true };
    } catch (e) {
        if (isTransientConnectivityError(e)) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { localId, accepted: false };
        }
        storage.getState().removePendingMessage(sessionId, localId);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw e;
    }
}

export async function retryPendingMessageEnqueueV2(params: {
    sessionId: string;
    localId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<Readonly<{ accepted: boolean }>> {
    const { sessionId, localId, encryption, request } = params;
    const existing = storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
        message.localId === localId || message.id === localId
    );
    if (!existing || existing.deliveryStatus === 'accepted') {
        return { accepted: true };
    }
    const parsed = RawRecordSchema.safeParse(existing.rawRecord);
    if (!parsed.success || parsed.data.role !== 'user') {
        storage.getState().removePendingMessage(sessionId, existing.id);
        return { accepted: true };
    }

    const session = storage.getState().sessions[sessionId];
    if (!session) {
        storage.getState().removePendingMessage(sessionId, existing.id);
        return { accepted: true };
    }
    const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);
    if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        return { accepted: false };
    }

    try {
        const outcome = await runPendingEnqueueCommitInOrder(sessionId, async () => {
            if (isPendingLocalIdDeleted(sessionId, existing.localId ?? existing.id)) {
                return { committed: false };
            }

            const writeBody =
                sessionEncryptionMode === 'plain'
                    ? { localId: existing.localId ?? existing.id, content: { t: 'plain' as const, v: parsed.data }, messageRole: 'user' }
                    : { localId: existing.localId ?? existing.id, ciphertext: await sessionEncryption!.encryptRawRecord(parsed.data), messageRole: 'user' };

            const response = await request(`/v2/sessions/${sessionId}/pending`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(writeBody),
            });
            if (!response.ok) {
                assertPendingResponseOk(response, 'Failed to enqueue pending message');
            }
            return { committed: true };
        });

        const localId = existing.localId ?? existing.id;
        if (isPendingLocalIdDeleted(sessionId, localId)) {
            if (outcome.committed) {
                await deleteAcceptedTombstonedPendingMessage({ sessionId, localId, request });
            } else {
                clearDeletedPendingLocalId(sessionId, localId);
            }
            return { accepted: true };
        }

        storage.getState().upsertPendingMessage(sessionId, {
            ...existing,
            updatedAt: nowServerMs(),
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            rawRecord: parsed.data,
        });
        storage.getState().markSessionOptimisticThinking(sessionId);
        return { accepted: true };
    } catch (e) {
        if (isTransientConnectivityError(e)) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            return { accepted: false };
        }
        storage.getState().removePendingMessage(sessionId, existing.id);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw e;
    }
}

export async function updatePendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    text: string;
    encryption: Encryption;
    fetchArtifactWithBody?: (artifactId: string) => Promise<DecryptedArtifact | null>;
    updateArtifact?: (artifact: DecryptedArtifact) => void;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, text, encryption, request } = params;

    const session = storage.getState().sessions[sessionId] ?? null;
    const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const sessionEncryption = sessionEncryptionMode === 'plain' ? null : encryption.getSessionEncryption(sessionId);
    if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const existing = storage.getState().sessionPending[sessionId]?.messages?.find((m) => m.id === pendingId);
    if (!existing) {
        throw new Error('Pending message not found');
    }

    const rawRecord: RawRecord = (() => {
        if (existing.rawRecord) {
            const parsed = RawRecordSchema.safeParse(existing.rawRecord);
            if (parsed.success && parsed.data.role === 'user' && parsed.data.content.type === 'text') {
                const record = parsed.data;
                const existingMeta = isPlainObject(record.meta) ? record.meta : {};
                const { appendSystemPrompt: _appendSystemPrompt, ...nextMeta } = existingMeta;
                return {
                    ...record,
                    content: { type: 'text', text },
                    meta: nextMeta,
                };
            }
        }

        const session = storage.getState().sessions[sessionId] ?? null;
        const permissionMode = session?.permissionMode || 'default';
        const flavor = session?.metadata?.flavor;
        const agentId = resolveAgentIdFromFlavor(flavor);
        const modelMode = session?.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');
        const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;

	        return {
	            role: 'user',
	            content: { type: 'text', text },
	            meta: buildSendMessageMeta({
	                sentFrom: resolveSentFrom(),
	                permissionMode: permissionMode || 'default',
	                model,
	                displayText:
	                    existing.pendingDecryptFailure
	                        ? undefined
	                        : (typeof existing.displayText === 'string' ? existing.displayText : undefined),
	                agentId,
	                settings: storage.getState().settings,
	                session,
	            }),
	        };
	    })();

    const writeBody =
        sessionEncryptionMode === 'plain'
            ? { content: { t: 'plain', v: rawRecord }, messageRole: 'user' }
            : { ciphertext: await sessionEncryption!.encryptRawRecord(rawRecord), messageRole: 'user' };
    const updatedAt = nowServerMs();

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(writeBody),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to update pending message');
    }

	    storage.getState().upsertPendingMessage(sessionId, {
	        ...existing,
	        pendingDecryptFailure: undefined,
	        text,
	        updatedAt,
	        rawRecord,
	        displayText: existing.pendingDecryptFailure ? undefined : existing.displayText,
	    });
	}

export async function deletePendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, request } = params;
    const existing = storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
        message.id === pendingId || message.localId === pendingId
    );
    if (existing?.source === 'local_outbound' && existing.deliveryStatus === 'queued') {
        markPendingLocalIdDeleted(sessionId, existing.localId ?? existing.id);
        storage.getState().removePendingMessage(sessionId, existing.id);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        return;
    }

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}`, { method: 'DELETE' });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to delete pending message');
    }
    storage.getState().removePendingMessage(sessionId, pendingId);
}

export async function discardPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    reason?: 'switch_to_local' | 'manual';
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, reason, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to discard pending message');
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}

export async function retryPendingDeliveryV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}/delivery/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to retry pending delivery');
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}

export async function markPendingDeliveryHandledV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}/delivery/handled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to mark pending delivery handled');
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}

export async function restoreDiscardedPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}/restore`, { method: 'POST' });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to restore discarded message');
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}

export async function deleteDiscardedPendingMessageV2(params: {
    sessionId: string;
    pendingId: string;
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, pendingId, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/${pendingId}`, { method: 'DELETE' });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to delete discarded message');
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}

export async function reorderPendingMessagesV2(params: {
    sessionId: string;
    orderedLocalIds: string[];
    encryption: Encryption;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const { sessionId, orderedLocalIds, encryption, request } = params;

    const response = await request(`/v2/sessions/${sessionId}/pending/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedLocalIds }),
    });
    if (!response.ok) {
        assertPendingResponseOk(response, 'Failed to reorder pending messages');
    }
    await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
}
