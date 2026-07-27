import { describe, expect, it } from 'vitest';

import { createOpenCodeForegroundToolTracker } from './createOpenCodeForegroundToolTracker';

type ToolPartLike = Parameters<ReturnType<typeof createOpenCodeForegroundToolTracker>['observeToolPart']>[0]['part'];

function toolPart(params: { sessionId: string; callId: string; status: string; tool?: string; messageId?: string }): ToolPartLike {
  return {
    sessionID: params.sessionId,
    callID: params.callId,
    messageID: params.messageId ?? 'msg_1',
    tool: params.tool ?? 'read',
    state: { status: params.status },
  } as unknown as ToolPartLike;
}

describe('createOpenCodeForegroundToolTracker generation awareness', () => {
  it('stamps the current generation key on observed live tool work', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');

    tracker.observeToolPart({ part: toolPart({ sessionId: 'ses_1', callId: 'call_1', status: 'running' }), source: 'live' });

    expect(tracker.hasActiveProviderWork()).toBe(true);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-A')).toBe(true);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-B')).toBe(false);

    const state = tracker.getProviderWorkState();
    expect(state.active).toBe(true);
    if (state.active) {
      expect(state.activeToolCalls[0]?.observedGenerationKey).toBe('gen-A');
      expect(typeof state.activeToolCalls[0]?.observedAtMs).toBe('number');
    }
  });

  it('clears terminal work regardless of generation when the call id matches', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');
    tracker.observeToolPart({ part: toolPart({ sessionId: 'ses_1', callId: 'call_1', status: 'running' }), source: 'live' });
    expect(tracker.hasActiveProviderWork()).toBe(true);

    // A terminal observation under a *different* generation still clears the matching call id.
    tracker.setObservedGenerationKey('gen-B');
    tracker.observeToolPart({ part: toolPart({ sessionId: 'ses_1', callId: 'call_1', status: 'completed' }), source: 'history' });
    expect(tracker.hasActiveProviderWork()).toBe(false);
  });

  it('treats orphaned old-generation work as not backed by the current generation', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');
    tracker.observeToolPart({ part: toolPart({ sessionId: 'ses_side', callId: 'call_orphan', status: 'running' }), source: 'live' });

    // Server generation replaced; new work observed under gen-B, orphan stays under gen-A.
    tracker.setObservedGenerationKey('gen-B');
    tracker.observeToolPart({ part: toolPart({ sessionId: 'ses_1', callId: 'call_new', status: 'running' }), source: 'live' });

    expect(tracker.hasActiveProviderWork()).toBe(true);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-A')).toBe(true);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-B')).toBe(true);

    // Clearing work not backed by gen-B removes only the orphan and reports it.
    const cleared = tracker.clearActiveWork({ reason: 'managed_server_generation_replaced', generationKey: 'gen-B' });
    expect(cleared.active).toBe(true);
    if (cleared.active) {
      expect(cleared.activeToolCalls.map((tool) => tool.callId)).toEqual(['call_orphan']);
    }
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-A')).toBe(false);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-B')).toBe(true);
  });

  it('clears all active work for turn_reset / provider_session_reset', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');
    tracker.observeToolPart({ part: toolPart({ sessionId: 'ses_1', callId: 'call_1', status: 'running' }), source: 'live' });
    tracker.observeToolPart({ part: toolPart({ sessionId: 'ses_1', callId: 'call_2', status: 'running' }), source: 'live' });

    const cleared = tracker.clearActiveWork({ reason: 'turn_reset' });
    expect(cleared.active).toBe(true);
    if (cleared.active) {
      expect(cleared.activeToolCallCount).toBe(2);
    }
    expect(tracker.hasActiveProviderWork()).toBe(false);
  });

  it('stamps session-next tool work with the current generation', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');
    tracker.observeSessionNextTool({ sessionId: 'ses_1', callId: 'call_1', terminal: false, source: 'session-next' });
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-A')).toBe(true);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-B')).toBe(false);
  });

  it('treats un-stamped work (observed before any generation was set) as live, never orphaned', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    // No setObservedGenerationKey: work observed before a generation baseline exists.
    tracker.observeToolPart({ part: toolPart({ sessionId: 'ses_1', callId: 'call_unstamped', status: 'running' }), source: 'live' });
    expect(tracker.hasActiveProviderWork()).toBe(true);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-A')).toBe(true);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-anything')).toBe(true);
  });
});
