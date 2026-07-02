import type { Socket } from "socket.io";

import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { getSessionParticipantUserIds } from "@/app/share/sessionParticipants";
import { db } from "@/storage/db";

import { resolveSessionScopedMachinePublishBinding } from "./sessionScopedBinding";

/**
 * TTL cache for session relay publish authorization.
 *
 * High-rate ephemeral relays (`transcript-stream-segment{,-delta}`, `execution-run-updated`) arrive
 * at up to 25Hz per session. The facts they must verify (machine access key exists, sender owns the
 * session with edit access, participant fan-out list) were already proven at socket handshake and
 * change rarely, so re-proving them with 3 DB round-trips per event is pure overhead.
 *
 * Positive resolutions are cached per (userId, sessionId, machineId) binding for a short TTL
 * (mirroring `activityCache` in `@/app/presence/sessionCache`). Negative resolutions are never
 * cached. Server-owned write paths that change these facts invalidate eagerly:
 * - session share create/update/revoke (`shareRoutes.ts`) → `invalidateSessionRelayAuthorizationForSession`
 * - machine revoke deleting its access keys (`machinesRoutes.ts`) → `invalidateSessionRelayAuthorizationForMachine`
 * - session delete (`deleteOwnedSession.ts`) → `invalidateSessionRelayAuthorizationForSession`
 *
 * In multi-process deployments the eager invalidation is process-local; the TTL bounds staleness to
 * `SESSION_RELAY_AUTH_CACHE_TTL_MS`, the same guarantee `activityCache` already provides for
 * `session-alive`. Relay authorization is only cached for sockets whose handshake proof succeeded.
 */
export const SESSION_RELAY_AUTH_CACHE_TTL_MS = 30_000;

type SessionRelayAuthCacheEntry = Readonly<{
    validUntil: number;
    sessionId: string;
    machineId: string;
    participantUserIds: readonly string[];
}>;

const relayAuthCache = new Map<string, SessionRelayAuthCacheEntry>();

function createRelayAuthCacheKey(userId: string, sessionId: string, machineId: string): string {
    return `${userId}\u0000${sessionId}\u0000${machineId}`;
}

function pruneExpiredRelayAuthEntries(nowMs: number): void {
    for (const [key, entry] of relayAuthCache) {
        if (entry.validUntil <= nowMs) {
            relayAuthCache.delete(key);
        }
    }
}

/**
 * Authorize a session-scoped socket to publish relay events for `sessionId` and resolve the
 * participant user ids to fan out to. Returns `null` when publishing is not allowed.
 *
 * The in-memory binding proof is checked on every call; the DB-backed facts (access key presence,
 * owner+edit access, participant list) are resolved once per TTL window per binding.
 */
export async function authorizeSessionRelayPublish(params: Readonly<{
    socket: Socket;
    connection: ClientConnection;
    userId: string;
    sessionId: string;
}>): Promise<readonly string[] | null> {
    const binding = resolveSessionScopedMachinePublishBinding({
        socket: params.socket,
        connection: params.connection,
        sessionId: params.sessionId,
    });
    if (!binding) {
        return null;
    }

    const cacheKey = createRelayAuthCacheKey(params.userId, binding.sessionId, binding.machineId);
    const nowMs = Date.now();
    const cached = relayAuthCache.get(cacheKey);
    if (cached && cached.validUntil > nowMs) {
        return cached.participantUserIds;
    }
    pruneExpiredRelayAuthEntries(nowMs);

    const accessKey = await db.accessKey.findUnique({
        where: {
            accountId_machineId_sessionId: {
                accountId: params.userId,
                machineId: binding.machineId,
                sessionId: binding.sessionId,
            },
        },
        select: { machineId: true },
    });
    if (!accessKey) {
        return null;
    }

    const access = await checkSessionAccess(params.userId, binding.sessionId);
    if (!access || !requireAccessLevel(access, "edit") || !access.isOwner) {
        return null;
    }

    const participantUserIds = await getSessionParticipantUserIds({ sessionId: binding.sessionId });
    if (participantUserIds.length === 0) {
        return null;
    }

    relayAuthCache.set(cacheKey, {
        validUntil: nowMs + SESSION_RELAY_AUTH_CACHE_TTL_MS,
        sessionId: binding.sessionId,
        machineId: binding.machineId,
        participantUserIds,
    });
    return participantUserIds;
}

/** Drop cached relay authorizations for a session (share change, session delete). */
export function invalidateSessionRelayAuthorizationForSession(sessionId: string): void {
    for (const [key, entry] of relayAuthCache) {
        if (entry.sessionId === sessionId) {
            relayAuthCache.delete(key);
        }
    }
}

/** Drop cached relay authorizations for a machine (machine revoke deletes its access keys). */
export function invalidateSessionRelayAuthorizationForMachine(machineId: string): void {
    for (const [key, entry] of relayAuthCache) {
        if (entry.machineId === machineId) {
            relayAuthCache.delete(key);
        }
    }
}

/** Reset all cached relay authorizations (tests, shutdown). */
export function clearSessionRelayAuthorizationCache(): void {
    relayAuthCache.clear();
}
