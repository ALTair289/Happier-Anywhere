import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectCodexDirectUserMessageEvidence } from './codexDirectUserMessageEvidence';
import {
  beginCodexLegacyUserMessageIdentityAttempt,
  readCodexLegacyUserMessageIdentityRecords,
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

describe('codex legacy user-message identity lifecycle', () => {
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
