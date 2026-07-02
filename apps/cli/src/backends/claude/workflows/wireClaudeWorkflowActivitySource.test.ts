import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';

import { wireClaudeWorkflowActivitySource, type ClaudeWorkflowActivitySessionBinding } from './wireClaudeWorkflowActivitySource';

function workflowToolUse(id: string, name: string) {
  return {
    type: 'assistant',
    session_id: 'claude-session-1',
    uuid: `uuid-${id}`,
    message: { content: [{ type: 'tool_use', id, name: 'Workflow', input: { script: `meta: { name: '${name}' }` } }] },
  };
}

describe('wireClaudeWorkflowActivitySource', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes the headline into metadata under the canonical key and commits a plain record', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };
    const upserts: unknown[] = [];
    const binding: ClaudeWorkflowActivitySessionBinding = {
      sessionId: 'sess',
      metadataWriter: {
        updateMetadata: (updater) => { metadata = updater(metadata); },
      },
      upsertSystemRecord: async (record) => { upserts.push(record); },
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    // Spy on the HTTP transport indirectly: route commit through a mocked module boundary by
    // observing the metadata write + that no throw occurs. The record path is covered by the
    // commit module's own test; here we assert the headline key + lazy encryption resolution.
    const resolveSpy = vi.spyOn(binding, 'resolveEncryption');

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', agentId: 'claude', binding });
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    await vi.advanceTimersByTimeAsync(0);
    // Allow the async commit + headline write to settle.
    await vi.runAllTimersAsync();

    expect(metadata).toHaveProperty('sessionWorkflowActivityHeadlineV1');
    const headline = (metadata as Record<string, unknown>).sessionWorkflowActivityHeadlineV1 as { activeRuns: { runId: string }[] };
    expect(headline.activeRuns.map((r) => r.runId)).toEqual(['toolu_wf']);
    expect(resolveSpy).toHaveBeenCalled();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:toolu_wf',
    });
  });

  it('resolves session encryption AT MOST ONCE across many record writes (bounded fetch)', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };
    let resolveCalls = 0;
    const upserts: unknown[] = [];
    const binding: ClaudeWorkflowActivitySessionBinding = {
      sessionId: 'sess',
      metadataWriter: { updateMetadata: (updater) => { metadata = updater(metadata); } },
      upsertSystemRecord: async (record) => { upserts.push(record); },
      // Stands in for a fetch-backed resolution that must NOT run per commit.
      resolveEncryption: async () => { resolveCalls += 1; return { mode: 'plain' }; },
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', binding });
    // Drive several distinct runs => several commitRecord calls.
    source.observeTranscriptMessage(workflowToolUse('toolu_a', 'a'));
    source.observeTranscriptMessage(workflowToolUse('toolu_b', 'b'));
    source.observeTranscriptMessage(workflowToolUse('toolu_c', 'c'));
    await vi.runAllTimersAsync();

    expect(upserts.length).toBeGreaterThanOrEqual(3);
    // Despite multiple record writes, the (potentially fetch-backed) resolution runs once.
    expect(resolveCalls).toBe(1);
    void metadata;
  });

  it('retries the workflow publish when the headline metadata write fails', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };
    let metadataAttempts = 0;
    const binding: ClaudeWorkflowActivitySessionBinding = {
      sessionId: 'sess',
      metadataWriter: {
        updateMetadata: async (updater) => {
          metadataAttempts += 1;
          if (metadataAttempts === 1) {
            throw new Error('metadata write failed');
          }
          metadata = updater(metadata);
        },
      },
      upsertSystemRecord: async () => {},
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', binding, debounceMs: 50 });
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));

    await vi.advanceTimersByTimeAsync(0);
    expect(metadata).not.toHaveProperty('sessionWorkflowActivityHeadlineV1');

    await vi.advanceTimersByTimeAsync(50);

    expect(metadataAttempts).toBeGreaterThanOrEqual(2);
    expect(metadata).toHaveProperty('sessionWorkflowActivityHeadlineV1');
  });

  it('prunes legacy async-Agent workflow ghosts from existing Claude metadata on startup', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
      sessionWorkflowActivityHeadlineV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 1000,
        primaryRunId: 'toolu_ghost_a',
        activeRuns: [
          {
            runId: 'toolu_ghost_a',
            workflowToolUseId: 'toolu_ghost_a',
            title: 'Workflow',
            status: 'active',
            updatedAt: 1000,
            recordRevision: '1',
            recordUpdatedAt: 1000,
            totalAgents: 0,
            completedAgents: 0,
          },
          {
            runId: 'toolu_ghost_b',
            workflowToolUseId: 'toolu_ghost_b',
            title: 'Workflow',
            status: 'active',
            updatedAt: 1001,
            recordRevision: '1',
            recordUpdatedAt: 1001,
            totalAgents: 0,
            completedAgents: 0,
          },
          {
            runId: 'toolu_real',
            workflowToolUseId: 'toolu_real',
            title: 'real workflow',
            status: 'active',
            updatedAt: 1002,
            recordRevision: '1',
            recordUpdatedAt: 1002,
            totalAgents: 2,
            completedAgents: 1,
          },
        ],
      },
    } as Metadata;
    const binding: ClaudeWorkflowActivitySessionBinding = {
      sessionId: 'sess',
      metadataWriter: {
        updateMetadata: (updater) => { metadata = updater(metadata); },
        getMetadataSnapshot: () => metadata,
      },
      upsertSystemRecord: async () => {},
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', binding });
    await vi.runAllTimersAsync();

    const headline = (metadata as Record<string, unknown>).sessionWorkflowActivityHeadlineV1 as { activeRuns: { runId: string }[]; primaryRunId: string | null };
    expect(headline.activeRuns.map((run) => run.runId)).toEqual(['toolu_real']);
    expect(headline.primaryRunId).toBe('toolu_real');

    source.dispose();
  });
});
