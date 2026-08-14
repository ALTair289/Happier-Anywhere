import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { countDuplicateLocalIds, createSession, fetchAllMessages, fetchSessionV2 } from '../../src/testkit/sessions';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { fetchJson } from '../../src/testkit/http';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: pending queue v2 materialize idempotency', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('rejects conflicting retries and returns the existing transcript for an exact retry', async () => {
    const testDir = run.testDir('pending-queue-v2-materialize-idempotency');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-materialize-idempotency',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('pending.list.json', async () => await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, includeDiscarded: true }));
    artifacts.json('transcript.json', async () => await fetchAllMessages(server!.baseUrl, auth.token, sessionId));
    artifacts.json('session.v2.json', async () => await fetchSessionV2(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    try {
      const localId = `local-${randomUUID()}`;

      // 1) Commit message into transcript first.
      const transcriptCiphertext = Buffer.from('TRANSCRIPT_ALREADY_HAS_LOCAL_ID', 'utf8').toString('base64');
      const writeMsg = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId, ciphertext: transcriptCiphertext }),
        timeoutMs: 20_000,
      });
      expect(writeMsg.status).toBe(200);

      // 2) A retry with the same localId but different content must fail closed;
      // accepting it would allow a stale queue row to substitute the committed text.
      const conflictingEnqueue = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId,
        ciphertext: Buffer.from('PENDING_STALE_ROW', 'utf8').toString('base64'),
        timeoutMs: 20_000,
      });
      expect(conflictingEnqueue.status).toBe(400);
      expect(conflictingEnqueue.data?.error).toBe('invalid-params');

      // 3) An exact retry resolves to the durable transcript, rather than
      // creating a second pending row or transcript message.
      const enqueue = await enqueuePendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, localId, ciphertext: transcriptCiphertext, timeoutMs: 20_000 });
      expect(enqueue.status).toBe(200);
      expect(enqueue.data?.terminal).toBe(true);
      expect(enqueue.data?.message?.localId).toBe(localId);

      const messages = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      expect(messages.filter((m) => m.localId === localId).length).toBe(1);
      expect(countDuplicateLocalIds(messages)).toBe(0);

      const pending = await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId });
      expect(pending.status).toBe(200);
      expect(pending.data?.pending?.length ?? 0).toBe(0);

      const snap: any = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      expect(snap.pendingCount).toBe(0);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  });
});
