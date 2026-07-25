import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildClientCompatibilityHttpHeadersV1 } from '@happier-dev/protocol';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('authenticated HTTP session-sync compatibility boundary', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-client-compat-http-',
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv({
            HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: 'required',
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: '2',
        });
    });

    afterEach(async () => {
        await db.account.deleteMany();
    });

    async function createAppAndToken() {
        const account = await db.account.create({
            data: { publicKey: `pk-compat-${Date.now()}-${Math.random()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        enableAuthentication(app);
        app.get('/v2/sessions', { preHandler: app.authenticate }, async () => ({ ok: true }));
        app.post('/v1/sessions', { preHandler: app.authenticate }, async () => ({ ok: true }));
        app.get('/v1/version', async () => ({ ok: true }));
        await app.ready();
        return { app, token };
    }

    it('rejects an authenticated protected request without a declaration', async () => {
        const { app, token } = await createAppAndToken();
        const response = await app.inject({
            method: 'GET',
            url: '/v2/sessions',
            headers: { authorization: `Bearer ${token}` },
        });
        await app.close();

        expect(response.statusCode).toBe(426);
        expect(response.json()).toMatchObject({ error: 'client-upgrade-required' });
    });

    it('admits an authenticated protected request with a compatible declaration', async () => {
        const { app, token } = await createAppAndToken();
        const response = await app.inject({
            method: 'GET',
            url: '/v2/sessions',
            headers: {
                authorization: `Bearer ${token}`,
                ...buildClientCompatibilityHttpHeadersV1({
                    v: 1,
                    clientKind: 'ui-web',
                    appVersion: '0.2.10',
                    sessionSyncProtocolVersion: 2,
                }),
            },
        });
        await app.close();

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
    });

    it('rejects session creation before route effects when daemon compatibility is missing', async () => {
        const { app, token } = await createAppAndToken();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: { authorization: `Bearer ${token}` },
        });
        await app.close();

        expect(response.statusCode).toBe(426);
        expect(response.json()).toMatchObject({ error: 'client-upgrade-required' });
    });

    it('keeps update discovery reachable without compatibility headers', async () => {
        const { app } = await createAppAndToken();
        const response = await app.inject({ method: 'GET', url: '/v1/version' });
        await app.close();

        expect(response.statusCode).toBe(200);
    });
});
