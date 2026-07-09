import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_GOAL_WORK_STATE_ITEM_ID,
  CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES,
  createClaudeGoalStatusWorkStateTracker,
  mapClaudeGoalStatusEventToWorkStateItem,
  parseClaudeGoalStatusAttachment,
} from './claudeGoalStatus';

const FIXTURE_DIR = join(__dirname, '__fixtures__/goal-status');
const FIXTURE_SESSION_ID = 'ff668493-8325-49cc-976f-689b779b85a2';

function readFixture(name: string): unknown {
  const raw = readFileSync(join(FIXTURE_DIR, name), 'utf8').trim().split('\n')[0];
  return JSON.parse(raw);
}

function parse(name: string) {
  const event = parseClaudeGoalStatusAttachment(readFixture(name));
  if (!event) throw new Error(`fixture ${name} did not parse to a goal_status event`);
  return event;
}

describe('claudeGoalStatus parse + map', () => {
  it('maps an active (met=false) goal to an active goal item with capabilities when /goal is supported', () => {
    const item = mapClaudeGoalStatusEventToWorkStateItem(parse('edit-active.jsonl'), {
      backendId: 'claude',
      agentId: 'claude',
      updatedAt: 1000,
      currentClaudeSessionId: FIXTURE_SESSION_ID,
      goalCommandSupported: true,
    });

    expect(item).toMatchObject({
      id: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
      kind: 'goal',
      origin: 'vendor',
      status: 'active',
      backendId: 'claude',
      title: 'replace this goal with edited fixture objective',
      goalCapabilities: { canEdit: true, canClear: true },
      updatedAt: 1000,
    });
  });

  it('omits goalCapabilities when the /goal command is not supported', () => {
    const item = mapClaudeGoalStatusEventToWorkStateItem(parse('edit-active.jsonl'), {
      backendId: 'claude',
      updatedAt: 1,
      goalCommandSupported: false,
    });
    expect(item?.status).toBe('active');
    expect(item?.goalCapabilities).toBeUndefined();
  });

  it('maps a cleared (met=true + sentinel) goal to a cancelled item', () => {
    const item = mapClaudeGoalStatusEventToWorkStateItem(parse('cleared.jsonl'), {
      backendId: 'claude',
      updatedAt: 2000,
      currentClaudeSessionId: FIXTURE_SESSION_ID,
      goalCommandSupported: true,
    });
    expect(item?.status).toBe('cancelled');
    expect(item?.completedAt).toBe(Date.parse('2026-06-19T14:39:45.988Z'));
    // cancelled goals do not advertise editable capabilities
    expect(item?.goalCapabilities).toBeUndefined();
  });

  it('maps a completed (met=true, no sentinel) goal to a complete item carrying tokens/duration', () => {
    const item = mapClaudeGoalStatusEventToWorkStateItem(parse('completed.jsonl'), {
      backendId: 'claude',
      updatedAt: 3000,
      goalCommandSupported: true,
    });
    expect(item?.status).toBe('complete');
    expect(item?.tokensUsed).toBe(2393);
    expect(item?.timeUsedSeconds).toBeCloseTo(41.613, 3);
  });

  it('rejects goal_status events from a different Claude session', () => {
    const item = mapClaudeGoalStatusEventToWorkStateItem(parse('edit-active.jsonl'), {
      backendId: 'claude',
      updatedAt: 1,
      currentClaudeSessionId: 'some-other-session',
    });
    expect(item).toBeNull();
  });
});

describe('createClaudeGoalStatusWorkStateTracker', () => {
  it('emits an owned goal snapshot and dedupes by uuid', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({
      backendId: 'claude',
      agentId: 'claude',
      goalCommandSupported: true,
    });
    const event = parse('edit-active.jsonl');

    const first = tracker.applyAttachment(event, { updatedAt: 10, currentClaudeSessionId: FIXTURE_SESSION_ID });
    expect(first).not.toBeNull();
    expect(first?.ownedSourceFamilies).toEqual([...CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES]);
    expect(first?.items).toHaveLength(1);
    expect(first?.primaryItemId).toBe(CLAUDE_GOAL_WORK_STATE_ITEM_ID);

    // Re-applying the same uuid is a no-op (re-scanned transcript history).
    const second = tracker.applyAttachment(event, { updatedAt: 20, currentClaudeSessionId: FIXTURE_SESSION_ID });
    expect(second).toBeNull();
  });

  it('latest-wins: an active goal followed by completion publishes the terminal state', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', goalCommandSupported: true });
    const active = tracker.applyAttachment(parse('edit-active.jsonl'), { updatedAt: 1, currentClaudeSessionId: FIXTURE_SESSION_ID });
    expect(active?.items[0]?.status).toBe('active');

    const cleared = tracker.applyAttachment(parse('cleared.jsonl'), { updatedAt: 2, currentClaudeSessionId: FIXTURE_SESSION_ID });
    expect(cleared?.items[0]?.status).toBe('cancelled');
  });

  it('drops events for a foreign session', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude' });
    const snapshot = tracker.applyAttachment(parse('edit-active.jsonl'), { updatedAt: 1, currentClaudeSessionId: 'other' });
    expect(snapshot).toBeNull();
  });
});

describe('createClaudeGoalStatusWorkStateTracker — interrupted-on-shutdown snapshot (G-6)', () => {
  it('republishes the ACTIVE goal with statusReason:interrupted (status stays active)', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', agentId: 'claude', goalCommandSupported: true });
    tracker.applyAttachment(parse('edit-active.jsonl'), { updatedAt: 1, currentClaudeSessionId: FIXTURE_SESSION_ID });

    const snapshot = tracker.buildInterruptedShutdownSnapshot({ updatedAt: 5, currentClaudeSessionId: FIXTURE_SESSION_ID });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.ownedSourceFamilies).toEqual([...CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES]);
    const item = snapshot?.items[0];
    expect(item).toMatchObject({
      id: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
      status: 'active',
      statusReason: 'interrupted',
    });
    // Preserves the goal's edit capability so the interrupted goal is still resumable.
    expect(item?.goalCapabilities).toMatchObject({ canEdit: true });
  });

  it('returns null when the latest goal is terminal (completed/cancelled — nothing to interrupt)', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', goalCommandSupported: true });
    tracker.applyAttachment(parse('completed.jsonl'), { updatedAt: 1, currentClaudeSessionId: FIXTURE_SESSION_ID });

    const snapshot = tracker.buildInterruptedShutdownSnapshot({ updatedAt: 5, currentClaudeSessionId: FIXTURE_SESSION_ID });
    expect(snapshot).toBeNull();
  });

  it('returns null when no goal was ever observed', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude' });
    expect(tracker.buildInterruptedShutdownSnapshot({ updatedAt: 5 })).toBeNull();
  });
});

describe('createClaudeGoalStatusWorkStateTracker — live usage accumulation for active goals (G-3/E)', () => {
  function activeTracker() {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', agentId: 'claude', goalCommandSupported: true });
    tracker.applyAttachment(parse('edit-active.jsonl'), { updatedAt: 1, currentClaudeSessionId: FIXTURE_SESSION_ID });
    return tracker;
  }

  it('folds per-turn tokens + elapsed wall-time into the ACTIVE goal item on a turn boundary', () => {
    const tracker = activeTracker();

    const snapshot = tracker.foldActiveGoalUsage({
      updatedAt: 10,
      currentClaudeSessionId: FIXTURE_SESSION_ID,
      addTokens: 1200,
      timeUsedSeconds: 30,
    });

    expect(snapshot).not.toBeNull();
    const item = snapshot?.items[0];
    expect(item).toMatchObject({
      id: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
      status: 'active',
      tokensUsed: 1200,
      timeUsedSeconds: 30,
    });
    // Never marks an accumulating goal terminal or interrupted.
    expect(item?.statusReason).toBeUndefined();
  });

  it('accumulates tokens across successive turns (running total, not per-turn replace)', () => {
    const tracker = activeTracker();

    tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: FIXTURE_SESSION_ID, addTokens: 1000, timeUsedSeconds: 20 });
    const snapshot = tracker.foldActiveGoalUsage({ updatedAt: 20, currentClaudeSessionId: FIXTURE_SESSION_ID, addTokens: 500, timeUsedSeconds: 45 });

    expect(snapshot?.items[0]).toMatchObject({ tokensUsed: 1500, timeUsedSeconds: 45 });
  });

  it('returns null (no churn) when neither tokens nor elapsed changed since the last fold', () => {
    const tracker = activeTracker();

    tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: FIXTURE_SESSION_ID, addTokens: 1000, timeUsedSeconds: 20 });
    // A boundary with zero new tokens and unchanged elapsed produces no republish.
    const snapshot = tracker.foldActiveGoalUsage({ updatedAt: 20, currentClaudeSessionId: FIXTURE_SESSION_ID, addTokens: 0, timeUsedSeconds: 20 });

    expect(snapshot).toBeNull();
  });

  it('is a no-op (null) when the latest goal is terminal — completed/cancelled goals do not accumulate', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', goalCommandSupported: true });
    tracker.applyAttachment(parse('completed.jsonl'), { updatedAt: 1, currentClaudeSessionId: FIXTURE_SESSION_ID });

    const snapshot = tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: FIXTURE_SESSION_ID, addTokens: 1000, timeUsedSeconds: 20 });
    expect(snapshot).toBeNull();
  });

  it('provider totals WIN on met:true — a completing goal_status replaces the accumulated estimate', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', goalCommandSupported: true });
    tracker.applyAttachment(parse('edit-active.jsonl'), { updatedAt: 1, currentClaudeSessionId: FIXTURE_SESSION_ID });
    tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: FIXTURE_SESSION_ID, addTokens: 9999, timeUsedSeconds: 999 });

    // A completing attachment carrying authoritative provider totals must overwrite the accumulator.
    const base = parse('completed.jsonl');
    const completing = {
      ...base,
      uuid: 'complete-1',
      sourceSessionId: FIXTURE_SESSION_ID,
      attachment: { ...base.attachment, met: true, tokens: 42000, durationMs: 60000 },
    } as ReturnType<typeof parse>;
    const snapshot = tracker.applyAttachment(completing, { updatedAt: 20, currentClaudeSessionId: FIXTURE_SESSION_ID });

    expect(snapshot?.items[0]).toMatchObject({ status: 'complete', tokensUsed: 42000, timeUsedSeconds: 60 });
  });

  it('provider totals WIN even after a reseed floor — a completing goal is not inflated by the floor', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', goalCommandSupported: true });
    tracker.applyAttachment(parse('edit-active.jsonl'), { updatedAt: 1, currentClaudeSessionId: FIXTURE_SESSION_ID });
    tracker.reseedActiveGoalUsage({ tokensUsed: 5000, timeUsedSeconds: 120 });
    tracker.foldActiveGoalUsage({ updatedAt: 5, currentClaudeSessionId: FIXTURE_SESSION_ID, addTokens: 100, timeUsedSeconds: 125 });

    const base = parse('completed.jsonl');
    const completing = {
      ...base,
      uuid: 'complete-floor',
      sourceSessionId: FIXTURE_SESSION_ID,
      attachment: { ...base.attachment, met: true, tokens: 7000, durationMs: 130000 },
    } as ReturnType<typeof parse>;
    const snapshot = tracker.applyAttachment(completing, { updatedAt: 20, currentClaudeSessionId: FIXTURE_SESSION_ID });

    expect(snapshot?.items[0]).toMatchObject({ status: 'complete', tokensUsed: 7000, timeUsedSeconds: 130 });
  });

  it('reseeds the accumulator from an already-published active goal item (restart continuity)', () => {
    const tracker = activeTracker();
    // Simulate a restart where the last published active goal already carried usage.
    tracker.reseedActiveGoalUsage({ tokensUsed: 5000, timeUsedSeconds: 120 });

    const snapshot = tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: FIXTURE_SESSION_ID, addTokens: 300, timeUsedSeconds: 130 });
    expect(snapshot?.items[0]).toMatchObject({ tokensUsed: 5300, timeUsedSeconds: 130 });
  });
});

describe('claudeGoalStatus goal-control epoch (G2 — replaces clearedCondition)', () => {
  function event(params: Readonly<{ uuid: string; condition: string; met?: boolean; sentinel?: boolean }>) {
    const parsed = parseClaudeGoalStatusAttachment({
      type: 'attachment',
      uuid: params.uuid,
      sessionId: FIXTURE_SESSION_ID,
      timestamp: '2026-06-19T14:39:26.067Z',
      attachment: {
        type: 'goal_status',
        met: params.met ?? false,
        condition: params.condition,
        ...(params.sentinel !== undefined ? { sentinel: params.sentinel } : {}),
      },
    });
    if (!parsed) throw new Error('inline goal_status did not parse');
    return parsed;
  }

  function newTracker() {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', goalCommandSupported: true });
    return tracker;
  }

  const apply = (tracker: ReturnType<typeof newTracker>, ev: ReturnType<typeof event>, updatedAt: number) =>
    tracker.applyAttachment(ev, { updatedAt, currentClaudeSessionId: FIXTURE_SESSION_ID });

  it('suppresses the stale ACTIVE re-evaluation of a cleared goal (same objective, fresh uuid)', () => {
    const tracker = newTracker();
    expect(apply(tracker, event({ uuid: 'g-1', condition: 'ship it' }), 1)?.items[0]?.status).toBe('active');

    tracker.recordGoalControlIntent({ kind: 'clear' });
    // Provider keeps re-evaluating the un-meetable cleared goal as ACTIVE with a fresh uuid.
    expect(apply(tracker, event({ uuid: 'g-2', condition: 'ship it' }), 2)).toBeNull();
    expect(apply(tracker, event({ uuid: 'g-3', condition: 'ship it' }), 3)).toBeNull();
  });

  it('allows clear -> set the SAME objective again (QA-CHIP-4 regression the old clearedCondition broke)', () => {
    const tracker = newTracker();
    apply(tracker, event({ uuid: 'g-1', condition: 'ship it' }), 1);
    tracker.recordGoalControlIntent({ kind: 'clear' });
    expect(apply(tracker, event({ uuid: 'g-2', condition: 'ship it' }), 2)).toBeNull();

    // The user re-sets the exact same objective via the chip → set intent → suppression lifts.
    tracker.recordGoalControlIntent({ kind: 'set' });
    const republished = apply(tracker, event({ uuid: 'g-3', condition: 'ship it' }), 3);
    expect(republished?.items[0]).toMatchObject({ status: 'active', title: 'ship it' });
  });

  it('allows clear -> set a DIFFERENT objective (the provider moving on lifts suppression too)', () => {
    const tracker = newTracker();
    apply(tracker, event({ uuid: 'g-1', condition: 'ship it' }), 1);
    tracker.recordGoalControlIntent({ kind: 'clear' });
    const next = apply(tracker, event({ uuid: 'g-2', condition: 'a different goal' }), 2);
    expect(next?.items[0]).toMatchObject({ status: 'active', title: 'a different goal' });
  });

  it('does not recreate a cancelled badge from a stale terminal sentinel after an app-driven clear', () => {
    const tracker = newTracker();
    apply(tracker, event({ uuid: 'g-1', condition: 'ship it' }), 1);
    tracker.recordGoalControlIntent({ kind: 'clear' });
    // A late terminal cleared/sentinel event for the already-removed goal must NOT resurrect a badge.
    expect(apply(tracker, event({ uuid: 'g-2', condition: 'ship it', met: true, sentinel: true }), 2)).toBeNull();
  });

  it('still publishes terminal completion for an active, non-cleared goal', () => {
    const tracker = newTracker();
    apply(tracker, event({ uuid: 'g-1', condition: 'ship it' }), 1);
    const completed = apply(tracker, event({ uuid: 'g-2', condition: 'ship it', met: true }), 2);
    expect(completed?.items[0]?.status).toBe('complete');
  });

  it('still dedupes a duplicate uuid', () => {
    const tracker = newTracker();
    expect(apply(tracker, event({ uuid: 'g-1', condition: 'ship it' }), 1)).not.toBeNull();
    expect(apply(tracker, event({ uuid: 'g-1', condition: 'ship it' }), 2)).toBeNull();
  });
});

describe('goal_status → router → work-state merge integration', () => {
  it('merges a goal item alongside a pre-existing todo/task family without clobbering it', async () => {
    const { routeClaudeAttachment } = await import('../attachments/claudeAttachmentRouter');
    const { mergeSessionWorkStateMetadataV1 } = await import('@/session/workState/sessionWorkStateMetadata');

    const tracker = createClaudeGoalStatusWorkStateTracker({
      backendId: 'claude',
      agentId: 'claude',
      goalCommandSupported: true,
    });

    // Pre-existing metadata already carries a Claude todo + task family.
    const metadata = {
      sessionWorkStateV1: {
        v: 1,
        backendId: 'claude',
        agentId: 'claude',
        updatedAt: 1,
        items: [
          { id: 'todo:derived:claude.todo:abc', kind: 'todo', origin: 'vendor', status: 'pending', title: 'A todo', updatedAt: 1 },
          { id: 'task:derived:claude.task:xyz', kind: 'task', origin: 'vendor', status: 'active', title: 'A task', updatedAt: 1 },
        ],
        primaryItemId: 'task:derived:claude.task:xyz',
      },
    };

    let merged: Record<string, unknown> = metadata;
    routeClaudeAttachment(readFixture('edit-active.jsonl'), {
      onGoalStatus: (event) => {
        const snapshot = tracker.applyAttachment(event, { updatedAt: 2, currentClaudeSessionId: FIXTURE_SESSION_ID });
        expect(snapshot).not.toBeNull();
        merged = mergeSessionWorkStateMetadataV1({
          metadata: merged,
          nextOwned: snapshot!,
          ownedSourceFamilies: [...CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES],
        });
      },
    });

    const items = (merged.sessionWorkStateV1 as { items: Array<{ id: string; kind: string; status: string }> }).items;
    const ids = items.map((item) => item.id);
    expect(ids).toContain('todo:derived:claude.todo:abc');
    expect(ids).toContain('task:derived:claude.task:xyz');
    const goal = items.find((item) => item.id === CLAUDE_GOAL_WORK_STATE_ITEM_ID);
    expect(goal).toMatchObject({ kind: 'goal', status: 'active' });
  });
});
