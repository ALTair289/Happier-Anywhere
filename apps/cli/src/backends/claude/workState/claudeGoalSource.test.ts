import { describe, expect, it, vi } from 'vitest';

import type { SessionWorkStateV1 } from '@happier-dev/protocol';

import { createClaudeGoalWorkStateSource } from './claudeGoalSource';

const SOURCE_SESSION_ID = 'claude-source-session';

function activeGoalAttachment(params: Readonly<{ uuid: string; condition: string; sessionId?: string }>): unknown {
  return {
    type: 'attachment',
    uuid: params.uuid,
    sessionId: params.sessionId ?? SOURCE_SESSION_ID,
    timestamp: '2026-06-24T00:00:00.000Z',
    attachment: { type: 'goal_status', met: false, condition: params.condition },
  };
}

function completedGoalAttachment(params: Readonly<{ uuid: string; condition: string; sessionId?: string }>): unknown {
  return {
    type: 'attachment',
    uuid: params.uuid,
    sessionId: params.sessionId ?? SOURCE_SESSION_ID,
    timestamp: '2026-06-24T00:01:00.000Z',
    attachment: { type: 'goal_status', met: true, condition: params.condition },
  };
}

function systemInit(params: Readonly<{ slashCommands: readonly string[] }>): unknown {
  return { type: 'system', subtype: 'init', slash_commands: params.slashCommands };
}

function createSource() {
  const published: SessionWorkStateV1[] = [];
  let currentClaudeSessionId: string | null = SOURCE_SESSION_ID;
  const source = createClaudeGoalWorkStateSource({
    backendId: 'claude',
    agentId: 'claude',
    publishWorkStateSnapshot: (snapshot) => published.push(snapshot),
    getCurrentClaudeSessionId: () => currentClaudeSessionId,
  });
  return {
    source,
    published,
    setCurrentClaudeSessionId: (value: string | null) => {
      currentClaudeSessionId = value;
    },
  };
}

function goalItem(snapshot: SessionWorkStateV1) {
  return snapshot.items[0];
}

describe('createClaudeGoalWorkStateSource', () => {
  it('routes a goal_status attachment from a transcript message into a published active goal snapshot', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship the feature' }));

    expect(published).toHaveLength(1);
    expect(goalItem(published[0])).toMatchObject({
      id: 'goal:claude',
      kind: 'goal',
      status: 'active',
      title: 'ship the feature',
    });
  });

  it('derives goalCapabilities only after the system/init slash_commands include `goal` (fail-closed)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    expect(goalItem(published[0]).goalCapabilities).toBeUndefined();

    source.observeTranscriptMessage(systemInit({ slashCommands: ['goal', 'compact'] }));
    expect(published).toHaveLength(2);
    expect(goalItem(published[1]).goalCapabilities).toMatchObject({ canEdit: true, canClear: true });
  });

  it('also accepts slash_commands fed directly (remote onCapabilities seam)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.applySlashCommands(['goal']);

    expect(goalItem(published[published.length - 1]).goalCapabilities).toMatchObject({ canEdit: true, canClear: true });
  });

  // G1: the `goal`/`/goal` shape parity is owned by the shared protocol normalizer, so the
  // slash-prefixed command shape (the SDK-init shape happy already accepts) also enables capabilities.
  it('derives goalCapabilities from the slash-prefixed `/goal` command shape (G1 parity)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    expect(goalItem(published[0]).goalCapabilities).toBeUndefined();

    source.observeTranscriptMessage(systemInit({ slashCommands: ['/goal', 'compact'] }));
    expect(goalItem(published[published.length - 1]).goalCapabilities).toMatchObject({ canEdit: true, canClear: true });
  });

  it('transitions an active goal to complete on a met:true attachment', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.observeTranscriptMessage(completedGoalAttachment({ uuid: 'g-2', condition: 'ship it' }));

    expect(goalItem(published[published.length - 1])).toMatchObject({ status: 'complete' });
  });

  it('ignores goal_status attachments from a foreign source session (cross-session guard)', () => {
    const { source, published } = createSource();

    // Establish the channel's Claude session id first (a record carrying SOURCE_SESSION_ID), then a
    // foreign-session attachment must be rejected as cross-session contamination.
    source.observeTranscriptMessage(systemInit({ slashCommands: ['goal'] }));
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it', sessionId: 'other-session' }));

    expect(published).toHaveLength(0);
  });

  it('accepts goal_status whose sessionId matches the channel-established Claude id even when the injected getter returns a non-matching (Happier) id', () => {
    // Production reality: the launcher feeds the HAPPIER session id (e.g. `cmqs...`) into the getter,
    // which never equals the Claude transcript `sessionId` (`b27b...`). The source therefore learns
    // the Claude session id from the channel's establishing records (system/assistant/user) and
    // matches goal_status against THAT — otherwise EVERY goal_status is dropped (manual-QA-found
    // regression). The injected getter is only a pre-observation seed.
    const published: SessionWorkStateV1[] = [];
    const source = createClaudeGoalWorkStateSource({
      backendId: 'claude',
      agentId: 'claude',
      publishWorkStateSnapshot: (snapshot) => published.push(snapshot),
      // Happier session id, deliberately different from the transcript `sessionId`.
      getCurrentClaudeSessionId: () => 'cmqs-happier-session-id',
    });

    // An establishing record (a system record carrying the Claude transcript sessionId) precedes the
    // goal_status, exactly as on a real transcript channel.
    source.observeTranscriptMessage({ type: 'system', subtype: 'informational', sessionId: 'b27b-claude-session' });
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it', sessionId: 'b27b-claude-session' }));

    expect(published).toHaveLength(1);
    expect(goalItem(published[0])).toMatchObject({ status: 'active', title: 'ship it' });
  });

  it('accepts the FIRST goal_status when no Claude session id is established yet (guard no-op, mirrors happy)', () => {
    // If a goal_status is the first thing observed (no establishing record, getter returns the wrong
    // Happier id), the guard must be a no-op (accept) so the feature is not dead — matching happy,
    // whose guard is skipped while `claudeSessionId` is unknown.
    const published: SessionWorkStateV1[] = [];
    const source = createClaudeGoalWorkStateSource({
      backendId: 'claude',
      agentId: 'claude',
      publishWorkStateSnapshot: (snapshot) => published.push(snapshot),
      getCurrentClaudeSessionId: () => null,
    });

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it', sessionId: 'b27b-claude-session' }));

    expect(published).toHaveLength(1);
  });

  it('ignores non-goal transcript messages and unknown attachment subtypes', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage({ type: 'assistant', message: { content: [] } });
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'a-1',
      sessionId: SOURCE_SESSION_ID,
      attachment: { type: 'skill_listing' },
    });

    expect(published).toHaveLength(0);
  });

  it('does not republish for a duplicate goal_status uuid', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));

    expect(published).toHaveLength(1);
  });

  it('clearGoalWorkState publishes an empty goal snapshot (deterministic active-clear removal)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    expect(published[0].items).toHaveLength(1);

    source.clearGoalWorkState();

    const last = published[published.length - 1];
    expect(last.items).toHaveLength(0);
    expect(last.primaryItemId).toBeNull();
  });

  it('suppresses a just-cleared goal that Claude keeps re-evaluating as active (same condition)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'rewrite the kernel' }));
    source.clearGoalWorkState();
    const afterClear = published.length;
    // Claude re-evaluates the un-meetable goal as active AGAIN (distinct uuid, same condition): this
    // must NOT resurrect the badge the user just cleared.
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-2', condition: 'rewrite the kernel' }));

    expect(published).toHaveLength(afterClear);
    expect(published[afterClear - 1].items).toHaveLength(0);
  });

  it('re-publishes a DIFFERENT goal set after a clear (suppression is condition-scoped)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'rewrite the kernel' }));
    source.clearGoalWorkState();
    // A genuinely new goal (different condition) lifts the suppression and publishes normally.
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-2', condition: 'add tests' }));

    const last = published[published.length - 1];
    expect(last.items).toHaveLength(1);
    expect(goalItem(last)).toMatchObject({ status: 'active', title: 'add tests' });
  });

  it('recordGoalSetIntent re-publishes the SAME objective set after a clear (G2/QA-CHIP-4 live flow)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'rewrite the kernel' }));
    source.clearGoalWorkState();
    // Stale re-evaluation of the cleared goal is still suppressed.
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-2', condition: 'rewrite the kernel' }));
    const afterClear = published.length;
    expect(published[afterClear - 1].items).toHaveLength(0);

    // The user re-sets the EXACT same objective via the chip → the set effector records the intent →
    // the resulting active goal_status must publish (the old clearedCondition tombstone broke this).
    source.recordGoalSetIntent();
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-3', condition: 'rewrite the kernel' }));

    const last = published[published.length - 1];
    expect(last.items).toHaveLength(1);
    expect(goalItem(last)).toMatchObject({ status: 'active', title: 'rewrite the kernel' });
  });

  it('is robust to a publish callback that throws (best-effort)', () => {
    const publishWorkStateSnapshot = vi.fn(() => {
      throw new Error('publish failed');
    });
    const source = createClaudeGoalWorkStateSource({
      backendId: 'claude',
      agentId: 'claude',
      publishWorkStateSnapshot,
      getCurrentClaudeSessionId: () => SOURCE_SESSION_ID,
    });

    expect(() => source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }))).not.toThrow();
    expect(publishWorkStateSnapshot).toHaveBeenCalledTimes(1);
  });
});
