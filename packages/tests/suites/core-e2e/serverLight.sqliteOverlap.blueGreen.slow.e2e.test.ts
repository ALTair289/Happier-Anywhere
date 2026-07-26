import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { fetchMachineIdentity, registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import { createSession, fetchAllMessages } from '../../src/testkit/sessions';
import {
  createMachineScopedSocketCollector,
  createUserScopedSocketCollector,
  type SocketCollector,
} from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { hasNewMessageUpdateWithLocalId } from '../../src/testkit/updates';
import { repoRootDir } from '../../src/testkit/paths';
import { collectDescendantPids } from '../../src/testkit/process/processTree';
import { inspectOwnedProcess } from '../../src/testkit/process/processOwnershipLease';

const run = createRunDirs({ runLabel: 'core' });
const CUTOVER_GRACE_MS = 250;

interface DevProxyController {
  readonly host: string;
  readonly port: number;
  readonly targetPort: number | null;
  flipUpstream(params: { targetPort: number }): Promise<unknown>;
  drainConnections(params: {
    graceMs?: number;
    targetHost?: string;
    targetPort?: number;
  }): Promise<void>;
  getUpstream(): Promise<{ targetHost: string; targetPort: number }>;
  readonly closed: Promise<{ expected: boolean; code: number | null; signal: string | null }>;
  stop(): Promise<void>;
}

async function startTestDevProxy(params: { stablePort: number; targetPort: number; label: string }): Promise<DevProxyController> {
  const moduleUrl = new URL('../../../../apps/stack/scripts/utils/dev/devProxy.mjs', import.meta.url).href;
  const module = await import(moduleUrl) as {
    startDevProxy(input: { stablePort: number; targetPort: number; label: string }): Promise<DevProxyController>;
  };
  return await module.startDevProxy(params);
}

function sqliteScalar(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

function sqliteRows<T>(dbPath: string, sql: string): T[] {
  const raw = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return raw ? JSON.parse(raw) as T[] : [];
}

async function health(baseUrl: string): Promise<number> {
  return (await fetchJson<unknown>(`${baseUrl}/health`, { timeoutMs: 5_000 })).status;
}

async function ready(baseUrl: string): Promise<number> {
  return (await fetchJson<unknown>(`${baseUrl}/ready`, { timeoutMs: 5_000 })).status;
}

async function postDurableMessage(params: { baseUrl: string; token: string; sessionId: string; localId: string; marker: string }): Promise<number> {
  const response = await fetchJson<unknown>(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      localId: params.localId,
      ciphertext: Buffer.from(params.marker, 'utf8').toString('base64'),
    }),
    timeoutMs: 20_000,
  });
  return response.status;
}

async function stopDevLightWrappedServerGracefully(server: StartedServer): Promise<void> {
  const wrapperPid = server.proc.child.pid;
  if (typeof wrapperPid !== 'number') throw new Error('dev:light wrapper PID is unavailable');
  const descendants = collectDescendantPids(wrapperPid);
  const serverPid = descendants.find((pid) => {
    const inspected = inspectOwnedProcess(pid);
    return inspected.ok && /main\.light\.ts|dist\/index\.js.*--light/.test(inspected.command.replaceAll('\\', '/'));
  });
  if (typeof serverPid !== 'number') throw new Error('dev:light server descendant PID is unavailable');
  process.kill(serverPid, 'SIGTERM');
  await waitFor(() => {
    const logs = `${readFileSync(server.proc.stdoutPath, 'utf8')}\n${readFileSync(server.proc.stderrPath, 'utf8')}`;
    return logs.includes('All 5 shutdown handlers completed')
      && logs.includes('Process exiting normally');
  }, { timeoutMs: 20_000, intervalMs: 50, context: 'dev:light inner server graceful exit' });
  await server.proc.stop();
}

describe('core e2e: server-light SQLite atomic blue-green overlap', () => {
  let oldServer: StartedServer | null = null;
  let replacement: StartedServer | null = null;
  let proxy: DevProxyController | null = null;
  const sockets: SocketCollector[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await proxy?.stop().catch(() => {});
    await oldServer?.stop().catch(() => {});
    await replacement?.stop().catch(() => {});
    proxy = null;
    oldServer = null;
    replacement = null;
  });

  it('cuts every stable client from old to replacement without split ownership or SQLite regression', async () => {
    const testDir = run.testDir('server-light-sqlite-overlap-blue-green');
    const commonEnv = {
      HAPPIER_API_RATE_LIMITS_ENABLED: '0',
      HAPPIER_PRESENCE_TIMEOUT_ENABLED: '0',
    };

    oldServer = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      instanceLabel: 'old',
      extraEnv: commonEnv,
    });
    expect(await ready(oldServer.baseUrl)).toBe(200);
    proxy = await startTestDevProxy({ stablePort: 0, targetPort: oldServer.port, label: 'sqlite-overlap-e2e' });
    const stableUrl = `http://${proxy.host}:${proxy.port}`;
    const auth = await createTestAuth(stableUrl);
    const { sessionId } = await createSession(stableUrl, auth.token);
    const machine = await registerMachineIdentity({ baseUrl: stableUrl, token: auth.token, machineId: `overlap-${randomUUID()}` });
    expect(machine.status).toBe(200);

    const user = createUserScopedSocketCollector(stableUrl, auth.token);
    const boundSession = await createMachineBoundSessionScopedSocketCollector({
      baseUrl: stableUrl,
      token: auth.token,
      sessionId,
      machineId: machine.machineId,
    });
    const session = boundSession.socket;
    const machineSocket = createMachineScopedSocketCollector(stableUrl, auth.token, machine.machineId);
    sockets.push(user, session, machineSocket);
    user.connect();
    session.connect();
    machineSocket.connect();
    await waitFor(() => sockets.every((socket) => socket.isConnected()), { timeoutMs: 25_000, context: 'old socket connections' });
    const removeRpcHandler = session.onRpcRequest(({ params }) => params);
    const rpcMethod = `${sessionId}:overlap-echo`;
    await session.rpcRegister(rpcMethod);
    expect(await user.rpcCall(rpcMethod, 'before-cutover-rpc')).toMatchObject({
      ok: true,
      result: 'before-cutover-rpc',
    });

    const preCutoverLocalId = randomUUID();
    await session.emitWithAck('message', {
      sid: sessionId,
      message: Buffer.from('before-cutover', 'utf8').toString('base64'),
      localId: preCutoverLocalId,
    });
    await waitFor(() => hasNewMessageUpdateWithLocalId(user.getEvents(), preCutoverLocalId), { timeoutMs: 20_000 });

    const dbPath = join(oldServer.dataDir, 'happier-server-light.sqlite');
    const migrationsBefore = sqliteRows<Record<string, unknown>>(
      dbPath,
      'select * from _prisma_migrations order by migration_name, id;',
    );
    replacement = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      instanceLabel: 'replacement',
      preserveExistingDataDir: true,
      useDevLightMigrationOwner: true,
      extraEnv: { ...commonEnv, HAPPIER_STACK_MIGRATE_MODE: 'skip' },
    });
    expect(await health(oldServer.baseUrl)).toBe(200);
    expect(await health(replacement.baseUrl)).toBe(200);
    expect(await ready(oldServer.baseUrl)).toBe(200);
    expect(await ready(replacement.baseUrl)).toBe(200);
    expect(sqliteRows<Record<string, unknown>>(dbPath, 'select * from _prisma_migrations order by migration_name, id;')).toEqual(migrationsBefore);

    const overlapWrites = await Promise.all([
      createSession(oldServer.baseUrl, auth.token),
      createSession(replacement.baseUrl, auth.token),
      registerMachineIdentity({ baseUrl: oldServer.baseUrl, token: auth.token, machineId: `old-${randomUUID()}` }),
      registerMachineIdentity({ baseUrl: replacement.baseUrl, token: auth.token, machineId: `new-${randomUUID()}` }),
    ]);
    expect(overlapWrites[2].status).toBe(200);
    expect(overlapWrites[3].status).toBe(200);
    const oldOverlapMachine = overlapWrites[2];
    const replacementOverlapMachine = overlapWrites[3];
    const oldOverlapSession = overlapWrites[0];
    const replacementOverlapSession = overlapWrites[1];
    expect((await fetchJson(`${replacement.baseUrl}/v2/sessions/${oldOverlapSession.sessionId}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })).status).toBe(200);
    expect((await fetchJson(`${oldServer.baseUrl}/v2/sessions/${replacementOverlapSession.sessionId}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })).status).toBe(200);
    const oldMachineViaReplacement = await fetchMachineIdentity({
      baseUrl: replacement.baseUrl,
      token: auth.token,
      machineId: oldOverlapMachine.machineId,
    });
    expect(oldMachineViaReplacement.id).toBe(oldOverlapMachine.machineId);
    const replacementMachineViaOld = await fetchMachineIdentity({
      baseUrl: oldServer.baseUrl,
      token: auth.token,
      machineId: replacementOverlapMachine.machineId,
    });
    expect(replacementMachineViaOld.id).toBe(replacementOverlapMachine.machineId);

    const overlapOldMessageId = randomUUID();
    const overlapReplacementMessageId = randomUUID();
    expect(await Promise.all([
      postDurableMessage({ baseUrl: oldServer.baseUrl, token: auth.token, sessionId, localId: overlapOldMessageId, marker: 'old-overlap-write' }),
      postDurableMessage({ baseUrl: replacement.baseUrl, token: auth.token, sessionId, localId: overlapReplacementMessageId, marker: 'replacement-overlap-write' }),
    ])).toEqual([200, 200]);
    const overlapMessages = await fetchAllMessages(replacement.baseUrl, auth.token, sessionId);
    expect(overlapMessages.filter((row) => row.localId === overlapOldMessageId)).toHaveLength(1);
    expect(overlapMessages.filter((row) => row.localId === overlapReplacementMessageId)).toHaveLength(1);

    const samples: Array<{ status: number; elapsedMs: number }> = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const startedAt = performance.now();
        const response = await fetchJson<unknown>(`${stableUrl}/health`, { timeoutMs: 5_000 }).catch(() => ({ status: 0, data: null }));
        samples.push({ status: response.status, elapsedMs: performance.now() - startedAt });
      }
    })();

    const cutoverStartedAt = performance.now();
    const connectsBefore = sockets.map((socket) => socket.getEvents().filter((event) => event.kind === 'connect').length);
    await proxy.flipUpstream({ targetPort: replacement.port });
    await proxy.drainConnections({
      graceMs: CUTOVER_GRACE_MS,
      targetHost: '127.0.0.1',
      targetPort: oldServer.port,
    });
    const upstream = await proxy.getUpstream();
    const cutoverMs = performance.now() - cutoverStartedAt;
    sampling = false;
    await sampler;
    expect(upstream).toEqual({
      targetHost: '127.0.0.1',
      targetPort: replacement.port,
    });
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(({ status }) => status === 200 || status === 503)).toBe(true);

    const reconnectStartedAt = performance.now();
    await waitFor(() => sockets.every((socket, index) => {
      const events = socket.getEvents();
      return socket.isConnected()
        && events.filter((event) => event.kind === 'disconnect').length === 1
        && events.filter((event) => event.kind === 'connect').length === (connectsBefore[index] ?? 0) + 1;
    }), { timeoutMs: 20_000, context: 'exactly one disconnect and replacement reconnect' });
    const reconnectMs = performance.now() - reconnectStartedAt;
    expect(proxy.targetPort).toBe(replacement.port);
    await session.rpcRegister(rpcMethod);
    expect(await user.rpcCall(rpcMethod, 'after-cutover-rpc')).toMatchObject({
      ok: true,
      result: 'after-cutover-rpc',
    });

    const postCutoverLocalId = randomUUID();
    await session.emitWithAck('message', {
      sid: sessionId,
      message: Buffer.from('after-cutover', 'utf8').toString('base64'),
      localId: postCutoverLocalId,
      echoToSender: true,
    });
    await waitFor(() => hasNewMessageUpdateWithLocalId(user.getEvents(), postCutoverLocalId), { timeoutMs: 20_000 });

    const replacementPresenceAt = Date.now();
    session.emit('session-alive', { sid: sessionId, time: replacementPresenceAt, thinking: true });
    machineSocket.emit('machine-alive', { machineId: machine.machineId, time: replacementPresenceAt });
    await waitFor(() => {
      const sessionPresence = sqliteRows<{ lastActiveAt: number; active: number }>(
        dbPath,
        `select lastActiveAt, active from Session where id = '${sessionId}';`,
      )[0];
      const machinePresence = sqliteRows<{ lastActiveAt: number; active: number }>(
        dbPath,
        `select lastActiveAt, active from Machine where id = '${machine.machineId}';`,
      )[0];
      return (sessionPresence?.lastActiveAt ?? 0) >= replacementPresenceAt
        && sessionPresence?.active === 1
        && (machinePresence?.lastActiveAt ?? 0) >= replacementPresenceAt
        && machinePresence?.active === 1;
    }, { timeoutMs: 15_000, intervalMs: 250, context: 'replacement presence persisted' });
    const presenceBeforeOldShutdown = {
      session: sqliteRows<Record<string, unknown>>(dbPath, `select lastActiveAt, active from Session where id = '${sessionId}';`)[0],
      machine: sqliteRows<Record<string, unknown>>(dbPath, `select lastActiveAt, active from Machine where id = '${machine.machineId}';`)[0],
    };

    const staleOldMachine = createMachineScopedSocketCollector(oldServer.baseUrl, auth.token, machine.machineId);
    const staleOldObserver = createUserScopedSocketCollector(oldServer.baseUrl, auth.token);
    staleOldMachine.connect();
    staleOldObserver.connect();
    await waitFor(() => staleOldMachine.isConnected() && staleOldObserver.isConnected(), {
      timeoutMs: 20_000,
      context: 'direct old presence probes and acceptance observer',
    });
    const staleOldAt = replacementPresenceAt - 60_000;
    staleOldMachine.emit('machine-alive', { machineId: machine.machineId, time: staleOldAt });
    await waitFor(() => {
      const ephemerals = staleOldObserver.getEvents()
        .filter((event) => event.kind === 'ephemeral')
        .map((event) => event.payload);
      return ephemerals.some((payload) => payload.type === 'machine-activity' && payload.id === machine.machineId && payload.activeAt === staleOldAt);
    }, { timeoutMs: 20_000, context: 'old server accepted and queued the stale machine presence observation' });

    const oldProc = oldServer.proc.child;
    await oldServer.stop();
    oldServer = null;
    staleOldMachine.close();
    staleOldObserver.close();
    expect(oldProc.exitCode).toBe(0);
    expect(oldProc.signalCode).toBeNull();
    const oldShutdownLogs = `${readFileSync(join(testDir, 'server.old.stdout.log'), 'utf8')}\n${readFileSync(join(testDir, 'server.old.stderr.log'), 'utf8')}`;
    const oldShutdownStart = oldShutdownLogs.lastIndexOf('Shutdown initiated:');
    expect(oldShutdownStart).toBeGreaterThanOrEqual(0);
    const oldShutdownSection = oldShutdownLogs.slice(oldShutdownStart);
    expect(oldShutdownSection).toMatch(/Flushed 1\/1 machine updates/);
    expect(oldShutdownSection).toMatch(/All 5 shutdown handlers completed/);
    expect(oldShutdownSection).toMatch(/Process exiting normally/);
    expect({
      session: sqliteRows<Record<string, unknown>>(dbPath, `select lastActiveAt, active from Session where id = '${sessionId}';`)[0],
      machine: sqliteRows<Record<string, unknown>>(dbPath, `select lastActiveAt, active from Machine where id = '${machine.machineId}';`)[0],
    }).toEqual(presenceBeforeOldShutdown);
    expect(await health(stableUrl)).toBe(200);
    const finalSession = await createSession(stableUrl, auth.token);
    expect(finalSession.sessionId).toBeTruthy();

    const messages = await fetchAllMessages(stableUrl, auth.token, sessionId);
    expect(messages.filter((row) => row.localId === preCutoverLocalId)).toHaveLength(1);
    expect(messages.filter((row) => row.localId === postCutoverLocalId)).toHaveLength(1);
    expect(messages.filter((row) => row.localId === overlapOldMessageId)).toHaveLength(1);
    expect(messages.filter((row) => row.localId === overlapReplacementMessageId)).toHaveLength(1);
    const finalOverlapMachines = sqliteRows<{ id: string; active: number; lastActiveAt: number }>(
      dbPath,
      `select id, active, lastActiveAt from Machine where id in ('${oldOverlapMachine.machineId}', '${replacementOverlapMachine.machineId}') order by id;`,
    );
    expect(finalOverlapMachines.map((row) => row.id).sort()).toEqual([
      oldOverlapMachine.machineId,
      replacementOverlapMachine.machineId,
    ].sort());
    expect(finalOverlapMachines).toEqual([
      {
        id: oldOverlapMachine.machineId,
        active: oldMachineViaReplacement.active === true ? 1 : 0,
        lastActiveAt: oldMachineViaReplacement.activeAt,
      },
      {
        id: replacementOverlapMachine.machineId,
        active: replacementMachineViaOld.active === true ? 1 : 0,
        lastActiveAt: replacementMachineViaOld.activeAt,
      },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(cutoverMs).toBeLessThan(5_000);
    expect(reconnectMs).toBeLessThan(20_000);
    expect(Math.max(...samples.map(({ elapsedMs }) => elapsedMs))).toBeLessThan(5_000);
    removeRpcHandler();
    for (const socket of sockets.splice(0)) socket.close();

    const replacementProc = replacement.proc.child;
    const replacementLogs = [replacement.proc.stdoutPath, replacement.proc.stderrPath];
    await stopDevLightWrappedServerGracefully(replacement);
    replacement = null;
    // dev.light.ts reports its intentionally SIGTERM-stopped child as a command failure;
    // the inner Happier server's canonical exitCode=0 evidence above is the graceful contract.
    expect(replacementProc.exitCode).toBe(1);
    expect(replacementProc.signalCode).toBeNull();
    await proxy.stop();
    const proxyExit = await proxy.closed;
    expect(proxyExit.expected).toBe(true);
    proxy = null;

    const oldLogs = [join(testDir, 'server.old.stdout.log'), join(testDir, 'server.old.stderr.log')];
    const logs = [...oldLogs, ...replacementLogs].map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(logs).not.toMatch(/SQLITE_BUSY|database is locked|P1008|P2024|Socket timeout|unhandled rejection/i);
    const replacementShutdownLogs = replacementLogs.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(replacementShutdownLogs).toMatch(/All 5 shutdown handlers completed/);
    expect(replacementShutdownLogs).toMatch(/Process exiting normally/);
    expect(sqliteScalar(dbPath, 'pragma integrity_check;')).toBe('ok');
    expect(sqliteRows<Record<string, unknown>>(dbPath, 'select * from _prisma_migrations order by migration_name, id;')).toEqual(migrationsBefore);
    const leaseDir = join(repoRootDir(), '.project', 'tmp', 'server-light-processes');
    for (const pid of [oldProc.pid, replacementProc.pid]) {
      if (typeof pid === 'number') expect(existsSync(join(leaseDir, `pid-${pid}.json`))).toBe(false);
    }
  }, 240_000);
});
