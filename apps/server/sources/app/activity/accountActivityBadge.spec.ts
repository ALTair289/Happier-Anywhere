import { describe, expect, it } from "vitest";

import { computeSessionContributesToActivityBadge } from "./accountActivityBadge";

describe("computeSessionContributesToActivityBadge", () => {
    it("does not count provider runtime activity as user attention", () => {
        const sessionWithRuntimeActivity = {
            seq: 0,
            pendingCount: 0,
            pendingBlockedCount: 0,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: "completed",
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityExpiresAt: 2_000,
            runtimeActivitySourceClass: "provider_detached_task",
        };

        expect(computeSessionContributesToActivityBadge(sessionWithRuntimeActivity)).toBe(false);
    });

    it("still counts pending user-attention work independently from runtime activity", () => {
        const sessionWithBlockedPending = {
            seq: 0,
            pendingCount: 1,
            pendingBlockedCount: 1,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: "completed",
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityExpiresAt: 2_000,
            runtimeActivitySourceClass: "provider_detached_task",
        };

        expect(computeSessionContributesToActivityBadge(sessionWithBlockedPending)).toBe(true);
    });
});
