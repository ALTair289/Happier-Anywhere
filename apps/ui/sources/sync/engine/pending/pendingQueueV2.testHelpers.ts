import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { RawRecord } from '@/sync/typesRaw';

const initialStorageState = storage.getState();

type PendingQueueTestRequest = (path: string, init?: RequestInit) => Promise<Response>;

export function withExactPendingEnqueueAckIdentityForTest(
    request: PendingQueueTestRequest,
): PendingQueueTestRequest {
    return async (path, init) => {
        const response = await request(path, init);
        if (init?.method !== 'POST' || !response.ok) return response;
        if (Object.prototype.hasOwnProperty.call(response, 'json')) return response;

        let requestBody: unknown;
        let responsePayload: unknown;
        try {
            requestBody = JSON.parse(String(init.body ?? '{}')) as unknown;
            responsePayload = await response.clone().json() as unknown;
        } catch {
            return response;
        }
        if (
            !requestBody
            || typeof requestBody !== 'object'
            || Array.isArray(requestBody)
            || !responsePayload
            || typeof responsePayload !== 'object'
            || Array.isArray(responsePayload)
        ) return response;

        const requestRecord = requestBody as Record<string, unknown>;
        const responseRecord = responsePayload as Record<string, unknown>;
        if (responseRecord.terminal === true || !responseRecord.requestedAction) return response;
        const pending = responseRecord.pending && typeof responseRecord.pending === 'object' && !Array.isArray(responseRecord.pending)
            ? responseRecord.pending as Record<string, unknown>
            : {};
        if ('localId' in pending) return response;

        return new Response(JSON.stringify({
            ...responseRecord,
            pending: { ...pending, localId: requestRecord.localId },
        }), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
}

export function resetPendingQueueState(): void {
    storage.setState(initialStorageState, true);
}

export async function createPendingQueueEncryption(params: {
    sessionId: string;
    seedByte?: number;
}): Promise<Encryption> {
    const encryption = await Encryption.create(new Uint8Array(32).fill(params.seedByte ?? 3));
    await encryption.initializeSessions(new Map([[params.sessionId, null]]));
    return encryption;
}

export function getSessionEncryptionOrThrow(params: {
    encryption: Encryption;
    sessionId: string;
}): NonNullable<ReturnType<Encryption['getSessionEncryption']>> {
    const sessionEncryption = params.encryption.getSessionEncryption(params.sessionId);
    if (!sessionEncryption) {
        throw new Error(`missing session encryption for ${params.sessionId}`);
    }
    return sessionEncryption;
}

export function buildSession(params: {
    sessionId: string;
    overrides?: Partial<Session>;
}): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        ...(params.overrides ?? {}),
    };
}

export async function encryptRawRecordForPending(params: {
    encryption: Encryption;
    sessionId: string;
    rawRecord: RawRecord;
}): Promise<string> {
    const sessionEncryption = getSessionEncryptionOrThrow({
        encryption: params.encryption,
        sessionId: params.sessionId,
    });
    return sessionEncryption.encryptRawRecord(params.rawRecord);
}
