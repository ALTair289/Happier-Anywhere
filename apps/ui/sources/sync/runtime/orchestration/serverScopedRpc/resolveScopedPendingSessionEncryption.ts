import type { RawRecord } from '@/sync/typesRaw';

import { resolveScopedSessionDataKey } from './resolveScopedSessionDataKey';
import type { ResolvedServerSessionRpcContext } from './resolveServerScopedSessionContext';

export type ScopedPendingSessionEncryption = Readonly<{
    encryptRawRecord: (record: RawRecord) => Promise<string>;
    decryptRaw: (payload: string) => Promise<unknown>;
}>;

/** Resolves the session crypto owned by an already-frozen server/account context. */
export async function resolveScopedPendingSessionEncryption(params: Readonly<{
    context: Extract<ResolvedServerSessionRpcContext, { scope: 'scoped' }>;
    sessionId: string;
}>): Promise<ScopedPendingSessionEncryption> {
    const sessionDataKey = await resolveScopedSessionDataKey({
        serverId: params.context.targetServerId,
        serverUrl: params.context.targetServerUrl,
        token: params.context.token,
        sessionId: params.sessionId,
        timeoutMs: params.context.timeoutMs,
        decryptEncryptionKey: (value) => params.context.encryption.decryptEncryptionKey(value),
    });

    await params.context.encryption.initializeSessions(new Map([[params.sessionId, sessionDataKey]]));
    const sessionEncryption = params.context.encryption.getSessionEncryption(params.sessionId);
    if (!sessionEncryption) {
        throw new Error(`Session encryption not found for ${params.sessionId}`);
    }
    return {
        encryptRawRecord: (record) => sessionEncryption.encryptRaw(record),
        decryptRaw: (payload) => sessionEncryption.decryptRaw(payload),
    };
}
