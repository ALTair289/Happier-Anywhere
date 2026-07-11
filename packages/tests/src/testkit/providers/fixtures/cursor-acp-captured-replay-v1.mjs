export const cursorCapturedReplayV1 = Object.freeze({
  v: 1,
  provenance: Object.freeze({
    happierSessionId: 'sanitized-real-session',
    cursorSessionId: 'sanitized-cursor-session',
    cursorVersion: '2026.07.09-a3815c0',
    sdkBasis: '0.14.1',
  }),
  capturedCardinality: Object.freeze({
    logicalCalls: 271,
    durableCallsBeforeFix: 302,
    providerResults: 270,
    duplicateCallIdsBeforeFix: 31,
    editLogicalCalls: 30,
    editDurableCallsBeforeFix: 60,
  }),
  representativeLifecycle: Object.freeze([
    Object.freeze({
      sessionUpdate: 'tool_call',
      toolCallId: 'captured-edit-001',
      status: 'pending',
      kind: 'edit',
      title: 'Edit fixture.txt',
      content: Object.freeze({ path: 'fixture.txt' }),
    }),
    Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'captured-edit-001',
      status: 'in_progress',
      kind: 'edit',
      title: 'Edit fixture.txt',
      content: Object.freeze({ path: 'fixture.txt', old_string: 'before', new_string: 'after' }),
      locations: Object.freeze([{ path: 'fixture.txt', line: 1 }]),
    }),
    Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'captured-edit-001',
      status: 'completed',
      kind: 'edit',
      title: 'Edit fixture.txt',
      content: Object.freeze({ path: 'fixture.txt', old_string: 'before', new_string: 'after' }),
      output: Object.freeze({ success: true }),
    }),
  ]),
  requiredFamilies: Object.freeze({
    lifecycle: Object.freeze(['sparse-enrichment', 'terminal-only', 'duplicate-terminal', 'failed', 'cancelled', 'late-after-close', 'replay-finalized']),
    cursorExtensions: Object.freeze(['ask-question', 'create-plan', 'update-todos-request', 'update-todos-notification', 'task', 'generate-image', 'list-available-models']),
    sessionProjection: Object.freeze(['aggregate-search', 'session-info', 'current-mode', 'empty-switch-mode', 'standard-plan']),
    outcomes: Object.freeze(['answered', 'skipped', 'cancelled', 'accepted', 'rejected']),
  }),
});

export function replayRepresentativeCursorLifecycle(sendUpdate) {
  for (const update of cursorCapturedReplayV1.representativeLifecycle) {
    sendUpdate(update);
  }
}
