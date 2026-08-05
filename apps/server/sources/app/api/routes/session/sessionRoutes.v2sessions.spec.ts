import { beforeEach, describe, expect, it } from "vitest";

import {
    encodeV2SessionListCursorV1,
    encodeV2SessionListCursorV2,
} from "@happier-dev/protocol";
import type { SessionRuntimeIssueV1 } from "@happier-dev/protocol";

import { mapV2SessionListRow } from "./v2SessionListRows";
import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionLastViewedSessionSeqFieldRef,
    sessionPinFindMany,
} from "./sessionRoutes.testkit";
import {
    DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT,
} from "./v2SessionListInitialPage";

function pagedSessionRow(
    id: string,
    overrides: Partial<{
        createdAt: Date;
        updatedAt: Date;
        meaningfulActivityAt: Date | null;
        active: boolean;
        lastActiveAt: Date;
    }> = {},
) {
    const createdAt = overrides.createdAt ?? new Date(1_000);
    return {
        id,
        seq: 1,
        accountId: "u1",
        encryptionMode: "plain",
        createdAt,
        updatedAt: overrides.updatedAt ?? createdAt,
        meaningfulActivityAt: overrides.meaningfulActivityAt ?? createdAt,
        archivedAt: null,
        metadata: "{}",
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        lastViewedSessionSeq: 0,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        pendingRequestObservedAt: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        thinking: false,
        thinkingAt: null,
        latestTurnId: null,
        latestTurnStatus: null,
        lastRuntimeIssue: null,
        pendingCount: 0,
        pendingVersion: 0,
        dataEncryptionKey: null,
        active: overrides.active ?? false,
        lastActiveAt: overrides.lastActiveAt ?? createdAt,
        runtimeActivityState: "unknown",
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityRevision: 0n,
        shares: [],
    };
}

const usageLimitRuntimeIssue: SessionRuntimeIssueV1 = {
    v: 1,
    scope: "primary_session",
    status: "failed",
    code: "usage_limit",
    source: "usage_limit",
    occurredAt: 1_000,
    provider: "claude",
    usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: "account",
        recoverability: "wait",
    },
};

function legacyPagedSessionRow(id: string) {
    const {
        pendingRequestObservedAt: _pendingRequestObservedAt,
        latestReadyEventSeq: _latestReadyEventSeq,
        latestReadyEventAt: _latestReadyEventAt,
        thinking: _thinking,
        thinkingAt: _thinkingAt,
        ...row
    } = pagedSessionRow(id);
    return row;
}

describe("sessionRoutes v2 sessions snapshot", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindFirst.mockReset();
        sessionFindMany.mockReset();
    });

    it("exposes the materialized turn status observation time on v2 session rows", () => {
        const now = new Date(1_000);
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_projection", { createdAt: now }),
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 1_234,
            } as any,
        });

        expect(mapped.latestTurnId).toBe("turn-1");
        expect(mapped.latestTurnStatus).toBe("completed");
        expect(mapped.latestTurnStatusObservedAt).toBe(1_234);
    });

    it("exposes durable attention and live-work projection fields on v2 session rows", () => {
        const now = new Date(1_000);
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_attention", { createdAt: now, active: true }),
                thinking: true,
                thinkingAt: new Date(1_111),
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: new Date(1_222),
                latestReadyEventSeq: 9,
                latestReadyEventAt: new Date(1_333),
                runtimeActivityState: "active",
                runtimeActivityRevision: BigInt(8),
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: BigInt(1_444),
            } as any,
        });

        expect(mapped.thinking).toBe(true);
        expect(mapped.thinkingAt).toBe(1_111);
        expect(mapped.pendingRequestObservedAt).toBe(1_222);
        expect(mapped.latestReadyEventSeq).toBe(9);
        expect(mapped.latestReadyEventAt).toBe(1_333);
        expect(mapped.runtimeActivityActiveCount).toBe(2);
        expect(mapped.runtimeActivityObservedAt).toBe(1_444);
        expect(mapped).not.toHaveProperty("runtimeActivitySourceClass");
    });

    it("preserves the target runtime activity projection without time-based reinterpretation", () => {
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_runtime_v2", { active: true }),
                runtimeActivityState: "active",
                runtimeActivityRevision: BigInt(17),
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(1_444),
            } as any,
        });

        expect(mapped).toMatchObject({
            runtimeActivityState: "active",
            runtimeActivityRevision: 17,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_444,
        });
        expect(mapped).not.toHaveProperty("runtimeActivitySourceClass");
    });

    it("hydrates generic unread sessions into the initial attention page and excludes read ready candidates", async () => {
        const unreadClaudeRow = {
            ...pagedSessionRow("claude-unread", { meaningfulActivityAt: new Date(7_390) }),
            seq: 742,
            lastViewedSessionSeq: 738,
            latestReadyEventSeq: 110,
            latestReadyEventAt: new Date(1_100),
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: BigInt(7_000),
        };
        const readReadyRow = {
            ...unreadClaudeRow,
            id: "read-ready",
            lastViewedSessionSeq: 742,
        };
        sessionPinFindMany.mockResolvedValue([]);
        sessionFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([unreadClaudeRow, readReadyRow])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: { includeAttention: true, limit: 10 },
        });

        expect(response).toEqual(expect.objectContaining({
            sessions: [expect.objectContaining({ id: "claude-unread" })],
        }));
        expect(sessionFindMany).toHaveBeenCalledTimes(4);
        expect(sessionFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                AND: [{
                    OR: expect.arrayContaining([
                        { lastViewedSessionSeq: null, seq: { gt: 0 } },
                        { seq: { gt: sessionLastViewedSessionSeqFieldRef } },
                    ]),
                }],
            }),
            take: DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT + 1,
        }));
    });


    it("exposes diagnostic route timing headers only when explicitly requested", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply } = await route.invoke({
            query: { limit: 10 },
            headers: { "x-happier-session-list-timing": "1" },
        });

        expect(reply.headers.get("server-timing")).toMatch(
            /happier_v2_sessions_cursor;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_query;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_page;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_total;dur=[0-9]+(?:\.[0-9]+)?/,
        );
    });

    it("exposes diagnostic route timing headers on archived session listing when explicitly requested", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/archived");
        const { reply } = await route.invoke({
            query: { limit: 10 },
            headers: { "x-happier-session-list-timing": "1" },
        });

        expect(reply.headers.get("server-timing")).toMatch(
            /happier_v2_sessions_cursor;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_query;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_page;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_total;dur=[0-9]+(?:\.[0-9]+)?/,
        );
    });
});
