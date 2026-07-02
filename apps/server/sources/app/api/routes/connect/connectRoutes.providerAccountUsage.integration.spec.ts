import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import {
    closeProviderAccountUsageTrackedApps,
    createProviderAccountUsageRecordKey,
    createProviderAccountUsageTestApp,
    createUsageSnapshot,
    createV3ProviderAccountUsagePayload,
} from "./providerAccountUsageTestkit";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { writeProviderAccountUsageRecord } from "./providerAccountUsage";

describe("connectRoutes (provider account usage canonical routes)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-provider-account-usage-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await closeProviderAccountUsageTrackedApps();
        harness.resetEnv();
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("stores and returns a plaintext provider-account usage envelope for plaintext accounts", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "team" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:1" }),
        });
        expect(write.statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            content: { t: "plain", v: expect.objectContaining({ recordId: snapshot.recordId, planLabel: "team" }) },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
            sources: [],
        });

        const row = await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { payloadMode: true, metadata: true },
        });
        expect(row).toMatchObject({
            payloadMode: "plain_json_v1",
            metadata: { materialFingerprint: "usage:v3:1" },
        });
    });

    it("does not create plaintext provider-account usage rows from refresh requests for missing records", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}/refresh`,
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode).toBe(404);
        expect(refresh.json()).toEqual({ error: "provider_account_usage_not_found" });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects stale plaintext writes without a fingerprint from overwriting newer stored material", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const fetchedAt = Date.now();
        const newerSnapshot = createUsageSnapshot({ fetchedAt, planLabel: "newer-plan" });
        const staleSnapshot = createUsageSnapshot({
            fetchedAt: fetchedAt - 1,
            planLabel: "stale-plan",
            recordKey: newerSnapshot.recordKey,
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${newerSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot: newerSnapshot }),
        })).statusCode).toBe(200);

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${newerSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot: staleSnapshot }),
        })).statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${newerSnapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            content: { t: "plain", v: expect.objectContaining({ planLabel: "newer-plan", fetchedAtMs: fetchedAt }) },
            metadata: {
                fetchedAt,
                staleAfterMs: 60_000,
                status: "ok",
            },
            sources: [],
        });
    });

    it("returns 409 for sealed provider-account usage writes that lack an existing trusted record key", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "public-key", encryptionMode: "e2ee" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-provider-account-usage" },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                    materialFingerprint: "usage:v2:blocked",
                },
            },
        });
        expect(write.statusCode).toBe(409);
        expect(write.json()).toEqual({ error: "provider_account_usage_record_key_required" });
    });

    it("returns a 400 instead of a response serialization error for malformed sealed usage writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "public-key", encryptionMode: "e2ee" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "" },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });

        expect(write.statusCode).toBe(400);
    });

    it("reads, refreshes, and deletes sealed provider-account usage when a trusted record already exists", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "public-key", encryptionMode: "e2ee" }, select: { id: true } });
        const recordKey = createProviderAccountUsageRecordKey();
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey,
            payloadMode: "sealed_account_scoped_v1",
            status: "ok",
            sealedPayload: { format: "account_scoped_v1", ciphertext: "sealed-provider-account-usage" },
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const read = await app.inject({
            method: "GET",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            sealed: { format: "account_scoped_v1", ciphertext: "sealed-provider-account-usage" },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
            sources: [],
        });

        const refresh = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}/refresh`,
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode).toBe(200);

        const refreshed = await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { refreshRequestedAt: true },
        });
        expect(refreshed?.refreshRequestedAt).not.toBeNull();

        const deleted = await app.inject({
            method: "DELETE",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects canonical usage diagnostics with token-like headers", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const validSnapshot = createUsageSnapshot({ fetchedAt: Date.now() });
        const snapshot = {
            ...validSnapshot,
            diagnostics: [{ kind: "provider_http", headers: { authorization: "Bearer token" } }],
        };

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${validSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot: snapshot as ReturnType<typeof createUsageSnapshot> }),
        });
        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_payload_invalid",
        });
    });

    it("returns safe machine-readable reasons for invalid plaintext provider-account usage writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });
        const otherSnapshot = createUsageSnapshot({
            fetchedAt: Date.now() + 1,
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "other-account" }),
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const wrongRecordId = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${otherSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot }),
        });
        expect(wrongRecordId.statusCode).toBe(400);
        expect(wrongRecordId.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_record_id_mismatch",
        });

        const mismatchedClock = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot }),
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs + 1,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });
        expect(mismatchedClock.statusCode).toBe(400);
        expect(mismatchedClock.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_payload_invalid",
        });
    });
});
