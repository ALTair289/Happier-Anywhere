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
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityExpiresAt: null,
        runtimeActivitySourceClass: null,
        pendingCount: 0,
        pendingVersion: 0,
        dataEncryptionKey: null,
        active: overrides.active ?? false,
        lastActiveAt: overrides.lastActiveAt ?? createdAt,
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
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: BigInt(1_444),
                runtimeActivityExpiresAt: BigInt(2_444),
                runtimeActivitySourceClass: "provider_detached_task",
            } as any,
        });

        expect(mapped.thinking).toBe(true);
        expect(mapped.thinkingAt).toBe(1_111);
        expect(mapped.pendingRequestObservedAt).toBe(1_222);
        expect(mapped.latestReadyEventSeq).toBe(9);
        expect(mapped.latestReadyEventAt).toBe(1_333);
        expect(mapped.runtimeActivityActiveCount).toBe(2);
        expect(mapped.runtimeActivityObservedAt).toBe(1_444);
        expect(mapped.runtimeActivityExpiresAt).toBe(2_444);
        expect(mapped.runtimeActivitySourceClass).toBe("provider_detached_task");
    });

    it("fails closed for active runtime activity rows without a valid expiry", () => {
        const now = new Date(1_000);
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_malformed_runtime_activity", { createdAt: now, active: true }),
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: BigInt(1_444),
                runtimeActivityExpiresAt: null,
                runtimeActivitySourceClass: "provider_detached_task",
            } as any,
        });

        expect(mapped.runtimeActivityActiveCount).toBe(0);
        expect(mapped.runtimeActivityObservedAt).toBeNull();
        expect(mapped.runtimeActivityExpiresAt).toBeNull();
        expect(mapped.runtimeActivitySourceClass).toBeNull();
    });

    it.each([
        ["observed timestamp", { runtimeActivityObservedAt: null }],
        ["source class", { runtimeActivitySourceClass: "unknown_source" }],
    ])("fails closed for active runtime activity rows without a valid %s", (_label, override) => {
        const now = new Date(1_000);
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_malformed_runtime_activity", { createdAt: now, active: true }),
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: BigInt(1_444),
                runtimeActivityExpiresAt: BigInt(2_444),
                runtimeActivitySourceClass: "provider_detached_task",
                ...override,
            } as any,
        });

        expect(mapped.runtimeActivityActiveCount).toBe(0);
        expect(mapped.runtimeActivityObservedAt).toBeNull();
        expect(mapped.runtimeActivityExpiresAt).toBeNull();
        expect(mapped.runtimeActivitySourceClass).toBeNull();
    });

    it("treats terminal turn projection as authoritative over stale legacy thinking rows", () => {
        const now = new Date(1_000);
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_completed", { createdAt: now, active: true }),
                thinking: true,
                thinkingAt: new Date(2_000),
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 1_500,
            } as any,
        });

        expect(mapped.latestTurnStatus).toBe("completed");
        expect(mapped.thinking).toBe(false);
        expect(mapped.thinkingAt).toBe(1_500);
    });

    it("returns owned + shared sessions and uses share DEK for shared sessions", async () => {
        const now = new Date(1);
        sessionFindMany
            .mockResolvedValueOnce([
                {
                    id: "s3",
                    seq: 3,
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: new Date(3),
                    archivedAt: null,
                    metadata: "m3",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: 2,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    dataEncryptionKey: Buffer.from([1, 2, 3]),
                    active: true,
                    lastActiveAt: now,
                    shares: [],
                },
                {
                    id: "s2",
                    seq: 2,
                    accountId: "owner",
                    encryptionMode: "e2ee",
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: new Date(2),
                    archivedAt: null,
                    metadata: "m2",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: 1,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 2,
                    dataEncryptionKey: null,
                    active: true,
                    lastActiveAt: now,
                    shares: [
                        {
                            encryptedDataKey: Buffer.from([4, 5]),
                            accessLevel: "edit",
                            canApprovePermissions: true,
                        },
                    ],
                },
                {
                    id: "s1",
                    seq: 1,
                    accountId: "u1",
                    encryptionMode: "plain",
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: new Date(1),
                    archivedAt: null,
                    metadata: "m1",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    dataEncryptionKey: null,
                    active: true,
                    lastActiveAt: now,
                    shares: [],
                },
            ])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response: res } = await route.invoke({
            query: { limit: 2 },
        });

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s3",
                    meaningfulActivityAt: 3,
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "AQID",
                    lastViewedSessionSeq: 2,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    share: null,
                    archivedAt: null,
                }),
                expect.objectContaining({
                    id: "s2",
                    meaningfulActivityAt: 2,
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "BAU=",
                    lastViewedSessionSeq: 1,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 2,
                    share: { accessLevel: "edit", canApprovePermissions: true },
                    archivedAt: null,
                }),
            ],
            nextCursor: encodeV2SessionListCursorV2({ sessionId: "s2", meaningfulActivityAt: 2 }),
            hasNext: true,
        });
    });

    it("orders paged sessions by meaningful activity instead of raw update churn", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({
            query: { limit: 10 },
        });

        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            orderBy: [
                { meaningfulActivityAt: "desc" },
                { id: "desc" },
            ],
        }));
    });

    it("filters archived sessions out of the regular paged listing", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({
            query: { limit: 10 },
        });

        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
            }),
        }));
    });

    it("includes server-backed initial pinned rows and durable attention rows without consuming the regular page", async () => {
        const normalFirstPageRow = pagedSessionRow("s_normal_first_page", { meaningfulActivityAt: new Date(1_000) });
        const normalSecondPageRow = pagedSessionRow("s_normal_second_page", { meaningfulActivityAt: new Date(950) });
        const firstPinned = pagedSessionRow("s_pinned_old", { meaningfulActivityAt: new Date(100) });
        const secondPinned = pagedSessionRow("s_pinned_older", { meaningfulActivityAt: new Date(50) });
        const readyAttention = {
            ...pagedSessionRow("s_ready_attention", { meaningfulActivityAt: new Date(900) }),
            seq: 8,
            lastViewedSessionSeq: 7,
            latestReadyEventSeq: 8,
            latestReadyEventAt: new Date(900),
        };
        sessionPinFindMany.mockResolvedValue([
            { sessionId: "s_pinned_old", sortKey: "a", pinnedAt: new Date(1_000) },
            { sessionId: "s_pinned_older", sortKey: "b", pinnedAt: new Date(2_000) },
        ]);
        sessionFindMany
            .mockResolvedValueOnce([normalFirstPageRow, normalSecondPageRow])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                secondPinned,
                firstPinned,
            ])
            .mockResolvedValueOnce([readyAttention])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: {
                includeAttention: "true",
                limit: 1,
            },
        });

        expect((response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toEqual([
            "s_pinned_old",
            "s_pinned_older",
            "s_ready_attention",
            "s_normal_first_page",
        ]);
        expect(response).toEqual(expect.objectContaining({
            nextCursor: encodeV2SessionListCursorV2({ sessionId: "s_normal_first_page", meaningfulActivityAt: 1_000 }),
            hasNext: true,
        }));
        expect(sessionPinFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                session: expect.objectContaining({
                    archivedAt: null,
                    OR: [
                        { accountId: "u1" },
                        { shares: { some: { sharedWithUserId: "u1" } } },
                    ],
                }),
            }),
            orderBy: [{ sortKey: "asc" }, { pinnedAt: "asc" }],
            select: { sessionId: true, sortKey: true, pinnedAt: true },
        }));
    });

    it("ignores client-provided pinned ids when no server pins exist", async () => {
        sessionPinFindMany.mockResolvedValue([]);
        sessionFindMany
            .mockResolvedValueOnce([pagedSessionRow("s_normal_first_page", { meaningfulActivityAt: new Date(1_000) })])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: {
                pinnedSessionIds: "s_legacy_pinned",
                limit: 1,
            },
        });

        expect((response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toEqual([
            "s_normal_first_page",
        ]);
        expect(sessionFindMany).toHaveBeenCalledTimes(2);
        expect(sessionFindMany).not.toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: { in: ["s_legacy_pinned"] } }),
        }));
    });

    it("keeps primary failed initial attention rows even when the failure did not advance the session seq", async () => {
        const normalFirstPageRow = pagedSessionRow("s_normal_first_page", { meaningfulActivityAt: new Date(1_000) });
        const normalSecondPageRow = pagedSessionRow("s_normal_second_page", { meaningfulActivityAt: new Date(950) });
        const activeReadFailure = {
            ...pagedSessionRow("s_failed_active_read", { active: true, meaningfulActivityAt: new Date(2_500) }),
            seq: 10,
            lastViewedSessionSeq: 10,
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
        };
        const inactiveUnreadFailure = {
            ...pagedSessionRow("s_failed_inactive_unread", { active: false, meaningfulActivityAt: new Date(2_600) }),
            seq: 11,
            lastViewedSessionSeq: 10,
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
        };
        const inactiveStatusOnlyFailure = {
            ...pagedSessionRow("s_failed_status_only", { active: false, meaningfulActivityAt: new Date(2_700) }),
            seq: 10,
            lastViewedSessionSeq: 10,
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: 2_000,
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
        };
        const malformedFailure = {
            ...pagedSessionRow("s_failed_malformed_issue", { active: false, meaningfulActivityAt: new Date(2_800) }),
            seq: 10,
            lastViewedSessionSeq: 10,
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: 2_100,
            lastRuntimeIssue: JSON.stringify({ v: 1, scope: "primary_session", status: "completed" }),
        };
        sessionFindMany
            .mockResolvedValueOnce([normalFirstPageRow, normalSecondPageRow])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([activeReadFailure, inactiveUnreadFailure, inactiveStatusOnlyFailure, malformedFailure])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: {
                includeAttention: "true",
                limit: 1,
            },
        });

        const sessionIds = (response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id);
        expect(sessionIds).toHaveLength(4);
        expect(sessionIds).toEqual(expect.arrayContaining([
            "s_failed_active_read",
            "s_failed_inactive_unread",
            "s_failed_status_only",
            "s_normal_first_page",
        ]));
        expect(sessionIds).not.toContain("s_failed_malformed_issue");
    });

    it("caps initial durable attention expansion queries", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({
            query: {
                includeAttention: "true",
                limit: 1,
            },
        });

        const expectedBranchTake = DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT + 1;
        expect(sessionFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({ take: expectedBranchTake }));
        expect(sessionFindMany).toHaveBeenNthCalledWith(4, expect.objectContaining({ take: expectedBranchTake }));
    });

    it("does not run legacy pinned expansion queries from client-provided pinned ids", async () => {
        sessionFindMany.mockResolvedValue([]);
        const pinnedCount = 101;
        const pinnedSessionIds = Array.from(
            { length: pinnedCount },
            (_value, index) => `s_pinned_${index}`,
        ).join(",");

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({
            query: {
                pinnedSessionIds,
                limit: 1,
            },
        });

        expect(sessionFindMany).toHaveBeenCalledTimes(2);
        for (const call of sessionFindMany.mock.calls) {
            const where = call[0]?.where as { id?: { in?: string[] } } | undefined;
            expect(where?.id?.in).toBeUndefined();
        }
    });

    it("falls back to a legacy row select when attention projection columns are not migrated yet", async () => {
        const missingAttentionColumnError = Object.assign(
            new Error("no such column: Session.pendingRequestObservedAt"),
            { code: "P2022", meta: { column: "pendingRequestObservedAt" } },
        );
        sessionFindMany
            .mockRejectedValueOnce(missingAttentionColumnError)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([legacyPagedSessionRow("s_legacy")])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: { limit: 10 },
        });

        expect(response).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s_legacy",
                    thinking: false,
                    thinkingAt: null,
                    pendingRequestObservedAt: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(sessionFindMany.mock.calls[0]?.[0]?.select).toHaveProperty("pendingRequestObservedAt");
        expect(sessionFindMany.mock.calls[2]?.[0]?.select).not.toHaveProperty("pendingRequestObservedAt");
    });

    it("accepts legacy v1 cursors by resolving the cursor row effective activity", async () => {
        sessionFindFirst.mockResolvedValue({
            id: "s5",
            createdAt: new Date(5_000),
            meaningfulActivityAt: new Date(4_500),
        });
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response, reply } = await route.invoke({
            query: { limit: 10, cursor: encodeV2SessionListCursorV1("s5") },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: "s5",
                archivedAt: null,
                OR: expect.arrayContaining([
                    { accountId: "u1" },
                    { shares: { some: { sharedWithUserId: "u1" } } },
                ]),
            }),
            select: { id: true, createdAt: true, meaningfulActivityAt: true },
        }));
        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                AND: [{
                    OR: [
                        { meaningfulActivityAt: { lt: new Date(4_500) } },
                        { meaningfulActivityAt: new Date(4_500), id: { lt: "s5" } },
                    ],
                }],
            }),
        }));
        expect(response).toEqual({ sessions: [], nextCursor: null, hasNext: false });
    });

    it("paginates null meaningfulActivityAt rows by createdAt without skipping the next page", async () => {
        sessionFindMany
            .mockResolvedValueOnce([
                pagedSessionRow("s9", {
                    createdAt: new Date(900),
                    meaningfulActivityAt: new Date(9_000),
                }),
                pagedSessionRow("s7", {
                    createdAt: new Date(700),
                    meaningfulActivityAt: new Date(7_000),
                }),
            ])
            .mockResolvedValueOnce([
                pagedSessionRow("s8", {
                    createdAt: new Date(8_000),
                    meaningfulActivityAt: null,
                }),
            ])
            .mockResolvedValueOnce([
                pagedSessionRow("s7", {
                    createdAt: new Date(700),
                    meaningfulActivityAt: new Date(7_000),
                }),
            ])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response: firstPage } = await route.invoke({
            query: { limit: 2 },
        });

        expect(firstPage).toEqual({
            sessions: [
                expect.objectContaining({ id: "s9", meaningfulActivityAt: 9_000 }),
                expect.objectContaining({ id: "s8", meaningfulActivityAt: 8_000 }),
            ],
            nextCursor: encodeV2SessionListCursorV2({ sessionId: "s8", meaningfulActivityAt: 8_000 }),
            hasNext: true,
        });

        const { response: secondPage } = await route.invoke({
            query: {
                limit: 2,
                cursor: (firstPage as { nextCursor: string }).nextCursor,
            },
        });

        expect(secondPage).toEqual({
            sessions: [
                expect.objectContaining({ id: "s7", meaningfulActivityAt: 7_000 }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(sessionFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: { not: null },
                OR: expect.arrayContaining([
                    { accountId: "u1" },
                    { shares: { some: { sharedWithUserId: "u1" } } },
                ]),
                AND: [{
                    OR: [
                        { meaningfulActivityAt: { lt: new Date(8_000) } },
                        { meaningfulActivityAt: new Date(8_000), id: { lt: "s8" } },
                    ],
                }],
            }),
        }));
        expect(sessionFindMany).toHaveBeenNthCalledWith(4, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: null,
                OR: expect.arrayContaining([
                    { accountId: "u1" },
                    { shares: { some: { sharedWithUserId: "u1" } } },
                ]),
                AND: [{
                    OR: [
                        { createdAt: { lt: new Date(8_000) } },
                        { createdAt: new Date(8_000), id: { lt: "s8" } },
                    ],
                }],
            }),
        }));
    });

    it("does not expose diagnostic route timing headers on successful paged listing responses", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply } = await route.invoke({
            query: { limit: 10 },
        });

        expect(reply.headers.get("server-timing")).toBeUndefined();
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
