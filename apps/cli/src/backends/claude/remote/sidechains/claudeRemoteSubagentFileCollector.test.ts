import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, symlink, writeFile, appendFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { SDKAssistantMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { RawJSONLines } from '@/backends/claude/types';

import { ClaudeRemoteSubagentFileCollector } from './claudeRemoteSubagentFileCollector';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, opts?: { timeoutMs?: number; intervalMs?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const intervalMs = opts?.intervalMs ?? 10;
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await delay(intervalMs);
    }
  }
}

function taskToolUseMessage(): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool_task_1', name: 'Task', input: { prompt: 'do work' } }],
    },
    parent_tool_use_id: null,
    session_id: 'sess_1',
  } as any;
}

function taskToolResultMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool_task_1', content }],
    },
    parent_tool_use_id: null,
    session_id: 'sess_1',
  } as any;
}

function makeJsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

describe('ClaudeRemoteSubagentFileCollector', () => {
  it('imports agent-team subagent JSONL records as sidechains keyed by the Agent tool_use id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-agent-team-sidechains-'));
    const agentId = 'Alpha@team-test';
    const jsonlPath = join(dir, `agent-hash.jsonl`);

    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'from alpha' }] },
    };

    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ agentId: id }) => (id === agentId ? jsonlPath : null),
    });

    try {
      collector.observe({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_agent_1', name: 'Agent', input: { team_name: 'team-test', name: 'Alpha' } }],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      collector.observe({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_agent_1', content: 'Spawned.' }],
        },
        tool_use_result: { status: 'teammate_spawned', agent_id: agentId, team_name: 'team-test', name: 'Alpha' },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();

      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_agent_1');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        claudeAgentId: agentId,
        sidechainId: 'tool_agent_1',
      });
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('imports agent-team subagent JSONL when Agent tool_result omits agent_id but tool_use input includes team/name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-agent-team-sidechains-'));
    const agentId = 'Alpha@team-test';
    const jsonlPath = join(dir, `agent-hash.jsonl`);

    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'from alpha without tool_use_result id' }] },
    };

    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ agentId: id }) => (id === agentId ? jsonlPath : null),
    });

    try {
      collector.observe({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_agent_2', name: 'Agent', input: { team_name: 'team-test', name: 'Alpha' } }],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      collector.observe({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_agent_2', content: 'Agent is now running and will receive instructions via mailbox.' }],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();

      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_agent_2');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        claudeAgentId: agentId,
        sidechainId: 'tool_agent_2',
      });
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('imports live Agent subagent JSONL from metadata before the parent Agent tool_result arrives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-agent-team-sidechains-'));
    const jsonlPath = join(dir, 'agent-live.jsonl');

    const a1 = {
      type: 'assistant',
      uuid: 'a_live_1',
      isSidechain: true,
      agentId: 'agent-live',
      message: { role: 'assistant', content: [{ type: 'text', text: 'live sidechain row' }] },
    };

    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ sidechainId }) => (sidechainId === 'tool_agent_live' ? jsonlPath : null),
    });

    try {
      collector.observe({
        type: 'system',
        subtype: 'session_start',
        session_id: 'sess_1',
      } as any);
      collector.observe({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_agent_live',
              name: 'Agent',
              input: {
                description: 'Audit socket trust & reconnect catch-up',
                subagent_type: 'general-purpose',
                prompt: 'inspect the system',
              },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();

      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.uuid).toBe('a_live_1');
      expect(imported[0]?.body?.sidechainId).toBe('tool_agent_live');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        claudeAgentId: 'tool_agent_live',
        sidechainId: 'tool_agent_live',
      });
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('imports subagent JSONL file records as sidechains keyed by the Task tool_use id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'aa5e728';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    const outputSymlinkPath = join(dir, `${agentId}.output`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u1',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([rootPrompt, a1]), 'utf8');
    await symlink(jsonlPath, outputSymlinkPath);

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
    });

    try {
      collector.observe(taskToolUseMessage());
      collector.observe(
        taskToolResultMessage(
          `Async agent launched successfully.\nagentId: ${agentId}\noutput_file: ${outputSymlinkPath}\n`,
        ),
      );

      await collector.syncAll();

      // Root prompt should be skipped (we insert our own synthetic prompt root for Task sidechains).
      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        claudeAgentId: agentId,
        sidechainId: 'tool_task_1',
      });

      // Idempotent.
      await collector.syncAll();
      expect(imported).toHaveLength(1);

      // Append new message and verify incremental import.
      const a2 = {
        type: 'assistant',
        uuid: 'a2',
        isSidechain: true,
        agentId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'more' }] },
      };
      await appendFile(jsonlPath, makeJsonl([a2]), 'utf8');
      await collector.syncAll();
      expect(imported).toHaveLength(2);
      expect(imported[1]?.body?.uuid).toBe('a2');
      expect(imported[1]?.body?.sidechainId).toBe('tool_task_1');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports source-keyed activity with provider task id candidates for imported subagent JSONL rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechain-activity-'));
    const agentId = 'aa5e728';
    const providerTaskId = 'background_task_1';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);

    const assistant = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([assistant]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const sourceActivity = vi.fn();
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      onSourceActivity: sourceActivity,
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ agentId: requested }) => (requested === agentId ? jsonlPath : null),
    });

    try {
      collector.observe(taskToolUseMessage());
      collector.observe({
        type: 'user',
        tool_use_result: {
          status: 'async_launched',
          isAsync: true,
          backgroundTaskId: providerTaskId,
          agentId,
          outputFile: jsonlPath,
        },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_task_1',
              content: 'Agent is now running and will receive instructions via mailbox.',
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();

      expect(imported).toHaveLength(1);
      expect(sourceActivity).toHaveBeenCalledWith({
        sidechainId: 'tool_task_1',
        agentId,
        providerTaskIds: [providerTaskId, agentId, 'tool_task_1'],
        resolvedJsonlPath: expect.stringContaining(`agent-${agentId}.jsonl`),
      });

      await collector.syncAll();
      expect(sourceActivity).toHaveBeenCalledTimes(1);
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not re-import historical sidechain rows when a followed JSONL file is replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-replaced-'));
    const agentId = 'aa5e728';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    const replacementPath = join(dir, `agent-${agentId}.replacement.jsonl`);
    const outputSymlinkPath = join(dir, `${agentId}.output`);
    const now = Date.now();

    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      timestamp: new Date(now).toISOString(),
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'initial' }] },
    };
    const oldReplay = {
      type: 'assistant',
      uuid: 'old-replay',
      timestamp: new Date(now - 120_000).toISOString(),
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'historical replay' }] },
    };
    const fresh = {
      type: 'assistant',
      uuid: 'fresh-after-replace',
      timestamp: new Date(now + 1_000).toISOString(),
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'fresh after replace' }] },
    };

    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');
    await symlink(jsonlPath, outputSymlinkPath);

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
    });

    try {
      collector.observe(taskToolUseMessage());
      collector.observe(
        taskToolResultMessage(
          `Async agent launched successfully.\nagentId: ${agentId}\noutput_file: ${outputSymlinkPath}\n`,
        ),
      );

      await collector.syncAll();
      expect(imported.map((entry) => entry.body.uuid)).toEqual(['a1']);

      await writeFile(replacementPath, makeJsonl([oldReplay, fresh]), 'utf8');
      await rename(replacementPath, jsonlPath);

      await collector.syncAll();
      expect(imported.map((entry) => entry.body.uuid)).toEqual(['a1', 'fresh-after-replace']);
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('final-drains and stops Task sidechain followers after completion grace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-complete-'));
    const agentId = 'aa5e728';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    const outputSymlinkPath = join(dir, `${agentId}.output`);
    const stopWatcher = vi.fn();

    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
    };
    const a2 = {
      type: 'assistant',
      uuid: 'a2',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] },
    };

    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');
    await symlink(jsonlPath, outputSymlinkPath);

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => stopWatcher,
      followPolicy: { sidechainCompletionGraceMs: 1_000 },
    });

    try {
      collector.observe(taskToolUseMessage());
      collector.observe(
        taskToolResultMessage(
          `Async agent completed successfully.\nagentId: ${agentId}\noutput_file: ${outputSymlinkPath}\n`,
        ),
      );

      await collector.syncAll();
      expect(imported.map((entry) => entry.body.uuid)).toEqual(['a1']);

      await appendFile(jsonlPath, makeJsonl([a2]), 'utf8');

      await waitFor(() => {
        expect(imported.map((entry) => entry.body.uuid)).toEqual(['a1', 'a2']);
        expect(stopWatcher).toHaveBeenCalledTimes(1);
      });
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves subagent JSONL from tool_use_result.agent_id when agentId/output_file are missing from Task tool_result text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'a030eff830514eadc';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);

    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };
    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ agentId: requested }) => (requested === agentId ? jsonlPath : null),
    });

    try {
      collector.observe(taskToolUseMessage());
      collector.observe({
        type: 'user',
        tool_use_result: { status: 'teammate_spawned', agent_id: agentId, team_name: 'probe', name: 'researcher' },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_task_1',
              content: 'Agent is now running and will receive instructions via mailbox.',
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();
      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        claudeAgentId: agentId,
        sidechainId: 'tool_task_1',
      });
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to resolving subagent JSONL from agentId when output_file is missing (using system session_id)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'a6ca4a6';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u_root',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([rootPrompt, a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const resolvedSessionIds: Array<string | null> = [];

    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ claudeSessionId }) => {
        resolvedSessionIds.push(claudeSessionId);
        return jsonlPath;
      },
    });

    try {
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      collector.observe(taskToolUseMessage());
      collector.observe(taskToolResultMessage(`done\nagentId: ${agentId}\n`));

      await collector.syncAll();

      expect(resolvedSessionIds).toContain('sess_1');
      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('registers and imports subagent JSONL after session_id becomes available (late session init)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'a6ca4a6';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u_root_late',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const a1 = {
      type: 'assistant',
      uuid: 'a1_late',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([rootPrompt, a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const resolvedSessionIds: Array<string | null> = [];

    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ claudeSessionId }) => {
        resolvedSessionIds.push(claudeSessionId);
        return claudeSessionId === 'sess_1' ? jsonlPath : null;
      },
    });

    try {
      const toolUse = taskToolUseMessage();
      (toolUse as any).session_id = undefined;
      collector.observe(toolUse as any);

      const toolResult = taskToolResultMessage(`done\nagentId: ${agentId}\n`);
      (toolResult as any).session_id = undefined;
      collector.observe(toolResult as any);

      // No session_id yet, should not import.
      await collector.syncAll();
      expect(imported).toHaveLength(0);

      // Later: system init provides session_id.
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      await collector.syncAll();

      expect(resolvedSessionIds).toContain('sess_1');
      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses toolUseResult.agentId when agentId is missing from Task tool_result text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'a6ca4a6';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u_root2',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([rootPrompt, a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: () => jsonlPath,
    });

    try {
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      collector.observe(taskToolUseMessage());
      collector.observe({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_task_1', content: 'done' }],
        },
        toolUseResult: { status: 'completed', agentId },
      } as any);

      await collector.syncAll();

      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
