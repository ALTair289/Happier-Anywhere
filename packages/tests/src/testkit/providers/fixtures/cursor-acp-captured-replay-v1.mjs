function freezeEvents(events) {
  return Object.freeze(events.map((event) => Object.freeze(event)));
}

function addResultBearingCall(events, params) {
  events.push({
    sessionUpdate: 'tool_call',
    toolCallId: params.toolCallId,
    status: 'in_progress',
    kind: params.kind,
    title: params.title,
    content: Object.freeze(params.input),
  });
  if (params.enrichment) {
    events.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: 'in_progress',
      kind: params.kind,
      title: params.title,
      content: Object.freeze(params.enrichment),
    });
  }
  events.push({
    sessionUpdate: 'tool_call_update',
    toolCallId: params.toolCallId,
    status: params.status ?? 'completed',
    kind: params.kind,
    title: params.title,
    rawOutput: Object.freeze(params.output),
    ...(params.meta ? { meta: Object.freeze(params.meta) } : {}),
    ...(params.rawToolName ? { _toolName: params.rawToolName } : {}),
  });
  if (params.duplicateTerminal) {
    events.push({ ...events[events.length - 1] });
  }
}

// First-occurrence logical tool order re-derived from all 572 stored tool rows through
// Happier session.events.get on 2026-07-11. Characters: c=change_title, m=switch_mode,
// r=Read, s=CodeSearch, b=Bash, e=Edit, o=Cursor task/create-plan.
const capturedLogicalToolOrder = 'cmrrrrrsrsssrrrssrsssssssssbrrrrrrsbsssssbbsssrrrsbbbsssrrrsbrsrrbrsrrssssrrsreesrsbsrersebebbssrrrsrrrssrrrsrrssssrrrrrreeebreeeesessseebbssbbbbbbrbbssbrsbbrsrsorssssrssrsssrrsrsrrebreeberebebbbbborssrebesrebebbbbbebrssrsebbbrboeebebobbbbbbbbssrrrssrroosssrrrrrrsrssrrmo';

function buildFullCapturedLifecycle() {
  const events = [];
  const counters = { c: 0, m: 0, r: 0, s: 0, b: 0, e: 0, o: 0 };

  for (const family of capturedLogicalToolOrder) {
    counters[family] += 1;
    const index = counters[family];
    const suffix = String(index).padStart(3, '0');
    if (family === 'c') {
      addResultBearingCall(events, {
        toolCallId: 'captured-change-title-001',
        kind: 'change_title',
        title: 'Change title',
        input: { title: 'Sanitized explicit title' },
        output: { title: 'Sanitized explicit title' },
      });
    } else if (family === 'm') {
      addResultBearingCall(events, {
        toolCallId: `captured-switch-mode-${index}`,
        kind: 'switch_mode',
        title: 'Switch Mode',
        input: {},
        output: { currentModeId: index === 1 ? 'plan' : 'ask' },
      });
    } else if (family === 'r' && index === 1) {
      events.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'captured-read-001',
        status: 'completed',
        kind: 'read',
        title: 'Read sanitized-001.txt',
        rawOutput: Object.freeze({ path: 'sanitized-001.txt', text: 'sanitized' }),
      });
    } else if (family === 'r') {
      addResultBearingCall(events, {
        toolCallId: `captured-read-${suffix}`,
        kind: 'read',
        title: `Read sanitized-${suffix}.txt`,
        input: { path: `sanitized-${suffix}.txt` },
        output: { path: `sanitized-${suffix}.txt`, text: 'sanitized' },
        duplicateTerminal: index === 2,
      });
    } else if (family === 's') {
      addResultBearingCall(events, {
        toolCallId: `captured-search-${suffix}`,
        kind: 'search',
        title: `Search sanitized query ${suffix}`,
        input: { query: `sanitized-${suffix}` },
        output: { totalMatches: index % 5, truncated: index % 11 === 0 },
      });
    } else if (family === 'b') {
      addResultBearingCall(events, {
        toolCallId: `captured-bash-${suffix}`,
        kind: 'execute',
        title: index === 57 ? 'Cancelled sanitized command' : `Run sanitized command ${suffix}`,
        input: { command: ['printf', suffix] },
        output: index === 56 ? { error: 'sanitized failure' } : index === 57 ? { cancelled: true } : { output: suffix },
        status: index >= 56 ? 'failed' : 'completed',
      });
    } else if (family === 'e') {
      addResultBearingCall(events, {
        toolCallId: `captured-edit-${suffix}`,
        kind: 'edit',
        title: `Edit sanitized-${suffix}.txt`,
        input: { path: `sanitized-${suffix}.txt` },
        enrichment: { path: `sanitized-${suffix}.txt`, old_string: 'before', new_string: 'after' },
        output: { success: true },
      });
    } else if (family === 'o' && index <= 6) {
      addResultBearingCall(events, {
        toolCallId: `captured-task-${suffix}`,
        kind: 'other',
        title: `Task ${index}`,
        input: { description: `Sanitized native task ${index}` },
        output: { description: `Sanitized native task ${index}`, durationMs: index * 100 },
        rawToolName: 'task',
        meta: { _toolName: 'task', subagentType: index === 1 ? 'explore' : 'custom' },
      });
    } else if (family === 'o') {
      events.push({
        sessionUpdate: 'tool_call',
        toolCallId: 'captured-create-plan-001',
        status: 'pending',
        kind: 'other',
        title: 'Create Plan',
        content: Object.freeze({ _toolName: 'createPlan' }),
      });
      events.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'captured-create-plan-001',
        status: 'in_progress',
        kind: 'other',
        title: 'Create Plan',
        _toolName: 'createPlan',
        meta: Object.freeze({ _toolName: 'createPlan' }),
        content: Object.freeze({ _toolName: 'createPlan' }),
      });
      events.push({
        sessionUpdate: 'plan',
        entries: Object.freeze([{ content: 'Review sanitized lifecycle evidence', status: 'pending' }]),
      });
    }
  }

  events.push({ sessionUpdate: 'session_info_update', title: 'Sanitized provider title', updatedAt: '2026-07-10T22:09:21.000Z' });
  events.push({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
  return freezeEvents(events);
}

const fullLifecycle = buildFullCapturedLifecycle();

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
  logicalToolOrderSignature: capturedLogicalToolOrder,
  fullLifecycle,
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
    Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'captured-terminal-only-001',
      status: 'completed',
      kind: 'read',
      title: 'Read fixture.txt',
      content: Object.freeze({ path: 'fixture.txt', text: 'sanitized' }),
    }),
    Object.freeze({
      sessionUpdate: 'tool_call',
      toolCallId: 'captured-duplicate-terminal-001',
      status: 'in_progress',
      kind: 'execute',
      title: 'Run sanitized command',
      content: Object.freeze({ command: ['printf', 'ok'] }),
    }),
    Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'captured-duplicate-terminal-001',
      status: 'completed',
      kind: 'execute',
      content: Object.freeze({ output: 'ok' }),
    }),
    Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'captured-duplicate-terminal-001',
      status: 'completed',
      kind: 'execute',
      content: Object.freeze({ output: 'ok' }),
    }),
    Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'captured-failed-001',
      status: 'failed',
      kind: 'execute',
      title: 'Run failing sanitized command',
      content: Object.freeze({ error: 'sanitized failure' }),
    }),
    Object.freeze({
      sessionUpdate: 'tool_call',
      toolCallId: 'captured-cancelled-001',
      status: 'pending',
      kind: 'execute',
      title: 'Cancelled before provider result',
      content: Object.freeze({ command: ['sleep', '1'] }),
    }),
    ...Array.from({ length: 6 }, (_, index) => Object.freeze({
      sessionUpdate: 'tool_call',
      toolCallId: `captured-task-${String(index + 1).padStart(3, '0')}`,
      status: 'in_progress',
      kind: 'other',
      title: `Task ${index + 1}`,
      content: Object.freeze({ description: `Sanitized native task ${index + 1}` }),
    })),
    ...Array.from({ length: 6 }, (_, index) => Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: `captured-task-${String(index + 1).padStart(3, '0')}`,
      status: 'completed',
      kind: 'other',
      title: `Task ${index + 1}`,
      _toolName: 'task',
      meta: Object.freeze({ _toolName: 'task', subagentType: index === 0 ? 'explore' : 'custom' }),
      content: Object.freeze({ description: `Sanitized native task ${index + 1}` }),
    })),
    Object.freeze({
      sessionUpdate: 'tool_call',
      toolCallId: 'captured-create-plan-001',
      status: 'pending',
      kind: 'other',
      title: 'Create Plan',
      content: Object.freeze({}),
    }),
    Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'captured-create-plan-001',
      status: 'in_progress',
      kind: 'other',
      title: 'Create Plan',
      _toolName: 'createPlan',
      meta: Object.freeze({ _toolName: 'createPlan' }),
      content: Object.freeze({}),
    }),
    Object.freeze({
      sessionUpdate: 'plan',
      entries: Object.freeze([
        Object.freeze({ content: 'Review sanitized lifecycle evidence', status: 'pending' }),
      ]),
    }),
    Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'captured-search-aggregate-001',
      status: 'completed',
      kind: 'search',
      title: 'Search sanitized workspace',
      content: Object.freeze({ totalMatches: 4, truncated: false }),
    }),
    Object.freeze({
      sessionUpdate: 'session_info_update',
      title: 'Sanitized provider title',
      updatedAt: '2026-07-10T22:09:21.000Z',
    }),
    Object.freeze({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
  ]),
  extensionContracts: Object.freeze({
    askQuestion: Object.freeze({
      request: Object.freeze({
        toolCallId: 'captured-question-001',
        questions: Object.freeze([
          Object.freeze({
            id: 'question-1',
            prompt: 'Choose sanitized options',
            allowMultiple: true,
            options: Object.freeze([
              Object.freeze({ id: 'a', label: 'Same label' }),
              Object.freeze({ id: 'b', label: 'Same label' }),
            ]),
          }),
          Object.freeze({ id: 'question-freeform', prompt: 'Enter sanitized text', allowFreeform: true, options: Object.freeze([]) }),
        ]),
      }),
      responses: Object.freeze([
        Object.freeze({
          outcome: Object.freeze({
            outcome: 'answered',
            answers: Object.freeze([
              Object.freeze({ questionId: 'question-1', selectedOptionIds: Object.freeze(['a', 'b']) }),
              Object.freeze({ questionId: 'question-freeform', selectedOptionIds: Object.freeze([]), freeformText: 'sanitized answer' }),
            ]),
          }),
        }),
        Object.freeze({ outcome: Object.freeze({ outcome: 'skipped', reason: 'sanitized' }) }),
        Object.freeze({ outcome: Object.freeze({ outcome: 'cancelled' }) }),
      ]),
      fallbackTrigger: Object.freeze({ code: -32601, message: 'Method not found' }),
      malformedCases: Object.freeze(['duplicate-question-id', 'missing-question-id', 'missing-option-id', 'oversized-text']),
    }),
    createPlan: Object.freeze({
      request: Object.freeze({
        toolCallId: 'captured-create-plan-001',
        name: 'Sanitized plan',
        plan: '# Sanitized plan\n\n1. Review lifecycle evidence.',
        todos: Object.freeze([{ id: 'plan-1', content: 'Review lifecycle evidence', status: 'pending' }]),
        phases: Object.freeze([{ id: 'phase-1', name: 'Review', todoIds: Object.freeze(['plan-1']) }]),
        merge: false,
      }),
      responses: Object.freeze([
        Object.freeze({ outcome: Object.freeze({ outcome: 'accepted', planUri: 'file:///sanitized/plan.md' }) }),
        Object.freeze({ outcome: Object.freeze({ outcome: 'rejected', reason: 'sanitized' }) }),
        Object.freeze({ outcome: Object.freeze({ outcome: 'cancelled' }) }),
      ]),
      fallbackTriggers: Object.freeze([
        Object.freeze({ code: -32601, message: 'Method not found' }),
        Object.freeze({ malformed: Object.freeze({ accepted: true }) }),
      ]),
      identicalRedeliveryCount: 2,
      arrivalOrders: Object.freeze(['standard-first', 'proprietary-first']),
    }),
    updateTodos: Object.freeze({
      forms: Object.freeze(['request', 'notification']),
      snapshots: Object.freeze([
        Object.freeze({ merge: false, todos: Object.freeze([{ id: 'todo-1', content: 'First', status: 'inProgress' }]) }),
        Object.freeze({ merge: true, todos: Object.freeze([{ id: 'todo-1', content: 'First', status: 'completed' }, { id: 'todo-2', content: 'Second', status: 'pending' }]) }),
        Object.freeze({ merge: false, todos: Object.freeze([]) }),
      ]),
    }),
    availableModels: Object.freeze({
      success: Object.freeze({
        models: Object.freeze([
          Object.freeze({
            value: 'cursor-default',
            name: 'Cursor Default',
            configOptions: Object.freeze([
              Object.freeze({
                id: 'reasoning',
                name: 'Reasoning',
                type: 'select',
                currentValue: 'medium',
                options: Object.freeze([{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }]),
              }),
            ]),
          }),
        ]),
      }),
      failures: Object.freeze(['method-not-found', 'malformed', 'timeout']),
    }),
    generatedImage: Object.freeze({
      toolCallId: 'captured-image-001',
      path: 'generated/sanitized.png',
      description: 'Sanitized generated image',
      negativeCases: Object.freeze(['missing', 'directory', 'traversal', 'symlink-escape', 'oversized', 'unsupported-mime', 'unsafe-url']),
    }),
    taskNotifications: Object.freeze(Array.from({ length: 6 }, (_, index) => Object.freeze({
      toolCallId: `captured-task-${String(index + 1).padStart(3, '0')}`,
      description: `Sanitized native task ${index + 1}`,
      prompt: `Sanitized prompt ${index + 1}`,
      subagentType: index === 0 ? 'explore' : index === 1 ? 'shell' : index === 2 ? 'browser' : index === 3 ? 'unspecified' : 'custom',
      ...(index % 2 === 0 ? { model: 'sanitized-model', agentId: `sanitized-agent-${index + 1}` } : {}),
      durationMs: (index + 1) * 100,
    }))),
    lateAfterTurnClose: Object.freeze({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'captured-edit-001',
      status: 'completed',
      kind: 'edit',
      content: Object.freeze({ ignoredLateMarker: true }),
    }),
    replayFinalized: Object.freeze({ toolCallIds: Object.freeze(['captured-edit-001', 'captured-duplicate-terminal-001']) }),
  }),
  legacyHistory: Object.freeze({
    rawRows: Object.freeze([
      Object.freeze({
        seq: 41,
        localId: null,
        content: Object.freeze({
          type: 'tool-call',
          id: 'legacy-body-sparse',
          callId: 'legacy-edit-001',
          name: 'other',
          input: Object.freeze({ path: 'legacy.txt' }),
        }),
      }),
      Object.freeze({
        seq: 42,
        localId: null,
        content: Object.freeze({
          type: 'tool-call',
          id: 'legacy-body-enriched',
          callId: 'legacy-edit-001',
          name: 'Edit',
          input: Object.freeze({ path: 'legacy.txt', old_string: 'before', new_string: 'after' }),
        }),
      }),
      Object.freeze({
        seq: 43,
        localId: null,
        content: Object.freeze({
          type: 'tool-result',
          id: 'legacy-result',
          callId: 'legacy-edit-001',
          name: 'Edit',
          output: Object.freeze({ success: true }),
        }),
      }),
    ]),
    expectedPresentation: Object.freeze({
      logicalCards: 1,
      callId: 'legacy-edit-001',
      name: 'Edit',
      resultRows: 1,
      rawCallRows: 2,
      serverWritesDuringProjection: 0,
    }),
  }),
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

export function replayFullCapturedCursorLifecycle(sendUpdate) {
  for (const update of fullLifecycle) {
    sendUpdate(update);
  }
}
