import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

describe("accountRoutes (/v2/account/settings) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-settings-v2-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("GET /v2/account/settings returns plain envelope for a plain account", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-get",
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { schemaVersion: 2, notificationsSettingsV1: { v: 1 } } }),
                settingsVersion: 3,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body).toEqual({
                    content: { t: "plain", v: expect.any(Object) },
                    version: 3,
                });
                expect(body.content.v.schemaVersion).toBe(2);
            },
        );
    });

    it("POST /v1/account/settings fails fast for a plain account", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v1-plain",
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { settings: "ciphertext", expectedVersion: 0 },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "plain_account_requires_settings_v2" });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true },
        });
        expect(stored).toEqual({ settings: null, settingsVersion: 0 });
    });

    it("POST /v2/account/settings rejects encrypted content for plain accounts", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-plain",
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: { t: "encrypted", c: "ciphertext" }, expectedVersion: 0 },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "invalid-params" });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true },
        });
        expect(stored).toEqual({ settings: null, settingsVersion: 0 });
    });

    it("POST /v2/account/settings rejects plain content for e2ee accounts", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-e2ee",
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { content: { t: "plain", v: {} }, expectedVersion: 1 },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "invalid-params" });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { settings: true, settingsVersion: true },
        });
        expect(stored).toEqual({ settings: "ciphertext", settingsVersion: 1 });
    });

    it("POST /v2/account/settings roundtrips provider gauge and quota notification settings", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-settings-v2-provider-usage",
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const update = await app.inject({
                    method: "POST",
                    url: "/v2/account/settings",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        content: {
                            t: "plain",
                            v: {
                                schemaVersion: 2,
                                usageLimitRecoverySettingsV1: {
                                    v: 1,
                                    mode: "auto_wait",
                                    promptMode: "standard",
                                    resumePromptMode: "standard",
                                },
                                notificationsSettingsV1: {
                                    v: 1,
                                    connectedServiceAccountSwitch: true,
                                    connectedServiceQuotaBlocked: false,
                                    connectedServiceQuotaRecovered: true,
                                },
                            },
                        },
                        expectedVersion: 0,
                    },
                });
                expect(update.statusCode).toBe(200);
                expect(update.json()).toEqual({ success: true, version: 1 });

                const get = await app.inject({
                    method: "GET",
                    url: "/v2/account/settings",
                    headers: { "x-test-user-id": account.id },
                });

                expect(get.statusCode).toBe(200);
                expect(get.json()).toEqual({
                    content: {
                        t: "plain",
                        v: expect.objectContaining({
                            usageLimitRecoverySettingsV1: {
                                v: 1,
                                mode: "auto_wait",
                                promptMode: "standard",
                                resumePromptMode: "standard",
                            },
                            notificationsSettingsV1: expect.objectContaining({
                                connectedServiceAccountSwitch: true,
                                connectedServiceQuotaBlocked: false,
                                connectedServiceQuotaRecovered: true,
                            }),
                        }),
                    },
                    version: 1,
                });
            },
        );
    });
});
