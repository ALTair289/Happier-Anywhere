import { describe, expect, it } from "vitest";

import { mapPendingMessageRow } from "./mapPendingMessageRow";

function pendingRow(requestedAction: unknown) {
    return {
        localId: "pending-1",
        messageRole: "user",
        content: { t: "plain" as const, v: { role: "user", content: { type: "text", text: "hello" } } },
        requestedAction,
        status: "queued" as const,
        deliveryState: null,
        deliveryBlockedReason: null,
        position: 0,
        createdAt: new Date(1),
        updatedAt: new Date(2),
        discardedAt: null,
        discardedReason: null,
        authorAccountId: null,
    };
}

describe("mapPendingMessageRow", () => {
    it("keeps absent legacy action compatible with canonical enqueue", () => {
        expect(mapPendingMessageRow(pendingRow(null))).toMatchObject({
            requestedAction: { v: 1, kind: "enqueue" },
            deliveryStatus: { status: "queued" },
        });
    });

    it("retains an explicit malformed action as a non-executable unsupported row", () => {
        const mapped = mapPendingMessageRow(pendingRow({ v: 1, kind: "future_action" }));
        expect(mapped).toMatchObject({
            requestedActionMalformed: true,
            deliveryStatus: { status: "blocked", reason: "unsupported_action" },
        });
        expect(mapped.requestedAction).toBeUndefined();
    });
});
