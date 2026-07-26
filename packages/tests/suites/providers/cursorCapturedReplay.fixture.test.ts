import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findDurableToolCallMultiplicities } from '../../src/testkit/providers/assertions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readReplay(): Promise<Record<string, unknown>> {
  const fixtureUrl = pathToFileURL(resolve(
    process.cwd(),
    'src/testkit/providers/fixtures/cursor-acp-captured-replay-v1.mjs',
  )).href;
  const imported: unknown = await import(fixtureUrl);
  if (!isRecord(imported) || !isRecord(imported.cursorCapturedReplayV1)) {
    throw new Error('Cursor replay fixture did not export cursorCapturedReplayV1');
  }
  return imported.cursorCapturedReplayV1;
}

describe('Cursor captured replay fixture', () => {
  it('records the real pre-fix cardinality and SDK basis without private content', async () => {
    const replay = await readReplay();
    expect(replay.provenance).toMatchObject({ cursorVersion: '2026.07.09-a3815c0', sdkBasis: '0.14.1' });
    expect(replay.capturedCardinality).toEqual({
      logicalCalls: 271,
      durableCallsBeforeFix: 302,
      providerResults: 270,
      duplicateCallIdsBeforeFix: 31,
      editLogicalCalls: 30,
      editDurableCallsBeforeFix: 60,
    });
    expect(JSON.stringify(replay)).not.toContain('/Users/');
    expect(JSON.stringify(replay)).not.toContain('TKKFL-');
  });

  it('contains every Phase-1 lifecycle and proprietary-contract family', async () => {
    const replay = await readReplay();
    expect(replay.requiredFamilies).toEqual({
      lifecycle: ['sparse-enrichment', 'terminal-only', 'duplicate-terminal', 'failed', 'cancelled', 'late-after-close', 'replay-finalized'],
      cursorExtensions: ['ask-question', 'create-plan', 'update-todos-request', 'update-todos-notification', 'task', 'generate-image', 'list-available-models'],
      sessionProjection: ['aggregate-search', 'session-info', 'current-mode', 'empty-switch-mode', 'standard-plan'],
      outcomes: ['answered', 'skipped', 'cancelled', 'accepted', 'rejected'],
    });

    const contracts = replay.extensionContracts;
    expect(isRecord(contracts)).toBe(true);
    expect(JSON.stringify(contracts)).toContain('selectedOptionIds');
    expect(JSON.stringify(contracts)).toContain('planUri');
    expect(JSON.stringify(contracts)).toContain('configOptions');
    expect(JSON.stringify(contracts)).toContain('lateAfterTurnClose');
  });

  it('contains six interleaved task starts and six enriched terminal task updates', async () => {
    const replay = await readReplay();
    expect(Array.isArray(replay.representativeLifecycle)).toBe(true);
    const lifecycle = Array.isArray(replay.representativeLifecycle) ? replay.representativeLifecycle : [];
    const taskEvents = lifecycle.filter((value) => isRecord(value) && String(value.toolCallId ?? '').startsWith('captured-task-'));
    expect(taskEvents).toHaveLength(12);
    expect(taskEvents.filter((value) => isRecord(value) && value.status === 'completed')).toHaveLength(6);
  });

  it('expands deterministically to the captured 271 logical calls and 270 result-bearing terminals', async () => {
    const replay = await readReplay();
    expect(Array.isArray(replay.fullLifecycle)).toBe(true);
    const lifecycle = Array.isArray(replay.fullLifecycle) ? replay.fullLifecycle : [];
    const ids = new Set(
      lifecycle
        .filter(isRecord)
        .map((event) => event.toolCallId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const resultBearingIds = new Set(
      lifecycle
        .filter(isRecord)
        .filter((event) => event.status === 'completed' || event.status === 'failed')
        .map((event) => event.toolCallId)
        .filter((id): id is string => typeof id === 'string'),
    );

    expect(ids.size).toBe(271);
    expect(resultBearingIds.size).toBe(270);
    const terminalEvents = lifecycle
      .filter(isRecord)
      .filter((event) => event.status === 'completed' || event.status === 'failed');
    expect(terminalEvents).toHaveLength(271);
    expect(terminalEvents.filter((event) => Object.hasOwn(event, 'rawOutput'))).toHaveLength(terminalEvents.length);
    expect(lifecycle.filter((event) => isRecord(event) && event.sessionUpdate === 'plan')).toHaveLength(1);
  });

  it('preserves legacy duplicate raw rows as immutable compatibility evidence', async () => {
    const replay = await readReplay();
    expect(isRecord(replay.legacyHistory)).toBe(true);
    const legacyHistory = isRecord(replay.legacyHistory) ? replay.legacyHistory : {};
    expect(Array.isArray(legacyHistory.rawRows)).toBe(true);
    const rawRows = Array.isArray(legacyHistory.rawRows) ? legacyHistory.rawRows : [];
    const before = JSON.stringify(rawRows);

    expect(findDurableToolCallMultiplicities(rawRows)).toEqual([
      expect.objectContaining({ callId: 'legacy-edit-001', namespace: 'main', rows: 2 }),
    ]);
    expect(JSON.stringify(rawRows)).toBe(before);
    expect(legacyHistory.expectedPresentation).toEqual({
      logicalCards: 1,
      callId: 'legacy-edit-001',
      name: 'Edit',
      resultRows: 1,
      rawCallRows: 2,
      serverWritesDuringProjection: 0,
    });
  });
});
