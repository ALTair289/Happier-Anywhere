import {
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';

export const SESSION_REALTIME_TRANSCRIPT_SUPPRESSION_GLOBAL_KEY = '__HAPPIER_QA_REALTIME_TRANSCRIPT_SUPPRESSION__';

export type SessionRealtimeTranscriptSuppressionEntry = Readonly<{
    sessionId: string;
    sourceServerId: string;
}>;

export type SessionRealtimeTranscriptSuppressionParams = Readonly<{
    sessionId: string;
    sourceServerId: string;
}>;

type DevTestGateOptions = Readonly<{
    isDevOrTest?: boolean;
}>;

export type SessionRealtimeTranscriptSuppressionGlobal = Readonly<{
    suppress: (params: SessionRealtimeTranscriptSuppressionParams) => boolean;
    clear: (params?: Partial<SessionRealtimeTranscriptSuppressionParams>) => number;
    isSuppressed: (params: SessionRealtimeTranscriptSuppressionParams) => boolean;
    list: () => SessionRealtimeTranscriptSuppressionEntry[];
}>;

const suppressionEntriesByKey = new Map<string, SessionRealtimeTranscriptSuppressionEntry>();

function normalizeText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeSourceServerId(value: unknown): string | null {
    const serverId = normalizeText(value);
    if (!serverId) return null;
    return resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
}

function buildSuppressionKey(sessionId: string, sourceServerScopeId: string): string {
    return `${sourceServerScopeId}\u0000${sessionId}`;
}

function resolveSuppressionIdentity(params: Readonly<{
    sessionId?: unknown;
    sourceServerId?: unknown;
}>): Readonly<{
    sessionId: string | null;
    sourceServerId: string | null;
    sourceServerScopeId: string | null;
}> {
    const sessionId = normalizeText(params.sessionId);
    const sourceServerId = normalizeText(params.sourceServerId);
    const sourceServerScopeId = normalizeSourceServerId(sourceServerId);
    return { sessionId, sourceServerId, sourceServerScopeId };
}

function readDevOrTestFlag(): boolean {
    if (typeof __DEV__ !== 'undefined' && __DEV__ === true) return true;
    return typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
}

function canMutateSuppression(options?: DevTestGateOptions): boolean {
    return options?.isDevOrTest ?? readDevOrTestFlag();
}

export function enableSessionRealtimeTranscriptSuppression(
    params: SessionRealtimeTranscriptSuppressionParams,
    options?: DevTestGateOptions,
): boolean {
    if (!canMutateSuppression(options)) return false;
    const identity = resolveSuppressionIdentity(params);
    if (!identity.sessionId || !identity.sourceServerId || !identity.sourceServerScopeId) return false;
    suppressionEntriesByKey.set(
        buildSuppressionKey(identity.sessionId, identity.sourceServerScopeId),
        {
            sessionId: identity.sessionId,
            sourceServerId: identity.sourceServerId,
        },
    );
    return true;
}

export function clearSessionRealtimeTranscriptSuppression(
    params?: Partial<SessionRealtimeTranscriptSuppressionParams>,
    options?: DevTestGateOptions,
): number {
    if (!canMutateSuppression(options)) return 0;
    if (!params) {
        const count = suppressionEntriesByKey.size;
        suppressionEntriesByKey.clear();
        return count;
    }

    const identity = resolveSuppressionIdentity(params);
    let cleared = 0;
    for (const [key, entry] of suppressionEntriesByKey.entries()) {
        if (identity.sessionId && entry.sessionId !== identity.sessionId) continue;
        if (identity.sourceServerScopeId) {
            const entryScopeId = normalizeSourceServerId(entry.sourceServerId);
            if (entryScopeId !== identity.sourceServerScopeId) continue;
        }
        suppressionEntriesByKey.delete(key);
        cleared += 1;
    }
    return cleared;
}

export function isSessionRealtimeTranscriptSuppressed(
    sessionId: string,
    sourceServerId?: string | null,
): boolean {
    const identity = resolveSuppressionIdentity({ sessionId, sourceServerId });
    if (!identity.sessionId || !identity.sourceServerScopeId) return false;
    return suppressionEntriesByKey.has(buildSuppressionKey(identity.sessionId, identity.sourceServerScopeId));
}

export function listSessionRealtimeTranscriptSuppressions(): SessionRealtimeTranscriptSuppressionEntry[] {
    return Array.from(suppressionEntriesByKey.values());
}

export function installSessionRealtimeTranscriptSuppressionGlobal(options?: DevTestGateOptions): void {
    const target = globalThis as typeof globalThis & {
        [SESSION_REALTIME_TRANSCRIPT_SUPPRESSION_GLOBAL_KEY]?: SessionRealtimeTranscriptSuppressionGlobal;
    };
    if (!canMutateSuppression(options)) {
        delete target[SESSION_REALTIME_TRANSCRIPT_SUPPRESSION_GLOBAL_KEY];
        return;
    }
    target[SESSION_REALTIME_TRANSCRIPT_SUPPRESSION_GLOBAL_KEY] = {
        suppress: (params) => enableSessionRealtimeTranscriptSuppression(params, options),
        clear: (params) => clearSessionRealtimeTranscriptSuppression(params, options),
        isSuppressed: (params) => isSessionRealtimeTranscriptSuppressed(params.sessionId, params.sourceServerId),
        list: () => listSessionRealtimeTranscriptSuppressions(),
    };
}
