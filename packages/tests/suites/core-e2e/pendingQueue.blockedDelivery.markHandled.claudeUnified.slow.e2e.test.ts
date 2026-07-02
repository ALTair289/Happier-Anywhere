import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchAllMessages, fetchSessionV2, type SessionV2 } from '../../src/testkit/sessions';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { repoRootDir } from '../../src/testkit/paths';
import { waitFor } from '../../src/testkit/timing';
import { fakeClaudeFixturePath, waitForFakeClaudeLocalIdleComposer } from '../../src/testkit/fakeClaude';
import { listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { fetchJson } from '../../src/testkit/http';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { yarnCommand } from '../../src/testkit/process/commands';

const run = createRunDirs({ runLabel: 'core' });

type UnknownRecord = Record<string, unknown>;

function decryptMetadata(snap: SessionV2, secret: Uint8Array): UnknownRecord | null {
  if (typeof snap.metadata !== 'string' || snap.metadata.length === 0) return null;
  const decrypted = decryptLegacyBase64(snap.metadata, secret);
  return decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)
    ? decrypted as UnknownRecord
    : null;
}

async function readMetadata(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
}>): Promise<UnknownRecord | null> {
  const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
  return decryptMetadata(snap, params.secret);
}

describe('core e2e: blocked pending delivery is mark-handled through public routes', () => {
  let server: StartedServer | null = null;
  let proc: SpawnedProcess | null = null;
  let cliHomeForCleanup: string | null = null;

  afterEach(async () => {
    await proc?.stop().catch(() => {});
    proc = null;
    if (cliHomeForCleanup) {
      await stopDaemonFromHomeDir(cliHomeForCleanup).catch(() => {});
      cliHomeForCleanup = null;
    }
    await server?.stop();
    server = null;
  });

  it('blocks a real Claude unified pending delivery on provider-acceptance timeout and lets the UI mark it handled', async () => {
    const testDir = run.testDir('pending-queue-blocked-delivery-mark-handled-claude-unified');
    const startedAt = new Date().toISOString();

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
    });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    cliHomeForCleanup = cliHome;
    const claudeConfigDir = resolve(join(testDir, 'claude-config'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(claudeConfigDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });
    await upsertEncryptedAccountSettingsV2({
      baseUrl: server.baseUrl,
      token: auth.token,
      secret,
      settings: {
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'auto',
        claudeRemoteAgentSdkEnabled: false,
      },
    });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'pending-queue-blocked-delivery-mark-handled-claude-unified',
        createdAt: Date.now(),
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-pending-queue-blocked-delivery-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({
      cliHome,
      sessionId,
      secret,
      encryptionVariant: 'legacy',
    });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const fakeClaudeInvocationId = `pending-blocked-${randomUUID()}`;

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-blocked-delivery-mark-handled-claude-unified',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('pending.list.json', async () => await listPendingQueueV2({
      baseUrl: server!.baseUrl,
      token: auth.token,
      sessionId,
      includeDiscarded: true,
    }));
    artifacts.json('session.v2.json', async () => await fetchSessionV2(server!.baseUrl, auth.token, sessionId));
    artifacts.json('transcript.json', async () => await fetchAllMessages(server!.baseUrl, auth.token, sessionId));

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
      HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: fakeClaudeInvocationId,
      HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'provider-acceptance-timeout-once',
      HAPPIER_CLAUDE_UNIFIED_TERMINAL_PROVIDER_ACCEPTANCE_TIMEOUT_MS: '25',
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv }, { skipSourceFreshnessCheck: true });

    proc = spawnLoggedProcess({
      command: yarnCommand(),
      args: [
        '-s',
        'workspace',
        '@happier-dev/cli',
        'dev',
        'claude',
        '--existing-session',
        sessionId,
        '--started-by',
        'terminal',
        '--happy-starting-mode',
        'local',
      ],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    let passed = false;
    try {
      await waitFor(async () => {
        const metadata = await readMetadata({ baseUrl: server!.baseUrl, token: auth.token, sessionId, secret });
        const value = metadata?.claudeSessionId;
        return typeof value === 'string' && value.length > 0;
      }, { timeoutMs: 120_000, context: 'Claude unified-terminal runtime binds and publishes a claudeSessionId' });

      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.active === true;
      }, { timeoutMs: 60_000, context: 'Claude session reports active before pending delivery test' });

      await waitForFakeClaudeLocalIdleComposer(fakeClaudeLogPath, { timeoutMs: 60_000 });

      const localId = `pending-${randomUUID()}`;
      const userText = `blocked pending delivery ${randomUUID()}`;
      const pendingCiphertext = encryptLegacyBase64(
        {
          role: 'user',
          content: { type: 'text', text: userText },
          localId,
          meta: { source: 'ui', sentFrom: 'e2e' },
        },
        secret,
      );

      const enqueue = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}/pending`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ localId, ciphertext: pendingCiphertext }),
        timeoutMs: 20_000,
      });
      expect(enqueue.status).toBe(200);
      expect(enqueue.data?.didWrite).toBe(true);

      await waitFor(async () => {
        const pending = await listPendingQueueV2({
          baseUrl: server!.baseUrl,
          token: auth.token,
          sessionId,
          includeDiscarded: true,
          timeoutMs: 20_000,
        });
        const row = pending.data.pending?.find((entry) => entry.localId === localId);
        return row?.deliveryState === 'blocked' && row?.deliveryBlockedReason === 'provider_acceptance_timeout';
      }, { timeoutMs: 60_000, context: 'provider acceptance timeout blocks the pending delivery row' });

      const blockedSession = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      expect(blockedSession.pendingCount).toBe(1);
      expect(blockedSession.pendingBlockedCount).toBe(1);

      const handled = await fetchJson<any>(
        `${server.baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}/pending/${encodeURIComponent(localId)}/delivery/handled`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
          timeoutMs: 20_000,
        },
      );
      expect(handled.status).toBe(200);
      expect(handled.data?.ok).toBe(true);

      await waitFor(async () => {
        const pending = await listPendingQueueV2({
          baseUrl: server!.baseUrl,
          token: auth.token,
          sessionId,
          includeDiscarded: true,
          timeoutMs: 20_000,
        });
        return pending.status === 200
          && Array.isArray(pending.data.pending)
          && pending.data.pending.every((entry) => entry.localId !== localId);
      }, { timeoutMs: 30_000, context: 'mark handled removes the blocked pending row' });

      const afterHandled = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      expect(afterHandled.pendingCount).toBe(0);
      expect(afterHandled.pendingBlockedCount).toBe(0);

      const transcript = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      const handledMessage = transcript.find((row) => row.localId === localId);
      expect(handledMessage).toBeDefined();

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: !passed });
    }
  }, 240_000);
});
