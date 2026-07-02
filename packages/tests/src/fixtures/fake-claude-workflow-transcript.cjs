/**
 * Fake Claude Dynamic Workflow transcript builder (T2).
 *
 * Builds the exact Claude-native transcript records the live workflow ACTIVITY source consumes off
 * the raw transcript channel (`observeRaw` -> `createClaudeWorkflowActivitySource`):
 *   - a `Workflow {script}` assistant tool_use that STARTS an explicit run,
 *   - a `task_started` system event with `task_type: "local_workflow"`,
 *   - one or more `task_progress` system events carrying `workflow_progress[]` with
 *     `workflow_phase` + `workflow_agent` rows (the ordered phase/agent structure), and
 *   - a terminal `task_updated`/`task_notification` carrying the final run status.
 *
 * It is a pure builder: the harness stamps each record with the live Claude `session_id` (so the
 * source's foreign-session guard accepts them) and appends them to the native transcript file the
 * launcher's scanner tails. The same shapes are exercised by the CWF1 unit fixtures
 * (`apps/cli/src/backends/claude/workflows/__fixtures__/`); this module mirrors them so the e2e
 * drives the real wired runtime, not a parallel parser.
 *
 * The named presets cover the T2 scenario matrix:
 *   - `success`          three phases, all agents complete, run completes
 *   - `progress`         a mid-run progress snapshot (one phase, mixed running/done agents)
 *   - `failure`          a failed agent + a `failed` terminal run status
 *   - `stopped`          a `stopped`/cancelled terminal run status
 *   - `no-phase`         a flat run with agents but no `workflow_phase` rows
 *   - `long-preview`     an agent with a very long `resultPreview` (truncation source)
 *   - `concurrent`       TWO independent Workflow runs with interleaved progress
 */

const { randomUUID } = require('node:crypto');

const LONG_PREVIEW = `${'x'.repeat(600)} END_OF_LONG_PREVIEW`;

function agentRow(params) {
  const row = {
    type: 'workflow_agent',
    index: params.index,
    label: params.label,
    agentId: params.agentId,
    model: params.model || 'claude-opus-4-8[1m]',
    state: params.state,
    attempt: 1,
    tokens: params.tokens ?? 9000,
    toolCalls: params.toolCalls ?? 2,
    durationMs: params.durationMs ?? 1100,
  };
  if (params.phaseIndex !== undefined) row.phaseIndex = params.phaseIndex;
  if (params.phaseTitle) row.phaseTitle = params.phaseTitle;
  if (params.resultPreview) row.resultPreview = params.resultPreview;
  return row;
}

function phaseRow(index, title) {
  return { type: 'workflow_phase', index, title };
}

/**
 * Build the ordered list of records for one workflow run. Records are returned WITHOUT a
 * `session_id`/`uuid`; the harness stamps those (the live session id is the foreign-source guard).
 */
function buildWorkflowRunRecords(run) {
  const records = [];
  const toolUseId = run.toolUseId;
  const taskId = run.taskId;
  const title = run.title;

  // 1) The `Workflow {script}` assistant tool_use that starts the explicit run.
  records.push({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      model: 'claude-opus-4-8[1m]',
      id: `msg_${toolUseId}`,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Workflow',
          input: { script: `export const meta = { name: '${title}' }` },
          caller: { type: 'direct' },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 80 },
    },
  });

  // 2) `task_started` (task_type: local_workflow) — establishes the run as a Dynamic Workflow.
  records.push({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: title,
    task_type: 'local_workflow',
    workflow_name: title,
  });

  // 3) progress snapshots carrying workflow_progress[] (phases + agents).
  for (const progress of run.progress) {
    const record = {
      type: 'system',
      subtype: 'task_progress',
      task_id: taskId,
      tool_use_id: toolUseId,
      description: progress.description || title,
      usage: progress.usage || { total_tokens: 18000, tool_uses: 3, duration_ms: 2200 },
      workflow_progress: progress.workflowProgress,
    };
    records.push(record);
  }

  // 4) terminal lifecycle: `task_updated` carries the final status; `task_notification` confirms.
  if (run.terminal) {
    records.push({
      type: 'system',
      subtype: 'task_updated',
      task_id: taskId,
      patch: { status: run.terminal.status, end_time: run.terminal.endTime ?? Date.now() },
    });
    records.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: toolUseId,
      status: run.terminal.status,
      summary: run.terminal.summary || `Dynamic workflow "${title}" ${run.terminal.status}`,
      usage: run.terminal.usage || { total_tokens: 120500, tool_uses: 14, duration_ms: 18750 },
    });
  }

  return records;
}

function makeRun(params) {
  return {
    toolUseId: params.toolUseId,
    taskId: params.taskId,
    title: params.title,
    progress: params.progress,
    ...(params.terminal ? { terminal: params.terminal } : {}),
  };
}

/** The three-phase, six-agent "success" run (mirrors the CWF1 dynamic fixture, all complete). */
function successProgress(allDone) {
  const research = [
    agentRow({ index: 1, label: 'web_search', agentId: 'agent_1', phaseIndex: 1, phaseTitle: 'Research', state: allDone ? 'done' : 'done', tokens: 9000, toolCalls: 2, resultPreview: 'Found 3 relevant prior art references.' }),
    agentRow({ index: 2, label: 'doc_reader', agentId: 'agent_2', phaseIndex: 1, phaseTitle: 'Research', state: allDone ? 'done' : 'running', tokens: 11000, toolCalls: 2, resultPreview: allDone ? 'Summarized the existing module contracts.' : undefined }),
  ];
  if (!allDone) {
    return [
      { description: 'Research: web_search', workflowProgress: [phaseRow(1, 'Research'), ...research] },
    ];
  }
  const all = [
    phaseRow(1, 'Research'),
    phaseRow(2, 'Implementation'),
    phaseRow(3, 'Review'),
    ...research,
    agentRow({ index: 3, label: 'coder', agentId: 'agent_3', phaseIndex: 2, phaseTitle: 'Implementation', state: 'done', tokens: 42000, toolCalls: 6, durationMs: 8200, resultPreview: 'Implemented the feature behind a flag.' }),
    agentRow({ index: 4, label: 'refactorer', agentId: 'agent_4', phaseIndex: 2, phaseTitle: 'Implementation', state: 'done', tokens: 21000, toolCalls: 3, durationMs: 4100, resultPreview: 'Extracted the shared helper.' }),
    agentRow({ index: 5, label: 'reviewer', agentId: 'agent_5', phaseIndex: 3, phaseTitle: 'Review', state: 'done', tokens: 18500, toolCalls: 1, durationMs: 2300, resultPreview: 'Approved with minor comments.' }),
    agentRow({ index: 6, label: 'tester', agentId: 'agent_6', phaseIndex: 3, phaseTitle: 'Review', state: 'done', tokens: 19000, toolCalls: 2, durationMs: 1150, resultPreview: 'All integration tests passed.' }),
  ];
  return [{ description: 'Review: tester', workflowProgress: all }];
}

/** Build the record set for a named preset. Returns `{ runs: [{ toolUseId, taskId, records }] }`. */
function buildWorkflowSpec(preset) {
  switch (preset) {
    case 'success': {
      return {
        runs: [
          buildRunOutput(makeRun({
            toolUseId: 'toolu_wf_success',
            taskId: 'w_success',
            title: 'ship-feature',
            progress: successProgress(true),
            terminal: { status: 'completed', summary: 'ship-feature completed' },
          })),
        ],
      };
    }
    case 'progress': {
      // Mid-run: ONE phase, agents still running. No terminal -> run stays active.
      return {
        runs: [
          buildRunOutput(makeRun({
            toolUseId: 'toolu_wf_progress',
            taskId: 'w_progress',
            title: 'research-task',
            progress: [
              {
                description: 'Research in progress',
                workflowProgress: [
                  phaseRow(1, 'Research'),
                  agentRow({ index: 1, label: 'web_search', agentId: 'agent_p1', phaseIndex: 1, phaseTitle: 'Research', state: 'done', resultPreview: 'Found references.' }),
                  agentRow({ index: 2, label: 'doc_reader', agentId: 'agent_p2', phaseIndex: 1, phaseTitle: 'Research', state: 'running' }),
                ],
              },
            ],
          })),
        ],
      };
    }
    case 'failure': {
      return {
        runs: [
          buildRunOutput(makeRun({
            toolUseId: 'toolu_wf_failure',
            taskId: 'w_failure',
            title: 'flaky-feature',
            progress: [
              {
                description: 'Review: tester',
                workflowProgress: [
                  phaseRow(1, 'Implementation'),
                  phaseRow(2, 'Review'),
                  agentRow({ index: 1, label: 'coder', agentId: 'agent_f1', phaseIndex: 1, phaseTitle: 'Implementation', state: 'done', resultPreview: 'Implemented.' }),
                  agentRow({ index: 2, label: 'tester', agentId: 'agent_f2', phaseIndex: 2, phaseTitle: 'Review', state: 'failed', resultPreview: '2 integration tests failed.' }),
                ],
              },
            ],
            terminal: { status: 'failed', summary: 'flaky-feature failed' },
          })),
        ],
      };
    }
    case 'stopped': {
      return {
        runs: [
          buildRunOutput(makeRun({
            toolUseId: 'toolu_wf_stopped',
            taskId: 'w_stopped',
            title: 'aborted-feature',
            progress: [
              {
                description: 'Implementation',
                workflowProgress: [
                  phaseRow(1, 'Implementation'),
                  agentRow({ index: 1, label: 'coder', agentId: 'agent_s1', phaseIndex: 1, phaseTitle: 'Implementation', state: 'cancelled' }),
                ],
              },
            ],
            terminal: { status: 'cancelled', summary: 'aborted-feature cancelled' },
          })),
        ],
      };
    }
    case 'no-phase': {
      // Flat run: agents but NO workflow_phase rows. The run is still an explicit Workflow run.
      return {
        runs: [
          buildRunOutput(makeRun({
            toolUseId: 'toolu_wf_flat',
            taskId: 'w_flat',
            title: 'flat-workflow',
            progress: [
              {
                description: 'Flat progress',
                workflowProgress: [
                  agentRow({ index: 1, label: 'alpha', agentId: 'agent_flat_1', state: 'done', resultPreview: 'alpha done' }),
                  agentRow({ index: 2, label: 'beta', agentId: 'agent_flat_2', state: 'done', resultPreview: 'beta done' }),
                ],
              },
            ],
            terminal: { status: 'completed', summary: 'flat-workflow completed' },
          })),
        ],
      };
    }
    case 'long-preview': {
      return {
        runs: [
          buildRunOutput(makeRun({
            toolUseId: 'toolu_wf_long',
            taskId: 'w_long',
            title: 'verbose-workflow',
            progress: [
              {
                description: 'Verbose progress',
                workflowProgress: [
                  phaseRow(1, 'Research'),
                  agentRow({ index: 1, label: 'verbose', agentId: 'agent_long_1', phaseIndex: 1, phaseTitle: 'Research', state: 'done', resultPreview: LONG_PREVIEW }),
                ],
              },
            ],
            terminal: { status: 'completed', summary: 'verbose-workflow completed' },
          })),
        ],
      };
    }
    case 'concurrent': {
      // TWO independent Workflow runs. The harness interleaves their records on emit.
      return {
        runs: [
          buildRunOutput(makeRun({
            toolUseId: 'toolu_wf_a',
            taskId: 'w_a',
            title: 'workflow-alpha',
            progress: [
              {
                description: 'Alpha research',
                workflowProgress: [
                  phaseRow(1, 'Research'),
                  agentRow({ index: 1, label: 'alpha_search', agentId: 'agent_a1', phaseIndex: 1, phaseTitle: 'Research', state: 'done', resultPreview: 'alpha found refs' }),
                  agentRow({ index: 2, label: 'alpha_coder', agentId: 'agent_a2', phaseIndex: 1, phaseTitle: 'Research', state: 'done', resultPreview: 'alpha implemented' }),
                ],
              },
            ],
            terminal: { status: 'completed', summary: 'workflow-alpha completed' },
          })),
          buildRunOutput(makeRun({
            toolUseId: 'toolu_wf_b',
            taskId: 'w_b',
            title: 'workflow-beta',
            progress: [
              {
                description: 'Beta implementation',
                workflowProgress: [
                  phaseRow(1, 'Implementation'),
                  agentRow({ index: 1, label: 'beta_coder', agentId: 'agent_b1', phaseIndex: 1, phaseTitle: 'Implementation', state: 'done', resultPreview: 'beta implemented' }),
                  agentRow({ index: 2, label: 'beta_tester', agentId: 'agent_b2', phaseIndex: 1, phaseTitle: 'Implementation', state: 'failed', resultPreview: 'beta tests failed' }),
                ],
              },
            ],
            terminal: { status: 'failed', summary: 'workflow-beta failed' },
          })),
        ],
      };
    }
    default:
      return { runs: [] };
  }
}

function buildRunOutput(run) {
  return {
    toolUseId: run.toolUseId,
    taskId: run.taskId,
    title: run.title,
    records: buildWorkflowRunRecords(run),
  };
}

module.exports = {
  buildWorkflowSpec,
  LONG_PREVIEW,
  randomRunId: () => `run_${randomUUID()}`,
};
