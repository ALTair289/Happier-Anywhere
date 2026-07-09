import axios from 'axios';
import type { Socket } from 'socket.io-client';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    normalizePendingDeliveryStatusV1,
    parsePendingDeliveryStatusV1,
    SessionMessageRoleSchema,
    type PendingDeliveryBlockedReason,
    type PendingDeliveryStatusV1,
    type SessionPendingQueueDeliveryTiming,
    type SessionMessageRole,
} from '@happier-dev/protocol';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';

export type PendingMaterializationDeliveryState = Readonly<{
    mode: 'provider';
    unresolved: boolean;
}>;

export type PendingQueueMaterializedMessage = {
    id: string | null;
    seq: number | null;
    localId: string | null;
    messageRole: SessionMessageRole | null;
    content: SessionMessageContent | null;
    createdAt: number | null;
    updatedAt: number | null;
    deliveryState?: PendingMaterializationDeliveryState | null;
    deliveryStateMalformed?: boolean;
};

export type PendingQueueMaterializeNextResult = {
    didMaterialize: boolean;
    localId: string | null;
    didWrite: boolean;
    message?: PendingQueueMaterializedMessage | null;
    pendingQueueState?: KnownPendingQueueState;
    deferredReason?: PendingQueueMaterializeDeferredReason;
};

export type PendingQueueMaterializeDeferredReason = 'runtime_activity_active';

type PendingQueueWriteBody = Readonly<
    | { localId: string; ciphertext: string; messageRole?: SessionMessageRole }
    | { localId: string; content: { t: 'plain'; v: unknown }; messageRole?: SessionMessageRole }
>;

type PendingQueueSocketMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; message: PendingQueueMaterializedMessage | null; pendingQueueState?: KnownPendingQueueState }
    | { ok: true; didMaterialize: false; pendingQueueState?: KnownPendingQueueState; deferredReason?: PendingQueueMaterializeDeferredReason }
    | { ok: false };

type PendingQueueHttpMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; message: PendingQueueMaterializedMessage | null; pendingQueueState?: KnownPendingQueueState }
    | { ok: true; didMaterialize: false; pendingQueueState?: KnownPendingQueueState; deferredReason?: PendingQueueMaterializeDeferredReason };

type PendingMaterializeAckSocket = Parameters<typeof emitSocketWithAck>[0]['socket'];

type PendingMaterializePayload = Readonly<{
    sid: string;
    pendingVersion?: number;
    deliveryState?: 'provider';
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
}>;

export type PendingQueueDeliveryBlockedReason = PendingDeliveryBlockedReason;

export type PendingQueueBlockedDelivery = Readonly<{
    localId: string;
    reason: PendingQueueDeliveryBlockedReason;
}>;

function readResolvedLocalIds(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const rawLocalIds = (value as Record<string, unknown>).resolvedLocalIds;
    if (!Array.isArray(rawLocalIds)) return [];
    const resolvedLocalIds: string[] = [];
    for (const rawLocalId of rawLocalIds) {
        const localId = typeof rawLocalId === 'string' ? rawLocalId.trim() : '';
        if (!localId || resolvedLocalIds.includes(localId)) continue;
        resolvedLocalIds.push(localId);
    }
    return resolvedLocalIds;
}

function readPendingMaterializePayload(payload: unknown): PendingMaterializePayload {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid pending queue materialize payload');
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.sid !== 'string') {
        throw new Error('Invalid pending queue materialize session id');
    }
    const pendingVersion = record.pendingVersion;
    return {
        sid: record.sid,
        ...(typeof pendingVersion === 'number' && Number.isSafeInteger(pendingVersion) && pendingVersion >= 0
            ? { pendingVersion }
            : {}),
        ...(record.deliveryState === 'provider' ? { deliveryState: 'provider' } : {}),
        ...(record.deliveryTiming === 'after_foreground_ready' || record.deliveryTiming === 'after_runtime_idle'
            ? { deliveryTiming: record.deliveryTiming }
            : {}),
    };
}

function readPendingMaterializeDeferredReason(value: unknown): PendingQueueMaterializeDeferredReason | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const reason = (value as { deferredReason?: unknown }).deferredReason;
    return reason === 'runtime_activity_active' ? reason : undefined;
}

function readPendingRowDeliveryStatus(record: Record<string, unknown>): PendingDeliveryStatusV1 {
    return parsePendingDeliveryStatusV1(record.deliveryStatus) ?? normalizePendingDeliveryStatusV1({
        status: record.status,
        deliveryState: record.deliveryState,
        deliveryBlockedReason: record.deliveryBlockedReason,
        discardedReason: record.discardedReason,
    });
}

function buildPendingMaterializeBody(params: {
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
}): Record<string, unknown> {
    return {
        ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
        ...(params.deliveryTiming === 'after_foreground_ready' || params.deliveryTiming === 'after_runtime_idle'
            ? { deliveryTiming: params.deliveryTiming }
            : {}),
    };
}

function createPendingMaterializeAckSocket(socket: Socket<ServerToClientEvents, ClientToServerEvents>): PendingMaterializeAckSocket {
    const build = (target: Socket<ServerToClientEvents, ClientToServerEvents>): PendingMaterializeAckSocket => ({
        connected: target.connected,
        emitWithAck: async (event, payload) => {
            if (event !== 'pending-materialize-next') {
                throw new Error(`Unexpected pending queue socket ACK event: ${event}`);
            }
            return await target.emitWithAck('pending-materialize-next', readPendingMaterializePayload(payload));
        },
        timeout: (ms) => build(target.timeout(ms)),
    });
    return build(socket);
}

function parseMaterializedMessageTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    return null;
}

function parseDeliveryState(value: unknown): {
    deliveryState: PendingMaterializationDeliveryState | null;
    malformed: boolean;
} {
    if (value === null || value === undefined) {
        return { deliveryState: null, malformed: false };
    }
    if (!value || typeof value !== 'object') {
        return { deliveryState: null, malformed: true };
    }
    const record = value as Record<string, unknown>;
    if (record.mode !== 'provider' || typeof record.unresolved !== 'boolean') {
        return { deliveryState: null, malformed: true };
    }
    return {
        deliveryState: {
            mode: 'provider',
            unresolved: record.unresolved,
        },
        malformed: false,
    };
}

function parseMaterializedMessage(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : null;
    const seq = typeof record.seq === 'number' && Number.isSafeInteger(record.seq) && record.seq >= 0
        ? record.seq
        : record.seq === null
            ? null
            : null;
    const localId = typeof record.localId === 'string' && record.localId.length > 0
        ? record.localId
        : null;
    const parsedRole = SessionMessageRoleSchema.nullable().safeParse(record.messageRole ?? null);
    const parsedContent = SessionMessageContentSchema.safeParse(record.content);
    const deliveryState = parseDeliveryState(record.deliveryState);
    return {
        id,
        seq,
        localId,
        messageRole: parsedRole.success ? parsedRole.data : null,
        content: parsedContent.success ? parsedContent.data : null,
        createdAt: parseMaterializedMessageTimestamp(record.createdAt),
        updatedAt: parseMaterializedMessageTimestamp(record.updatedAt),
        deliveryState: deliveryState.deliveryState,
        ...(deliveryState.malformed ? { deliveryStateMalformed: true } : {}),
    };
}

function readMaterializedMessageFromAck(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const parsedMessage = parseMaterializedMessage(record.message);
    const topLevelDeliveryState = parseDeliveryState(record.deliveryState);
    if (parsedMessage) {
        return {
            ...parsedMessage,
            deliveryState: parsedMessage.deliveryState ?? topLevelDeliveryState.deliveryState,
            ...(parsedMessage.deliveryStateMalformed || topLevelDeliveryState.malformed
                ? { deliveryStateMalformed: true }
                : {}),
        };
    }
    return parseMaterializedMessage(record);
}

function readMaterializedLocalIdFromAck(value: unknown, message: PendingQueueMaterializedMessage | null): string | null {
    if (message?.localId) return message.localId;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.localId === 'string' && record.localId.length > 0) return record.localId;
    const nested = record.message;
    if (!nested || typeof nested !== 'object') return null;
    const nestedLocalId = (nested as Record<string, unknown>).localId;
    return typeof nestedLocalId === 'string' && nestedLocalId.length > 0 ? nestedLocalId : null;
}

function readRawMaterializedMessageRecordFromAck(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const nested = record.message;
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
    return record;
}

class PendingProviderDeliveryMaterializationContractError extends Error {
    constructor() {
        super('Invalid pending provider delivery materialize response');
        this.name = 'PendingProviderDeliveryMaterializationContractError';
    }
}

function assertProviderDeliveryMaterialization(params: {
    didWrite: boolean;
    didWriteExplicitFalse: boolean;
    message: PendingQueueMaterializedMessage | null;
    localId: string | null;
    rawMessageRecord: Record<string, unknown> | null;
}): void {
    const message = params.message;
    const localId = message?.localId && message.localId.length > 0
        ? message.localId
        : params.localId;
    const rawMessageId = params.rawMessageRecord?.id;
    const hasValidEnvelope =
        !!message
        && params.rawMessageRecord !== null
        && typeof localId === 'string'
        && localId.length > 0
        && message.deliveryStateMalformed !== true
        && (rawMessageId === null || typeof rawMessageId === 'string');
    const isLegacyProviderClaim =
        hasValidEnvelope
        && params.didWrite === false
        && params.didWriteExplicitFalse === true
        && message.seq === null
        && params.rawMessageRecord?.seq === null;
    const isRowFirstProviderDelivery =
        hasValidEnvelope
        && params.didWrite === true
        && typeof message.id === 'string'
        && message.id.length > 0
        && typeof message.seq === 'number'
        && typeof rawMessageId === 'string'
        && rawMessageId.length > 0
        && typeof params.rawMessageRecord?.seq === 'number'
        && Number.isSafeInteger(params.rawMessageRecord.seq)
        && params.rawMessageRecord.seq >= 0
        && message.deliveryState?.mode === 'provider'
        && message.deliveryState.unresolved === true;
    if (!isLegacyProviderClaim && !isRowFirstProviderDelivery) {
        throw new PendingProviderDeliveryMaterializationContractError();
    }

    if (!message.deliveryState) return;
}

export async function listPendingQueueV2LocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    try {
        const serverUrl = resolveServerHttpBaseUrl();
        const response = await axios.get(`${serverUrl}/v2/sessions/${params.sessionId}/pending`, {
            headers: { Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        return pending
            .map((row: unknown) => {
                if (!row || typeof row !== 'object') return null;
                const localId = (row as Record<string, unknown>).localId;
                return typeof localId === 'string' ? localId : null;
            })
            .filter((value: string | null): value is string => typeof value === 'string' && value.length > 0);
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        throw error;
    }
}

export async function listPendingQueueV2ProviderDeliveryLocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    try {
        const serverUrl = resolveServerHttpBaseUrl();
        const response = await axios.get(`${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`, {
            headers: { Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        const seen = new Set<string>();
        const localIds: string[] = [];
        for (const row of pending) {
            if (!row || typeof row !== 'object') continue;
            const record = row as Record<string, unknown>;
            const localId = record.localId;
            const deliveryStatus = readPendingRowDeliveryStatus(record);
            if (
                typeof localId !== 'string'
                || localId.length === 0
                || seen.has(localId)
                || deliveryStatus.status !== 'delivering'
            ) {
                continue;
            }
            seen.add(localId);
            localIds.push(localId);
        }
        return localIds;
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        throw error;
    }
}

export async function readBlockedPendingQueueV2DeliveryByLocalIdFromServer(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<PendingQueueBlockedDelivery | null> {
    try {
        const serverUrl = resolveServerHttpBaseUrl();
        const response = await axios.get(`${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`, {
            headers: { Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        for (const row of pending) {
            if (!row || typeof row !== 'object') continue;
            const record = row as Record<string, unknown>;
            const localId = record.localId;
            const deliveryStatus = readPendingRowDeliveryStatus(record);
            if (
                localId !== params.localId
                || deliveryStatus.status !== 'blocked'
            ) {
                continue;
            }
            return { localId: params.localId, reason: deliveryStatus.reason };
        }
        return null;
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        throw error;
    }
}

export async function discardPendingQueueV2Messages(params: {
    token: string;
    sessionId: string;
    localIds: string[];
    reason: 'switch_to_local' | 'manual';
}): Promise<number> {
    let discarded = 0;
    const serverUrl = resolveServerHttpBaseUrl();
    for (const localId of params.localIds) {
        try {
            await axios.post(
                `${serverUrl}/v2/sessions/${params.sessionId}/pending/${encodeURIComponent(localId)}/discard`,
                { reason: params.reason },
                { headers: { Authorization: `Bearer ${params.token}` }, timeout: 10_000 },
            );
            discarded += 1;
        } catch (error) {
            if (isAuthenticationError(error)) {
                throw error;
            }
            throw error;
        }
    }
    return discarded;
}

export async function enqueuePendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    body: PendingQueueWriteBody;
}): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`,
        params.body,
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
}

export async function resolveAcceptedPendingQueueV2Delivery(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<{ pendingQueueState?: KnownPendingQueueState; message?: PendingQueueMaterializedMessage | null }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'accepted',
        body: {},
    });
}

export async function reconcileAcceptedPendingQueueV2DeliveriesThroughSeq(params: {
    token: string;
    sessionId: string;
    maxAcceptedSeq: number;
}): Promise<{ pendingQueueState?: KnownPendingQueueState; resolvedLocalIds: string[] }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/delivery/accepted-through-seq`,
        { maxAcceptedSeq: params.maxAcceptedSeq },
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid pending delivery accepted-through-seq response');
    }
    if ((data as Record<string, unknown>).ok !== true) {
        const error = (data as Record<string, unknown>).error;
        throw new Error(`Pending delivery accepted-through-seq failed: ${typeof error === 'string' ? error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    return {
        ...(pendingQueueState ? { pendingQueueState } : {}),
        resolvedLocalIds: readResolvedLocalIds(data),
    };
}

export async function blockPendingQueueV2ProviderDeliveriesOnAttach(params: {
    token: string;
    sessionId: string;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/delivery/provider-attach`,
        {},
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid pending delivery provider-attach response');
    }
    if ((data as Record<string, unknown>).ok !== true) {
        const error = (data as Record<string, unknown>).error;
        throw new Error(`Pending delivery provider-attach failed: ${typeof error === 'string' ? error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    return pendingQueueState ? { pendingQueueState } : {};
}

export async function blockPendingQueueV2Delivery(params: {
    token: string;
    sessionId: string;
    localId: string;
    reason: PendingQueueDeliveryBlockedReason;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'block',
        body: { reason: params.reason },
    });
}

export async function retryPendingQueueV2Delivery(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'retry',
        body: {},
    });
}

export async function markPendingQueueV2DeliveryHandled(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'handled',
        body: {},
    });
}

async function postPendingQueueV2DeliveryAction(params: {
    token: string;
    sessionId: string;
    localId: string;
    action: 'accepted' | 'block' | 'retry' | 'handled';
    body: Record<string, unknown>;
}): Promise<{ pendingQueueState?: KnownPendingQueueState; message?: PendingQueueMaterializedMessage | null }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/${encodeURIComponent(params.localId)}/delivery/${params.action}`,
        params.body,
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw new Error(`Invalid pending delivery ${params.action} response`);
    }
    if ((data as Record<string, unknown>).ok !== true) {
        const error = (data as Record<string, unknown>).error;
        throw new Error(`Pending delivery ${params.action} failed: ${typeof error === 'string' ? error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    const message = params.action === 'accepted'
        ? readMaterializedMessageFromAck(data)
        : null;
    return {
        ...(pendingQueueState ? { pendingQueueState } : {}),
        ...(params.action === 'accepted' ? { message } : {}),
    };
}

async function tryMaterializeNextViaSocket(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    knownPendingVersion?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const rawAck = await emitSocketWithAck<Record<string, unknown>>({
            socket: createPendingMaterializeAckSocket(params.socket),
            event: 'pending-materialize-next',
            payload: {
                sid: params.sessionId,
                ...(typeof params.knownPendingVersion === 'number' ? { pendingVersion: params.knownPendingVersion } : {}),
                ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
                ...(params.deliveryTiming === 'after_foreground_ready' || params.deliveryTiming === 'after_runtime_idle'
                    ? { deliveryTiming: params.deliveryTiming }
                    : {}),
            },
        });
        if (!rawAck || typeof rawAck !== 'object') return { ok: false };
        if (rawAck.ok !== true) return { ok: false };
        const pendingQueueState = readKnownPendingQueueState(rawAck);
        if (rawAck.didMaterialize !== true) {
            const deferredReason = readPendingMaterializeDeferredReason(rawAck);
            return {
                ok: true,
                didMaterialize: false,
                ...(pendingQueueState ? { pendingQueueState } : {}),
                ...(deferredReason ? { deferredReason } : {}),
            };
        }
        const message = readMaterializedMessageFromAck(rawAck);
        const localId = readMaterializedLocalIdFromAck(rawAck, message);
        const didWrite = rawAck.didWrite === true;
        const didWriteExplicitFalse = rawAck.didWrite === false;
        if (params.deliveryStateOptIn === true) {
            assertProviderDeliveryMaterialization({
                didWrite,
                didWriteExplicitFalse,
                message,
                localId,
                rawMessageRecord: readRawMaterializedMessageRecordFromAck(rawAck),
            });
        }
        return { ok: true, didMaterialize: true, localId, didWrite, message, ...(pendingQueueState ? { pendingQueueState } : {}) };
    } catch (error) {
        if (error instanceof PendingProviderDeliveryMaterializationContractError || isAuthenticationError(error)) {
            throw error;
        }
        return { ok: false };
    }
}

async function tryMaterializeNextViaHttp(params: {
    token: string;
    sessionId: string;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
}): Promise<PendingQueueHttpMaterializeResult> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/materialize-next`,
        buildPendingMaterializeBody(params),
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid pending queue materialize response');
    }
    if (data.ok !== true) {
        throw new Error(`Pending queue materialize failed: ${typeof data.error === 'string' ? data.error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    if (data.didMaterialize !== true) {
        const deferredReason = readPendingMaterializeDeferredReason(data);
        return {
            ok: true,
            didMaterialize: false,
            ...(pendingQueueState ? { pendingQueueState } : {}),
            ...(deferredReason ? { deferredReason } : {}),
        };
    }
    const message = readMaterializedMessageFromAck(data);
    const localId = readMaterializedLocalIdFromAck(data, message);
    const didWrite = data.didWrite === true || data.didWriteMessage === true;
    const didWriteExplicitFalse = data.didWrite === false || data.didWriteMessage === false;
    if (params.deliveryStateOptIn === true) {
        assertProviderDeliveryMaterialization({
            didWrite,
            didWriteExplicitFalse,
            message,
            localId,
            rawMessageRecord: readRawMaterializedMessageRecordFromAck(data),
        });
    }
    return {
        ok: true,
        didMaterialize: true,
        localId,
        didWrite,
        message,
        ...(pendingQueueState ? { pendingQueueState } : {}),
    };
}

export async function materializeNextPendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
}): Promise<PendingQueueMaterializeNextResult> {
    const res = await tryMaterializeNextViaHttp({
        ...params,
        deliveryStateOptIn: params.deliveryStateOptIn === true,
    });
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
            ...(res.deferredReason ? { deferredReason: res.deferredReason } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        message: res.message,
        ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
    };
}

export async function materializeNextPendingQueueV2Message(params: {
    token: string;
    sessionId: string;
    socket?: Socket<ServerToClientEvents, ClientToServerEvents> | null;
    knownPendingVersion?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
}): Promise<PendingQueueMaterializeNextResult> {
    // Strict by default: callers that want best-effort suppression must do so explicitly.
    const socketRes = params.socket?.connected === true
        ? await tryMaterializeNextViaSocket({
            socket: params.socket,
            sessionId: params.sessionId,
            knownPendingVersion: params.knownPendingVersion,
            deliveryStateOptIn: params.deliveryStateOptIn === true,
            deliveryTiming: params.deliveryTiming,
        })
        : ({ ok: false } as const);
    let res: PendingQueueSocketMaterializeResult | PendingQueueHttpMaterializeResult;
    if (socketRes.ok) {
        res = socketRes;
    } else {
        res = await tryMaterializeNextViaHttp({
            token: params.token,
            sessionId: params.sessionId,
            deliveryStateOptIn: params.deliveryStateOptIn === true,
            deliveryTiming: params.deliveryTiming,
        });
    }
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
            ...(res.deferredReason ? { deferredReason: res.deferredReason } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        message: res.message,
        ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
    };
}
