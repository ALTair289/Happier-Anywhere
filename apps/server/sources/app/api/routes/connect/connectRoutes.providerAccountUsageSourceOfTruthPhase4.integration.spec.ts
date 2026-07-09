import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildProviderAccountUsageRecordId } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    closeProviderAccountUsageTrackedApps,
    createLegacyQuotaSnapshot,
    createProviderAccountUsageRecordKey,
    createProviderAccountUsageTestApp,
    createUsageSnapshot,
    createV3ProviderAccountUsagePayload,
} from "./providerAccountUsageTestkit";
import { writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource } from "./providerAccountUsage";

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

describe("connectRoutes provider-account usage source-of-truth phase 4 contract", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-provider-account-usage-phase4-red-",
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

    it("does not treat alias-only provider-account usage rows as authority for v3 connected-service quota GET", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_canonical_v3_source" });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "alias-backed" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:red:alias-only" }),
        });
        expect(write.statusCode).toBe(200);

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });

        expect(projected.statusCode).toBe(404);
        expect(projected.json()).toEqual({ error: "connect_quotas_not_found" });
    });

    it("links source context from canonical v3 provider-account usage writes and exposes it as a connected-service quota view", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_canonical_v3_source" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_canonical_v3_source" }),
            planLabel: "canonical-source",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:canonical:v3-source" }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(write.statusCode).toBe(200);
        expect(write.json()).toEqual({
            success: true,
            source: { status: "linked" },
        });

        const source = await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                
            },
            select: { providerAccountUsageRecordId: true, bindingKind: true },
        });
        expect(source).toEqual({
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        });

        const providerRead = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(providerRead.statusCode).toBe(200);
        expect(providerRead.json()).toMatchObject({
            sources: [{
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            }],
        });

        const projected = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });

        expect(projected.statusCode).toBe(200);
        expect(projected.json()).toMatchObject({
            content: {
                t: "plain",
                v: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    activeAccountId: "acct_canonical_v3_source",
                    planLabel: "canonical-source",
                },
            },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
        });
    });

    it("reports a skipped v3 source link when the trusted profile binding is unavailable", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            planLabel: "source-skip",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:source-skip" }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "missing-profile",
                    bindingKind: "profile",
                },
            },
        });

        expect(write.statusCode).toBe(200);
        expect(write.json()).toEqual({
            success: true,
            source: {
                status: "skipped",
                reason: "binding_unavailable",
            },
        });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { id: true },
        })).not.toBeNull();
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "missing-profile",
                
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects same-account v3 source links when the provider usage record is incompatible with the connected service", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_delete_preserves_record" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                providerId: "claude",
                accountSubjectId: "acct_wrong_provider_v3_source",
            }),
            planLabel: "wrong-provider-source",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:wrong-provider-source" }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });

        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "connected_service_usage_source_incompatible",
        });
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                
            },
            select: { id: true },
        })).toBeNull();
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

    it("rejects same-service v3 source links when the provider account identity does not match the connected profile", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_connected_profile" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                providerId: "codex",
                accountSubjectId: "acct_usage_record",
            }),
            planLabel: "wrong-account-source",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:wrong-account-source" }),
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });

        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "connected_service_usage_source_incompatible",
        });
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                
            },
            select: { id: true },
        })).toBeNull();
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

    it("does not create provider-account refresh placeholders from profile bindings without a linked source-backed record", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_delete_preserves_record" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });

        expect(refresh.statusCode).toBe(404);
        expect(refresh.json()).toEqual({ error: "connect_quotas_not_found" });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: buildProviderAccountUsageRecordId({
                        providerId: "openai-codex",
                        accountSubjectId: "legacy-connected-service:openai-codex:work",
                        subjectKind: "unknown",
                        quotaScope: "account",
                    }),
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("preserves the provider-account usage record when deleting a connected-service quota view", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_delete_preserves_record" });
        const fetchedAt = Date.now();

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const providerSnapshot = createUsageSnapshot({
            fetchedAt,
            recordKey: createProviderAccountUsageRecordKey({
                providerId: "codex",
                accountSubjectId: "acct_delete_preserves_record",
            }),
            planLabel: "delete-preserves-record",
        });
        await writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource({
            accountId: user.id,
            recordId: providerSnapshot.recordId,
            recordKey: providerSnapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt: providerSnapshot.fetchedAtMs,
            staleAfterMs: providerSnapshot.staleAfterMs,
            materialFingerprint: "usage:red:preserve-provider-record",
            snapshot: providerSnapshot,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            },
        });

        const quotaBeforeDelete = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(quotaBeforeDelete.statusCode).toBe(200);

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ success: true });

        const providerRead = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${providerSnapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(providerRead.statusCode).toBe(200);

        const quotaRead = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(quotaRead.statusCode).toBe(404);
        expect(quotaRead.json()).toEqual({ error: "connect_quotas_not_found" });
    });

    it("rejects v3 connected-service quota writes so clients cannot mint provider-account usage from quota payloads", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id);
        const snapshot = createLegacyQuotaSnapshot({ fetchedAt: Date.now(), planLabel: "legacy-write-retired" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: snapshot },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                    materialFingerprint: "usage:v3:retired-quota-write",
                },
            },
        });
        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({ error: "invalid-params" });
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects client-authored aliases on v2 sealed provider-account usage writes", async () => {
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
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "sealed-provider-account-usage",
                },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                    aliases: [{
                        kind: "connectedServiceProfile",
                        providerId: "codex",
                        serviceId: "openai-codex",
                        profileId: "work",
                        accountSubjectId: "acct_provider_subject",
                    }],
                },
            },
        });

        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_legacy_aliases_rejected",
        });
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

    it("creates sealed provider-account usage records from canonical v2 writes with recordKey and source context", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-v2-canonical-source", encryptionMode: "e2ee" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_canonical_v2_source" });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_canonical_v2_source" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "sealed-canonical-provider-account-usage",
                },
                metadata: {
                    fetchedAt: 12_345,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "usage:canonical:v2-source",
                },
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });
        expect(write.statusCode).toBe(200);
        expect(write.json()).toEqual({
            success: true,
            source: { status: "linked" },
        });

        const canonicalRead = await app.inject({
            method: "GET",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(canonicalRead.statusCode).toBe(200);
        expect(canonicalRead.json()).toMatchObject({
            sealed: {
                format: "account_scoped_v1",
                ciphertext: "sealed-canonical-provider-account-usage",
            },
            metadata: {
                fetchedAt: 12_345,
                staleAfterMs: 300_000,
                status: "ok",
            },
            sources: [{
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            }],
        });

        const quotaRead = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(quotaRead.statusCode).toBe(200);
        expect(quotaRead.json()).toEqual({
            sealed: {
                format: "account_scoped_v1",
                ciphertext: "sealed-canonical-provider-account-usage",
            },
            metadata: {
                fetchedAt: 12_345,
                staleAfterMs: 300_000,
                status: "ok",
            },
        });
    });

    it("reports a skipped v2 source link when the trusted profile binding is unavailable", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-v2-source-skip", encryptionMode: "e2ee" }, select: { id: true } });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_v2_source_skip" });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "sealed-source-skip",
                },
                metadata: {
                    fetchedAt: 32_345,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "usage:v2:source-skip",
                },
                source: {
                    serviceId: "openai-codex",
                    profileId: "missing-profile",
                    bindingKind: "profile",
                },
            },
        });

        expect(write.statusCode).toBe(200);
        expect(write.json()).toEqual({
            success: true,
            source: {
                status: "skipped",
                reason: "binding_unavailable",
            },
        });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: { id: true },
        })).not.toBeNull();
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "missing-profile",
                
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects same-account v2 source links when the provider usage record is incompatible with the connected service", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-v2-wrong-source", encryptionMode: "e2ee" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id);
        const recordKey = createProviderAccountUsageRecordKey({
            providerId: "claude",
            accountSubjectId: "acct_wrong_provider_v2_source",
        });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "sealed-wrong-provider-source",
                },
                metadata: {
                    fetchedAt: 22_345,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "usage:v2:wrong-provider-source",
                },
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });

        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "connected_service_usage_source_incompatible",
        });
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                
            },
            select: { id: true },
        })).toBeNull();
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects same-service v2 source links when the provider account identity does not match the connected profile", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-v2-wrong-account-source", encryptionMode: "e2ee" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_connected_profile" });
        const recordKey = createProviderAccountUsageRecordKey({
            providerId: "codex",
            accountSubjectId: "acct_usage_record",
        });
        const recordId = buildProviderAccountUsageRecordId(recordKey);

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                recordKey,
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: "sealed-wrong-account-source",
                },
                metadata: {
                    fetchedAt: 22_345,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "usage:v2:wrong-account-source",
                },
                source: {
                    serviceId: "openai-codex",
                    profileId: "work",
                    bindingKind: "profile",
                },
            },
        });

        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "connected_service_usage_source_incompatible",
        });
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                
            },
            select: { id: true },
        })).toBeNull();
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("unlinks a source-backed connected-service quota view when the credential is deleted", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id, { providerAccountId: "acct_deleted_credential_source" });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_deleted_credential_source" }),
        });
        await writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            materialFingerprint: "usage:delete-credential-source",
            snapshot,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            },
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const beforeDelete = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(beforeDelete.statusCode).toBe(200);

        const deleted = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);

        const afterDelete = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(afterDelete.statusCode).toBe(404);
        expect(afterDelete.json()).toEqual({ error: "connect_quotas_not_found" });
        expect(await db.connectedServiceUsageSource.findFirst({
            where: {
                    accountId: user.id,
                    serviceId: "openai-codex",
                    profileId: "work",
                
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects v2 connected-service quota writes so clients cannot mint fallback provider-account usage records", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "pk-v2-adapter", encryptionMode: "e2ee" }, select: { id: true } });
        await createConnectedServiceProfileBinding(user.id);
        const expectedRecordId = buildProviderAccountUsageRecordId({
            providerId: "openai-codex",
            accountSubjectId: "legacy-connected-service:openai-codex:work",
            subjectKind: "unknown",
            quotaScope: "account",
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-legacy-quota" },
                metadata: {
                    fetchedAt: 1_234,
                    staleAfterMs: 300_000,
                    status: "ok",
                    materialFingerprint: "legacy:v2:phase4",
                },
            },
        });
        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({ error: "invalid-params" });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: expectedRecordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });
});
