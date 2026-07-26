import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";
import { acquireTrustedPendingPublisherAuthority } from "./pendingPublisherAuthority";

describe("pending publisher authority", () => {
    it("fails closed when replacement changes the Session row after validation but before the commit-time CAS", async () => {
        const committedFence = new Date("2026-07-19T10:00:00.000Z");
        const updatedAt = new Date("2026-07-19T10:00:01.000Z");
        const sessionUpdate = vi.fn(async () => {
            throw Object.assign(new Error("record to update not found"), { code: "P2025" });
        });
        const tx = {
            accessKey: {
                findUnique: vi.fn(async () => ({
                    machine: { revokedAt: null, replacedByMachineId: null },
                    session: { accountId: "account-1" },
                })),
            },
            session: {
                findUnique: vi.fn(async () => ({
                    accountId: "account-1",
                    active: true,
                    archivedAt: null,
                    lastActiveAt: committedFence,
                    updatedAt,
                })),
                update: sessionUpdate,
            },
        } as unknown as Tx; // Database-boundary fixture; production Pending logic remains real.

        await expect(acquireTrustedPendingPublisherAuthority({
            tx,
            actorUserId: "account-1",
            sessionId: "session-1",
            fence: {
                accountId: "account-1",
                machineId: "machine-1",
                sessionId: "session-1",
                committedFence,
            },
        })).resolves.toBe(false);
        expect(sessionUpdate).toHaveBeenCalledWith({
            where: {
                id: "session-1",
                accountId: "account-1",
                active: true,
                archivedAt: null,
                lastActiveAt: committedFence,
                updatedAt,
            },
            data: { lastActiveAt: committedFence, updatedAt },
            select: { id: true },
        });
    });
});
