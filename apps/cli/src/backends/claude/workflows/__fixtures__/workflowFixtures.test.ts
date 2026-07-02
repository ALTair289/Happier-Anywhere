import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  SessionWorkflowRunSnapshotV1Schema,
  type SessionWorkflowAgentSnapshotV1,
  type SessionWorkflowPhaseSnapshotV1,
} from '@happier-dev/protocol';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

type JsonRecord = Record<string, unknown>;

function loadFixture(name: string): JsonRecord[] {
  const raw = readFileSync(join(FIXTURE_DIR, name), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

type WorkflowProgressEntry = JsonRecord & { type?: string };

function readWorkflowProgress(line: JsonRecord): WorkflowProgressEntry[] | undefined {
  const progress = line.workflow_progress;
  if (!Array.isArray(progress)) return undefined;
  return progress.filter(isRecord) as WorkflowProgressEntry[];
}

function findToolUse(lines: JsonRecord[], name: string): JsonRecord | undefined {
  for (const line of lines) {
    if (line.type !== 'assistant') continue;
    const message = line.message;
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && part.type === 'tool_use' && part.name === name) {
        return part;
      }
    }
  }
  return undefined;
}

function findLast(lines: JsonRecord[], predicate: (line: JsonRecord) => boolean): JsonRecord | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (predicate(lines[i])) return lines[i];
  }
  return undefined;
}

describe('dynamic workflow fixture (Research / Implementation / Review)', () => {
  const lines = loadFixture('dynamic-workflow-three-phases.jsonl');

  it('starts from a canonical Workflow tool call', () => {
    const workflowToolUse = findToolUse(lines, 'Workflow');
    expect(workflowToolUse).toBeDefined();
    expect(asString(workflowToolUse?.id)).toBe('toolu_wf');
    const input = workflowToolUse?.input;
    expect(isRecord(input) && typeof input.script === 'string').toBe(true);
  });

  it('correlates task lifecycle events to the workflow tool-use id via task_type local_workflow', () => {
    const taskStarted = lines.find((line) => line.subtype === 'task_started');
    expect(asString(taskStarted?.tool_use_id)).toBe('toolu_wf');
    expect(asString(taskStarted?.task_type)).toBe('local_workflow');
    expect(asString(taskStarted?.task_id)).toBe('w1');

    const notification = lines.find((line) => line.subtype === 'task_notification');
    expect(asString(notification?.tool_use_id)).toBe('toolu_wf');
    expect(asString(notification?.status)).toBe('completed');
  });

  it('carries ordered workflow_phase entries Research -> Implementation -> Review', () => {
    const finalProgress = findLast(lines, (line) => readWorkflowProgress(line) !== undefined);
    const entries = finalProgress ? readWorkflowProgress(finalProgress) : undefined;
    expect(entries).toBeDefined();
    const phaseTitles = (entries ?? [])
      .filter((entry) => entry.type === 'workflow_phase')
      .sort((a, b) => (asNumber(a.index) ?? 0) - (asNumber(b.index) ?? 0))
      .map((entry) => asString(entry.title));
    expect(phaseTitles).toEqual(['Research', 'Implementation', 'Review']);
  });

  it('assigns workflow_agent entries to phases via phaseIndex, including a failed agent', () => {
    const finalProgress = findLast(lines, (line) => readWorkflowProgress(line) !== undefined);
    const entries = (finalProgress ? readWorkflowProgress(finalProgress) : undefined) ?? [];
    const agents = entries.filter((entry) => entry.type === 'workflow_agent');
    expect(agents.length).toBe(6);
    // Every agent declares a phase membership.
    expect(agents.every((agent) => typeof asNumber(agent.phaseIndex) === 'number')).toBe(true);
    expect(agents.some((agent) => asString(agent.state) === 'failed')).toBe(true);
  });

  it('grounds the provider-agnostic SessionWorkflowRunSnapshotV1 contract', () => {
    // Test-only projection of the real wire shape into the protocol contract. This is NOT the
    // production normalizer (CWF2); it only proves the contract can represent the live shape.
    const finalProgress = findLast(lines, (line) => readWorkflowProgress(line) !== undefined);
    const entries = (finalProgress ? readWorkflowProgress(finalProgress) : undefined) ?? [];

    const phases: SessionWorkflowPhaseSnapshotV1[] = entries
      .filter((entry) => entry.type === 'workflow_phase')
      .map((entry) => {
        const index = asNumber(entry.index) ?? 0;
        return {
          id: `phase:${index}`,
          title: asString(entry.title),
          order: index,
          agentIds: entries
            .filter((agent) => agent.type === 'workflow_agent' && asNumber(agent.phaseIndex) === index)
            .map((agent) => asString(agent.agentId) ?? asString(agent.label) ?? 'unknown'),
        };
      });

    const stateToStatus: Record<string, SessionWorkflowAgentSnapshotV1['status']> = {
      done: 'complete',
      running: 'active',
      progress: 'active',
      failed: 'failed',
    };
    const agents: SessionWorkflowAgentSnapshotV1[] = entries
      .filter((entry) => entry.type === 'workflow_agent')
      .map((entry, i) => ({
        id: asString(entry.agentId) ?? asString(entry.label) ?? `agent_${i}`,
        title: asString(entry.label) ?? `agent_${i}`,
        status: stateToStatus[asString(entry.state) ?? ''] ?? 'unknown',
        phaseIndex: asNumber(entry.phaseIndex),
        phaseTitle: asString(entry.phaseTitle),
        model: asString(entry.model),
        resultPreview: asString(entry.resultPreview),
        tokensUsed: asNumber(entry.tokens),
        toolCalls: asNumber(entry.toolCalls),
        timeUsedSeconds: typeof asNumber(entry.durationMs) === 'number' ? (asNumber(entry.durationMs) ?? 0) / 1000 : undefined,
        updatedAt: 1000 + i,
      }));

    const parsed = SessionWorkflowRunSnapshotV1Schema.safeParse({
      v: 1,
      projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
      runId: 'wf_ship_feature',
      backendId: 'claude',
      workflowToolUseId: 'toolu_wf',
      sourceSessionId: 'claude-session-1',
      title: 'ship-feature',
      status: 'complete',
      recordRevision: '1',
      updatedAt: 2000,
      totalAgents: agents.length,
      completedAgents: agents.filter((a) => a.status === 'complete').length,
      failedAgents: agents.filter((a) => a.status === 'failed').length,
      phases,
      agents,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.phases.map((phase) => phase.title)).toEqual(['Research', 'Implementation', 'Review']);
    expect(parsed.data.agents).toHaveLength(6);
    expect(parsed.data.failedAgents).toBe(1);
  });
});

describe('plain task fixture (flat subagent, no workflow_progress)', () => {
  const lines = loadFixture('plain-task-no-workflow-progress.jsonl');

  it('uses a plain Task tool call, not a Workflow tool call', () => {
    expect(findToolUse(lines, 'Workflow')).toBeUndefined();
    expect(findToolUse(lines, 'Task')).toBeDefined();
  });

  it('emits task_progress WITHOUT a workflow_progress array so it is not a Dynamic Workflow', () => {
    const progressLines = lines.filter((line) => line.subtype === 'task_progress');
    expect(progressLines.length).toBeGreaterThan(0);
    expect(progressLines.every((line) => readWorkflowProgress(line) === undefined)).toBe(true);
    const taskStarted = lines.find((line) => line.subtype === 'task_started');
    expect(asString(taskStarted?.task_type)).not.toBe('local_workflow');
  });
});
