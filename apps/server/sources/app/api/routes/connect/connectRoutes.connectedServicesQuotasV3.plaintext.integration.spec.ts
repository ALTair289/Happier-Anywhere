import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    closeProviderAccountUsageTrackedApps,
    createProviderAccountUsageRecordKey,
    createProviderAccountUsageTestApp,
    createUsageSnapshot,
    createV3ProviderAccountUsagePayload,
} from "./providerAccountUsageTestkit";

async function createConnectedServiceProfileBinding(
    accountId: string,
    params: Readonly<{ providerAccountId?: string | null }> = {},
): Promise<void> {
    await db.serviceAccountToken.create({
        data: {
            accountId,
            vendor: "openai-codex",
            profileId: "work",
            token: Buffer.from("token:openai-codex:work", "utf8"),
            metadata: {
                kind: "oauth",
                providerAccountId: params.providerAccountId ?? "acct_provider_subject",
            },
        },
    });
}

describe("connectRoutes (connected services quotas v3) plaintext quota endpoints", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-services-quotas-v3-",
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
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("writes a provider-account-backed quota view and projects it back through GET", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_quota_v3_projection" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v3_projection" }),
            planLabel: "team",
        });
        const expectedRecordId = snapshot.recordId;

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:canonicalized" }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(write.statusCode).toBe(200);

        const source = await db.connectedServiceUsageSource.findUnique({
            where: {
                accountId_serviceId_profileId: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                },
            },
            select: { providerAccountUsageRecordId: true },
        });
        expect(source?.providerAccountUsageRecordId).toBe(expectedRecordId);

        const record = await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: expectedRecordId,
                },
            },
            select: { snapshot: true, metadata: true },
        });
        expect(record).toMatchObject({
            metadata: { materialFingerprint: "usage:v3:canonicalized" },
        });

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(projected.statusCode).toBe(200);
        expect(projected.json()).toEqual({
            content: {
                t: "plain",
                v: expect.objectContaining({
                    serviceId: "openai-codex",
                    profileId: "work",
                    planLabel: "team",
                }),
            },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
        });
    });

    it("does not let direct provider-account usage writes act as quota view authority without a linked source", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_quota_v3_refresh" });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot }),
        })).statusCode).toBe(200);

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(projected.statusCode).toBe(404);
        expect(projected.json()).toEqual({ error: "connect_quotas_not_found" });
    });

    it("refreshes the linked provider-account usage record instead of creating placeholders", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_quota_v3_refresh" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v3_refresh" }),
        });
        const expectedRecordId = snapshot.recordId;

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode).toBe(200);

        const record = await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: expectedRecordId,
                },
            },
            select: { refreshRequestedAt: true },
        });
        expect(record?.refreshRequestedAt).not.toBeNull();
    });

    it("deletes quota access by unlinking the source and preserving the provider-account usage record", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_quota_v3_delete" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_quota_v3_delete" }),
        });
        const expectedRecordId = snapshot.recordId;

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);

        expect(await db.connectedServiceUsageSource.findUnique({
            where: {
                accountId_serviceId_profileId: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                },
            },
            select: { id: true },
        })).toBeNull();

        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: expectedRecordId,
                },
            },
            select: { id: true },
        })).not.toBeNull();
    });

    it("projects recovery credits from the linked provider-account usage record", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id);
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recoveryCredits: {
                kind: "usage_limit_resets",
                availableCount: 1,
                credits: [{
                    providerCreditId: "credit-1",
                    kind: "usage_limit_reset",
                    status: "available",
                }],
            },
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot }),
        });
        await db.connectedServiceUsageSource.create({
            data: {
                accountId: user.id,
                serviceId: "openai-codex",
                profileId: "work",
                sourceKey: "test-source",
                providerAccountUsageRecordId: snapshot.recordId,
                bindingKind: "profile",
            },
        });

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(projected.statusCode).toBe(200);
        expect(projected.json().content.v.recoveryCredits).toEqual({
            kind: "usage_limit_resets",
            availableCount: 1,
            credits: [{
                providerCreditId: "credit-1",
                kind: "usage_limit_reset",
                status: "available",
            }],
        });
    });
});
