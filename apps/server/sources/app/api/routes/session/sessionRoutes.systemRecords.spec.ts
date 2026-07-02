import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    buildMessageUpdatedUpdate,
    buildNewMessageUpdate,
    createSessionRouteTestBuilder,
    emitUpdate,
    resetSessionRouteMocks,
} from "./sessionRoutes.testkit";

const upsertSessionSystemRecord = vi.fn();
const listSessionSystemRecords = vi.fn();
const getSessionSystemRecord = vi.fn();
const getLatestSessionSystemRecord = vi.fn();

vi.mock("@/app/session/systemRecords/sessionSystemRecordService", () => ({
    upsertSessionSystemRecord,
    listSessionSystemRecords,
    getSessionSystemRecord,
    getLatestSessionSystemRecord,
}));

function synopsisPayload(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        seqTo: 2,
        updatedAtMs: 3,
        synopsis: "hello",
        ...overrides,
    };
}

describe("sessionRoutes system records", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        upsertSessionSystemRecord.mockReset();
        listSessionSystemRecords.mockReset();
        getSessionSystemRecord.mockReset();
        getLatestSessionSystemRecord.mockReset();
    });

    it("upserts a system record without emitting transcript updates", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        const updatedAt = new Date("2026-05-19T10:01:00.000Z");
        upsertSessionSystemRecord.mockResolvedValue({
            ok: true,
            didCreate: true,
            didUpdate: false,
            record: {
                id: "rec-1",
                sessionId: "s1",
                namespace: "memory",
                kind: "summary_shard.v1",
                localId: "memory:summary_shard:v1:1-2",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt,
            },
        });

        const route = await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/system-records");
        expect(route.routeExists).toBe(true);

        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                namespace: "memory",
                kind: "summary_shard.v1",
                localId: "memory:summary_shard:v1:1-2",
                content: { t: "encrypted", c: "cipher" },
            },
        });

        expect(upsertSessionSystemRecord).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "summary_shard.v1",
            localId: "memory:summary_shard:v1:1-2",
            content: { t: "encrypted", c: "cipher" },
        });
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildMessageUpdatedUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(res).toEqual({
            didCreate: true,
            didUpdate: false,
            record: {
                id: "rec-1",
                sessionId: "s1",
                namespace: "memory",
                kind: "summary_shard.v1",
                localId: "memory:summary_shard:v1:1-2",
                content: { t: "encrypted", c: "cipher" },
                createdAt: createdAt.toISOString(),
                updatedAt: updatedAt.toISOString(),
            },
        });
    });

    it("upserts an activity workflow record through the same generic route", async () => {
        const createdAt = new Date("2026-06-26T10:00:00.000Z");
        const updatedAt = new Date("2026-06-26T10:01:00.000Z");
        upsertSessionSystemRecord.mockResolvedValue({
            ok: true,
            didCreate: true,
            didUpdate: false,
            record: {
                id: "rec-wf",
                sessionId: "s1",
                namespace: "activity",
                kind: "workflow_run.v1",
                localId: "activity:workflow_run:v1:wf_demo",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt,
            },
        });

        const route = await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/system-records");
        expect(route.routeExists).toBe(true);

        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                namespace: "activity",
                kind: "workflow_run.v1",
                localId: "activity:workflow_run:v1:wf_demo",
                content: { t: "encrypted", c: "cipher" },
            },
        });

        expect(upsertSessionSystemRecord).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "activity",
            kind: "workflow_run.v1",
            localId: "activity:workflow_run:v1:wf_demo",
            content: { t: "encrypted", c: "cipher" },
        });
        expect(res).toEqual({
            didCreate: true,
            didUpdate: false,
            record: {
                id: "rec-wf",
                sessionId: "s1",
                namespace: "activity",
                kind: "workflow_run.v1",
                localId: "activity:workflow_run:v1:wf_demo",
                content: { t: "encrypted", c: "cipher" },
                createdAt: createdAt.toISOString(),
                updatedAt: updatedAt.toISOString(),
            },
        });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("lists system records through query fields", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        listSessionSystemRecords.mockResolvedValue({
            ok: true,
            records: [
                {
                    id: "rec-1",
                    sessionId: "s1",
                    namespace: "memory",
                    kind: "summary_shard.v1",
                    localId: "memory:summary_shard:v1:1-2",
                    content: { t: "encrypted", c: "cipher" },
                    createdAt,
                    updatedAt: createdAt,
                },
            ],
            nextCursor: "cursor-1",
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records");
        expect(route.routeExists).toBe(true);

        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: {
                namespace: "memory",
                kind: "summary_shard.v1",
                localId: "memory:summary_shard:v1:1-2",
                limit: 50,
                cursor: "cursor-0",
            },
        });

        expect(listSessionSystemRecords).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "summary_shard.v1",
            localId: "memory:summary_shard:v1:1-2",
            limit: 50,
            cursor: "cursor-0",
        });
        expect(res).toEqual({
            records: [
                {
                    id: "rec-1",
                    sessionId: "s1",
                    namespace: "memory",
                    kind: "summary_shard.v1",
                    localId: "memory:summary_shard:v1:1-2",
                    content: { t: "encrypted", c: "cipher" },
                    createdAt: createdAt.toISOString(),
                    updatedAt: createdAt.toISOString(),
                },
            ],
            nextCursor: "cursor-1",
            hasNext: true,
        });
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns the latest matching system record through query fields", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        getLatestSessionSystemRecord.mockResolvedValue({
            ok: true,
            record: {
                id: "rec-2",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: synopsisPayload() },
                createdAt,
                updatedAt: createdAt,
            },
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/latest");
        expect(route.routeExists).toBe(true);

        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { namespace: "memory", kind: "synopsis.v1" },
        });

        expect(getLatestSessionSystemRecord).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            kind: "synopsis.v1",
        });
        expect(res).toEqual({
            record: {
                id: "rec-2",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: synopsisPayload() },
                createdAt: createdAt.toISOString(),
                updatedAt: createdAt.toISOString(),
            },
        });
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("fetches a single system record through query fields without emitting transcript updates", async () => {
        const createdAt = new Date("2026-05-19T10:00:00.000Z");
        getSessionSystemRecord.mockResolvedValue({
            ok: true,
            record: {
                id: "rec-lookup",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            },
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/system-records/record");
        expect(route.routeExists).toBe(true);

        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            query: { namespace: "memory", localId: "memory:synopsis:v1:2" },
        });

        expect(getSessionSystemRecord).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            namespace: "memory",
            localId: "memory:synopsis:v1:2",
        });
        expect(res).toEqual({
            record: {
                id: "rec-lookup",
                sessionId: "s1",
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "encrypted", c: "cipher" },
                createdAt: createdAt.toISOString(),
                updatedAt: createdAt.toISOString(),
            },
        });
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildMessageUpdatedUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rejects invalid plain memory payloads before calling the service", async () => {
        const route = await createSessionRouteTestBuilder("PUT", "/v2/sessions/:sessionId/system-records");
        expect(route.routeExists).toBe(true);

        const { reply } = await route.invoke({
            params: { sessionId: "s1" },
            body: {
                namespace: "memory",
                kind: "synopsis.v1",
                localId: "memory:synopsis:v1:2",
                content: { t: "plain", v: { anything: true } },
            },
        });

        expect(reply.statusCode).toBe(400);
        expect(upsertSessionSystemRecord).not.toHaveBeenCalled();
    });
});
