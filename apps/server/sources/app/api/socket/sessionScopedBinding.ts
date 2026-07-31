import type { Socket } from "socket.io";

import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { classifyCurrentMachineSocketRecord } from "@/app/machines/validateCurrentMachineSocket";
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

export type SessionScopedBindingProof = "owner-session" | "machine-access-key";

export type SessionScopedSocketBinding = Readonly<{
    sessionId: string;
    machineId: string | null;
    proof: SessionScopedBindingProof;
}>;

export async function hasCurrentSessionScopedMachineAccessInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
    sessionId: string;
}>): Promise<boolean> {
    const accessKey = await params.tx.accessKey.findUnique({
        where: {
            accountId_machineId_sessionId: {
                accountId: params.accountId,
                machineId: params.machineId,
                sessionId: params.sessionId,
            },
        },
        select: {
            machine: {
                select: { revokedAt: true, replacedByMachineId: true },
            },
            session: {
                select: { accountId: true },
            },
        },
    });
    return accessKey !== null
        && accessKey.session.accountId === params.accountId
        && classifyCurrentMachineSocketRecord(accessKey.machine).ok;
}

export async function hasCurrentSessionScopedMachineAccess(params: Readonly<{
    accountId: string;
    machineId: string;
    sessionId: string;
}>): Promise<boolean> {
    return await hasCurrentSessionScopedMachineAccessInTx({ tx: db, ...params });
}

type SessionScopedBindingResolution =
    | Readonly<{ ok: true; binding: SessionScopedSocketBinding }>
    | Readonly<{ ok: false; statusCode: number; error: "invalid-session" | "invalid-session-access-key" }>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export async function resolveSessionScopedSocketBinding(params: Readonly<{
    userId: string;
    sessionId: string;
    machineId?: string | null;
}>): Promise<SessionScopedBindingResolution> {
    const sessionId = normalizeNonEmptyString(params.sessionId);
    const machineId = normalizeNonEmptyString(params.machineId);
    if (!sessionId) {
        return { ok: false, statusCode: 403, error: "invalid-session" };
    }

    const session = await db.session.findUnique({
        where: { id: sessionId },
        select: { accountId: true },
    });
    if (!session || session.accountId !== params.userId) {
        return { ok: false, statusCode: 403, error: "invalid-session" };
    }

    if (!machineId) {
        return {
            ok: true,
            binding: {
                sessionId,
                machineId: null,
                proof: "owner-session",
            },
        };
    }

    if (!await hasCurrentSessionScopedMachineAccess({
        accountId: params.userId,
        machineId,
        sessionId,
    })) {
        return { ok: false, statusCode: 403, error: "invalid-session-access-key" };
    }

    return {
        ok: true,
        binding: {
            sessionId,
            machineId,
            proof: "machine-access-key",
        },
    };
}

export function readSessionScopedSocketBinding(socket: Socket): SessionScopedSocketBinding | null {
    const binding = (socket.data as { sessionScopedBinding?: unknown } | undefined)?.sessionScopedBinding;
    if (!binding || typeof binding !== "object") return null;
    const candidate = binding as Record<string, unknown>;
    const sessionId = normalizeNonEmptyString(candidate.sessionId);
    const proof = candidate.proof === "machine-access-key" || candidate.proof === "owner-session"
        ? candidate.proof
        : null;
    const machineId = normalizeNonEmptyString(candidate.machineId);
    if (!sessionId || !proof) return null;
    if (proof === "machine-access-key" && !machineId) return null;
    return {
        sessionId,
        machineId,
        proof,
    };
}

export function canRegisterSessionScopedRpcMethod(params: Readonly<{
    socket: Socket;
    method: string;
}>): boolean {
    const clientType = (params.socket.data as { clientType?: unknown } | undefined)?.clientType;
    if (clientType !== "session-scoped") {
        return true;
    }

    const binding = readSessionScopedSocketBinding(params.socket);
    if (!binding || binding.proof !== "machine-access-key") {
        return false;
    }

    const lastColon = params.method.lastIndexOf(":");
    if (lastColon <= 0) {
        return false;
    }
    return params.method.slice(0, lastColon) === binding.sessionId;
}

/**
 * Resolve the machine-bound session binding a session-scoped socket must present before publishing
 * relay events (transcript stream segments, execution-run updates) for a session.
 *
 * This is the synchronous (in-memory) half of publish authorization: it proves the socket handshake
 * bound this exact session through a machine access key. The access key's continued existence and
 * the sender's session access are re-verified by the TTL cache in `sessionRelayAuthCache.ts`.
 */
export function resolveSessionScopedMachinePublishBinding(params: Readonly<{
    socket: Socket;
    connection: ClientConnection;
    sessionId: string;
}>): Readonly<{ sessionId: string; machineId: string }> | null {
    if (params.connection.connectionType !== "session-scoped") {
        return null;
    }

    const binding = readSessionScopedSocketBinding(params.socket);
    if (!binding || binding.sessionId !== params.sessionId) {
        return null;
    }
    if (binding.proof !== "machine-access-key" || !binding.machineId) {
        return null;
    }
    return { sessionId: binding.sessionId, machineId: binding.machineId };
}
