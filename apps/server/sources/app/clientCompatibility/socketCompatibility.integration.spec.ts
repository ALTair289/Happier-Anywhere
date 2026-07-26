import Fastify from 'fastify';
import { io as ioClient } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildClientCompatibilitySocketAuthV1 } from '@happier-dev/protocol';
import { auth } from '@/app/auth/auth';
import { startSocket } from '@/app/api/socket';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

async function waitForConnect(socket: ReturnType<typeof ioClient>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
    });
}

async function waitForConnectError(socket: ReturnType<typeof ioClient>): Promise<Record<string, unknown>> {
    return await new Promise((resolve, reject) => {
        socket.once('connect', () => reject(new Error('socket connected unexpectedly')));
        socket.once('connect_error', (error: unknown) => {
            const data = typeof error === 'object' && error !== null
                ? (error as { data?: unknown }).data
                : null;
            resolve(typeof data === 'object' && data !== null ? data as Record<string, unknown> : {});
        });
    });
}

describe('Socket.IO session-sync compatibility boundary', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-client-compat-socket-',
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
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
                daemon: '0.2.10',
                'session-runner': '0.2.10',
            }),
        });
    });

    afterEach(async () => {
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    async function startTestSocket() {
        const account = await db.account.create({
            data: { publicKey: `pk-socket-compat-${Date.now()}-${Math.random()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);
        const machineId = `m-compat-${Date.now()}-${Math.random()}`;
        await db.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                metadata: 'metadata',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
            },
        });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('socket test server failed to bind');
        return { app, token, machineId, url: `http://127.0.0.1:${address.port}` };
    }

    it('does not expose a process-local compatibility policy transition controller', async () => {
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        const result = startSocket(app);
        expect(result).toBeUndefined();
        await app.close();
    });

    it.each([
        ['observe', 'legacy', true],
        ['observe', 'v2', true],
        ['required', 'legacy', false],
        ['required', 'v2', true],
    ] as const)('applies the %s server × %s client rollout contract', async (enforcement, clientGeneration, shouldConnect) => {
        harness.resetEnv({
            HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: enforcement,
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: '2',
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
                daemon: '0.2.10',
                'session-runner': '0.2.10',
            }),
        });
        const { app, token, url } = await startTestSocket();
        const socket = ioClient(url, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {
                token,
                ...(clientGeneration === 'v2'
                    ? buildClientCompatibilitySocketAuthV1({
                        v: 1,
                        clientKind: 'ui-web',
                        appVersion: '0.2.10',
                        sessionSyncProtocolVersion: 2,
                    })
                    : {}),
            },
        });
        const result = shouldConnect
            ? waitForConnect(socket).then(() => null)
            : waitForConnectError(socket);
        const outcome = await result;
        socket.close();
        await app.close();

        if (shouldConnect) {
            expect(outcome).toBeNull();
        } else {
            expect(outcome).toMatchObject({ error: 'client-upgrade-required' });
        }
    }, 30_000);

    it('rejects missing compatibility before registering a session-scoped socket', async () => {
        const { app, token, url } = await startTestSocket();
        const socket = ioClient(url, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {
                token,
                clientType: 'session-scoped',
                sessionId: 'session-missing',
            },
        });
        const error = await waitForConnectError(socket);
        socket.close();
        await app.close();

        expect(error).toMatchObject({ error: 'client-upgrade-required' });
    }, 30_000);

    it('rejects a client-kind declaration that cannot own a session-scoped socket', async () => {
        const { app, token, url } = await startTestSocket();
        const socket = ioClient(url, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {
                token,
                clientType: 'session-scoped',
                sessionId: 'session-missing',
                ...buildClientCompatibilitySocketAuthV1({
                    v: 1,
                    clientKind: 'ui-web',
                    appVersion: '0.2.10',
                    sessionSyncProtocolVersion: 2,
                }),
            },
        });
        const error = await waitForConnectError(socket);
        socket.close();
        await app.close();

        expect(error).toMatchObject({ error: 'client-upgrade-required' });
    }, 30_000);

    it('rejects an out-of-date session runner before resolving its session binding', async () => {
        const { app, token, url } = await startTestSocket();
        const socket = ioClient(url, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {
                token,
                clientType: 'session-scoped',
                sessionId: 'session-missing',
                ...buildClientCompatibilitySocketAuthV1({
                    v: 1,
                    clientKind: 'session-runner',
                    appVersion: '0.2.9',
                    sessionSyncProtocolVersion: 2,
                }),
            },
        });
        const error = await waitForConnectError(socket);
        socket.close();
        await app.close();

        expect(error).toMatchObject({ error: 'client-upgrade-required' });
    }, 30_000);

    it.each([
        ['missing', {}],
        ['malformed', { clientCompatibility: { v: 1, clientKind: 'daemon' } }],
        ['older', buildClientCompatibilitySocketAuthV1({
            v: 1,
            clientKind: 'daemon',
            appVersion: '0.2.10',
            sessionSyncProtocolVersion: 1,
        })],
        ['app-too-old', buildClientCompatibilitySocketAuthV1({
            v: 1,
            clientKind: 'daemon',
            appVersion: '0.2.9',
            sessionSyncProtocolVersion: 2,
        })],
    ] as const)('rejects a %s daemon before machine ownership and admits the compatible daemon afterward', async (_case, compatibilityAuth) => {
        const { app, token, machineId, url } = await startTestSocket();
        const rejected = ioClient(url, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: { token, clientType: 'machine-scoped', machineId, ...compatibilityAuth },
        });
        const error = await waitForConnectError(rejected);
        rejected.close();
        expect(error).toMatchObject({ error: 'client-upgrade-required' });

        const compatible = ioClient(url, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {
                token,
                clientType: 'machine-scoped',
                machineId,
                ...buildClientCompatibilitySocketAuthV1({
                    v: 1,
                    clientKind: 'daemon',
                    appVersion: '0.2.10',
                    sessionSyncProtocolVersion: 2,
                }),
            },
        });
        await expect(waitForConnect(compatible)).resolves.toBeUndefined();
        compatible.close();
        await app.close();
    }, 30_000);

});
