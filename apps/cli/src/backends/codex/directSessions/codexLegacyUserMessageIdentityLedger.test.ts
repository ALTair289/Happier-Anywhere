import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { collectCodexDirectUserMessageEvidence } from './codexDirectUserMessageEvidence';
import {
  beginCodexLegacyUserMessageIdentityAttempt,
  readCodexLegacyUserMessageIdentityRecords,
  runCodexLegacyUserMessageIdentityAttempt,
} from './codexLegacyUserMessageIdentityLedger';

async function createFixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), label));
  const activeServerDir = join(root, 'server');
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions');
  const threadId = 'ledger-thread';
  const fileRelPath = join('sessions', `rollout-2026-08-11T00-00-00-${threadId}.jsonl`);
  const filePath = join(codexHome, fileRelPath);
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`, 'utf8');
  return { activeServerDir, codexHome, threadId, filePath, fileRelPath };
}

async function appendCanonicalUserObservation(filePath: string, prompt: string) {
  await appendFile(
    filePath,
    `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: prompt }] },
    })}\n${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: prompt },
    })}\n`,
    'utf8',
  );
}

async function readMappedLocalIds(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const records = await readCodexLegacyUserMessageIdentityRecords(fixture);
  const evidence = await collectCodexDirectUserMessageEvidence({
    filePath: fixture.filePath,
    fileRelPath: fixture.fileRelPath,
    legacyIdentityRecords: records,
  });
  return { records, localIds: [...evidence.localIdByOffset.values()] };
}

async function listAcceptedRecoveryFiles(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<string[]> {
  const root = join(
    fixture.activeServerDir,
    'daemon',
    'direct-sessions',
    'codex-legacy-user-message-identities-v2-recovery',
  );
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !/^[a-f0-9]{64}$/u.test(directory.name)) continue;
    const names = await readdir(join(root, directory.name)).catch(() => []);
    files.push(...names
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .map((name) => join(root, directory.name, name)));
  }
  return files.sort();
}

describe('codex legacy user-message identity lifecycle', () => {
  it('serializes committed same-prompt sends so provider write order cannot exchange local ids', async () => {
    const fixture = await createFixture('happier-codex-legacy-ledger-committed-concurrent-');
    const requestOrder: string[] = [];
    const send = async (pendingLocalId: string, delayMs: number) => await runCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-concurrent-committed',
      prompt: 'committed concurrent prompt',
      pendingLocalId,
      request: async () => {
        requestOrder.push(`${pendingLocalId}:entered`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await appendCanonicalUserObservation(fixture.filePath, 'committed concurrent prompt');
        requestOrder.push(`${pendingLocalId}:written`);
      },
    });

    await Promise.all([
      send('first-committed-local-id', 30),
      send('second-committed-local-id', 0),
    ]);

    expect(requestOrder).toEqual([
      'first-committed-local-id:entered',
      'first-committed-local-id:written',
      'second-committed-local-id:entered',
      'second-committed-local-id:written',
    ]);
    const result = await readMappedLocalIds(fixture);
    expect(result.localIds).toEqual(['first-committed-local-id', 'second-committed-local-id']);
  });

  it('releases the backend-session queue when a legacy request fails', async () => {
    const fixture = await createFixture('happier-codex-legacy-ledger-queue-error-');
    const failed = runCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-error-release',
      prompt: 'queue release prompt',
      pendingLocalId: 'failed-queue-local-id',
      request: async () => {
        throw new Error('provider rejected queued request');
      },
    });
    const committed = runCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-error-release',
      prompt: 'queue release prompt',
      pendingLocalId: 'committed-after-error-local-id',
      request: async () => {
        await appendCanonicalUserObservation(fixture.filePath, 'queue release prompt');
      },
    });

    const results = await Promise.allSettled([failed, committed]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    const mapped = await readMappedLocalIds(fixture);
    expect(mapped.records.map((record) => record.pendingLocalId)).toEqual(['committed-after-error-local-id']);
    expect(mapped.localIds).toEqual(['committed-after-error-local-id']);
  });

  it('keeps an accepted provider request successful and recoverable across restart when the commit append fails', async () => {
    const fixture = await createFixture('happier-codex-legacy-ledger-commit-error-');
    let ledgerPath = '';
    const result = await runCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-accepted-commit-error',
      prompt: 'accepted despite commit failure',
      pendingLocalId: 'accepted-commit-error-local-id',
      request: async () => {
        await appendCanonicalUserObservation(fixture.filePath, 'accepted despite commit failure');
        const ledgerDir = join(
          fixture.activeServerDir,
          'daemon',
          'direct-sessions',
          'codex-legacy-user-message-identities-v2',
        );
        const [ledgerName] = await readdir(ledgerDir);
        if (!ledgerName) throw new Error('expected pending legacy identity ledger');
        ledgerPath = join(ledgerDir, ledgerName);
        await rename(ledgerPath, `${ledgerPath}.pending`);
        await mkdir(ledgerPath);
        return 'provider-accepted';
      },
    });

    expect(result).toBe('provider-accepted');
    const recoveryFiles = await listAcceptedRecoveryFiles(fixture);
    expect(recoveryFiles).toHaveLength(1);
    expect(await readFile(recoveryFiles[0]!, 'utf8')).not.toContain('accepted despite commit failure');

    vi.resetModules();
    const restartedLedger = await import('./codexLegacyUserMessageIdentityLedger');
    const restartedRecords = await restartedLedger.readCodexLegacyUserMessageIdentityRecords(fixture);
    const restartedEvidence = await collectCodexDirectUserMessageEvidence({
      filePath: fixture.filePath,
      fileRelPath: fixture.fileRelPath,
      legacyIdentityRecords: restartedRecords,
    });
    expect(restartedRecords).toHaveLength(1);
    expect([...restartedEvidence.localIdByOffset.values()]).toEqual(['accepted-commit-error-local-id']);

    await rm(ledgerPath, { recursive: true, force: true });
    await rename(`${ledgerPath}.pending`, ledgerPath);
    const reconciliationTrigger = await restartedLedger.beginCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-reconciliation-trigger',
      prompt: 'reconciliation trigger',
      pendingLocalId: 'reconciliation-trigger-local-id',
    });
    await reconciliationTrigger.cancel();
    expect(await listAcceptedRecoveryFiles(fixture)).toEqual([]);
    expect((await restartedLedger.readCodexLegacyUserMessageIdentityRecords(fixture)).map((record) => record.pendingLocalId))
      .toEqual(['accepted-commit-error-local-id']);
  });

  it('keeps repeated commit failures idempotent and compacts each recovery after the ledger becomes writable', async () => {
    const fixture = await createFixture('happier-codex-legacy-ledger-repeated-commit-error-');

    for (let index = 0; index < 3; index += 1) {
      const prompt = `accepted repeated failure ${index}`;
      const attempt = await beginCodexLegacyUserMessageIdentityAttempt({
        ...fixture,
        ownerId: 'owner-repeated-commit-error',
        prompt,
        pendingLocalId: `repeated-commit-error-local-id-${index}`,
      });
      await appendCanonicalUserObservation(fixture.filePath, prompt);

      const ledgerDir = join(
        fixture.activeServerDir,
        'daemon',
        'direct-sessions',
        'codex-legacy-user-message-identities-v2',
      );
      const [ledgerName] = await readdir(ledgerDir);
      if (!ledgerName) throw new Error('expected pending legacy identity ledger');
      const ledgerPath = join(ledgerDir, ledgerName);
      const backupPath = `${ledgerPath}.pending-${index}`;
      await rename(ledgerPath, backupPath);
      await mkdir(ledgerPath);

      await attempt.commit();
      await attempt.commit();
      expect(await listAcceptedRecoveryFiles(fixture)).toHaveLength(1);

      await rm(ledgerPath, { recursive: true, force: true });
      await rename(backupPath, ledgerPath);
    }

    const reconciliationTrigger = await beginCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-repeated-reconciliation-trigger',
      prompt: 'repeated reconciliation trigger',
      pendingLocalId: 'repeated-reconciliation-trigger-local-id',
    });
    await reconciliationTrigger.cancel();

    expect(await listAcceptedRecoveryFiles(fixture)).toEqual([]);
    expect((await readCodexLegacyUserMessageIdentityRecords(fixture)).map((record) => record.pendingLocalId)).toEqual([
      'repeated-commit-error-local-id-0',
      'repeated-commit-error-local-id-1',
      'repeated-commit-error-local-id-2',
    ]);
  });

  it('does not expose a retryable failure when both the primary ledger and durable recovery path reject writes', async () => {
    const fixture = await createFixture('happier-codex-legacy-ledger-storage-denied-');
    const result = await runCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-storage-denied',
      prompt: 'accepted while identity storage is denied',
      pendingLocalId: 'storage-denied-local-id',
      request: async () => {
        await appendCanonicalUserObservation(fixture.filePath, 'accepted while identity storage is denied');
        const directSessionsDir = join(fixture.activeServerDir, 'daemon', 'direct-sessions');
        const ledgerDir = join(directSessionsDir, 'codex-legacy-user-message-identities-v2');
        const [ledgerName] = await readdir(ledgerDir);
        if (!ledgerName) throw new Error('expected pending legacy identity ledger');
        const ledgerPath = join(ledgerDir, ledgerName);
        await rename(ledgerPath, `${ledgerPath}.pending`);
        await mkdir(ledgerPath);
        await writeFile(
          join(directSessionsDir, 'codex-legacy-user-message-identities-v2-recovery'),
          'blocked',
          'utf8',
        );
        return 'provider-accepted-with-storage-denied';
      },
    });

    expect(result).toBe('provider-accepted-with-storage-denied');
    const mapped = await readMappedLocalIds(fixture);
    expect(mapped.records.map((record) => record.pendingLocalId)).toEqual(['storage-denied-local-id']);
    expect(mapped.localIds).toEqual(['storage-denied-local-id']);
  });

  it('ignores a first failed same-prompt attempt and maps the second committed attempt', async () => {
    const fixture = await createFixture('happier-codex-legacy-ledger-retry-');
    const first = await beginCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-a',
      prompt: 'same prompt',
      pendingLocalId: 'failed-local-id',
    });
    await first.cancel();
    const second = await beginCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-a',
      prompt: 'same prompt',
      pendingLocalId: 'committed-local-id',
    });
    await second.commit();
    await appendCanonicalUserObservation(fixture.filePath, 'same prompt');

    const result = await readMappedLocalIds(fixture);
    expect(result.records.map((record) => record.pendingLocalId)).toEqual(['committed-local-id']);
    expect(result.localIds).toEqual(['committed-local-id']);
  });

  it('maps only the successful owner attempt when concurrent same-prompt requests split success and failure', async () => {
    const fixture = await createFixture('happier-codex-legacy-ledger-concurrent-');
    const [failed, committed] = await Promise.all([
      beginCodexLegacyUserMessageIdentityAttempt({
        ...fixture,
        ownerId: 'owner-failed',
        prompt: 'concurrent prompt',
        pendingLocalId: 'concurrent-failed-id',
      }),
      beginCodexLegacyUserMessageIdentityAttempt({
        ...fixture,
        ownerId: 'owner-committed',
        prompt: 'concurrent prompt',
        pendingLocalId: 'concurrent-committed-id',
      }),
    ]);
    await Promise.all([failed.cancel(), committed.commit()]);
    await appendCanonicalUserObservation(fixture.filePath, 'concurrent prompt');

    const result = await readMappedLocalIds(fixture);
    expect(result.records).toEqual([
      expect.objectContaining({ ownerId: 'owner-committed', pendingLocalId: 'concurrent-committed-id' }),
    ]);
    expect(result.localIds).toEqual(['concurrent-committed-id']);
  });

  it('never exposes stale pending or cancelled attempts to the matcher', async () => {
    const fixture = await createFixture('happier-codex-legacy-ledger-stale-');
    await beginCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-stale',
      prompt: 'stale prompt',
      pendingLocalId: 'stale-local-id',
    });
    const cancelled = await beginCodexLegacyUserMessageIdentityAttempt({
      ...fixture,
      ownerId: 'owner-cancelled',
      prompt: 'stale prompt',
      pendingLocalId: 'cancelled-local-id',
    });
    await cancelled.cancel();
    await appendCanonicalUserObservation(fixture.filePath, 'stale prompt');

    const result = await readMappedLocalIds(fixture);
    expect(result.records).toEqual([]);
    expect(result.localIds).toEqual([]);
  });
});
