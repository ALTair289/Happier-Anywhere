import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { sessionRoutes } from "./sessionRoutes";

/**
 * `Session.unreadSince` is materialized and indexed by the server so every device orders unread
 * rows by the same stable key. That only holds if the column actually reaches the client: it was
 * materialized, indexed and consumed by the client for a whole program while being absent from both
 * wire projections, so every client silently fell back to a locally stamped value and the
 * cross-device promise was inert.
 *
 * These tests run the real route through the real Prisma projection and the real Fastify response
 * serializer, so they fail if the column is dropped from a row select, from the row mapper, or
 * filtered out during serialization.
 */

const { trackApp, closeTrackedApps } = createAppCloseTracker();

const UNREAD_SINCE = new Date(1_700_000_000_000);

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Test-boundary bridge: route helpers use the app-local Fastify alias with auth decorations.
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    sessionRoutes(typed);
    return trackApp(typed);
}

describe("session list projections deliver Session.unreadSince (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-unread-since-projection-sqlite-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    async function seedAccountWithUnreadAndReadSessions() {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const token = await auth.createToken(account.id);
        const unread = await db.session.create({
            data: {
                accountId: account.id,
                tag: `unread-${randomUUID()}`,
                metadata: "{}",
                seq: 7,
                lastViewedSessionSeq: 3,
                unreadSince: UNREAD_SINCE,
                meaningfulActivityAt: new Date(1_700_000_500_000),
            },
            select: { id: true },
        });
        const read = await db.session.create({
            data: {
                accountId: account.id,
                tag: `read-${randomUUID()}`,
                metadata: "{}",
                seq: 4,
                lastViewedSessionSeq: 4,
                unreadSince: null,
                meaningfulActivityAt: new Date(1_700_000_400_000),
            },
            select: { id: true },
        });
        return { accountId: account.id, token, unreadSessionId: unread.id, readSessionId: read.id };
    }

    function readSessionsById(payload: unknown): Map<string, Record<string, unknown>> {
        const sessions = (payload as { sessions?: unknown }).sessions;
        if (!Array.isArray(sessions)) throw new Error("response carried no sessions array");
        return new Map(sessions.map((session) => [(session as { id: string }).id, session as Record<string, unknown>]));
    }

    it("delivers the materialized unread instant on the v2 session list", async () => {
        const app = createTestApp();
        const seeded = await seedAccountWithUnreadAndReadSessions();

        const response = await app.inject({
            method: "GET",
            url: "/v2/sessions?limit=10&includeAttention=true",
            headers: { authorization: `Bearer ${seeded.token}` },
        });

        expect(response.statusCode).toBe(200);
        const sessions = readSessionsById(response.json());
        expect(sessions.get(seeded.unreadSessionId)).toHaveProperty("unreadSince", UNREAD_SINCE.getTime());
        // Anti-vacuity: the field must be read from the column, not stamped for every row.
        expect(sessions.get(seeded.readSessionId)).toHaveProperty("unreadSince", null);
    });

    it("delivers the materialized unread instant on the v2 session detail route", async () => {
        const app = createTestApp();
        const seeded = await seedAccountWithUnreadAndReadSessions();

        const response = await app.inject({
            method: "GET",
            url: `/v2/sessions/${seeded.unreadSessionId}`,
            headers: { authorization: `Bearer ${seeded.token}` },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().session).toHaveProperty("unreadSince", UNREAD_SINCE.getTime());
    });

    it("delivers the materialized unread instant on the legacy v1 session list", async () => {
        const app = createTestApp();
        const seeded = await seedAccountWithUnreadAndReadSessions();

        const response = await app.inject({
            method: "GET",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${seeded.token}` },
        });

        expect(response.statusCode).toBe(200);
        const sessions = readSessionsById(response.json());
        expect(sessions.get(seeded.unreadSessionId)).toHaveProperty("unreadSince", UNREAD_SINCE.getTime());
        expect(sessions.get(seeded.readSessionId)).toHaveProperty("unreadSince", null);
    });
});
