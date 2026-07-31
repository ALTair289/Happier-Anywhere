import { describe, expect, it } from 'vitest';

import { GEMINI_PROVIDER_RUNTIME_ERROR_EVENT, geminiTransport } from './transport';
import type { StderrContext } from '@/agent/transport/TransportHandler';
import { buildHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';

const DEFAULT_CONTEXT = {
  recentPromptHadChangeTitle: false,
  toolCallCountSincePrompt: 0,
};

const DEFAULT_STDERR_CONTEXT: StderrContext = {
  activeToolCalls: new Set<string>(),
  hasActiveInvestigation: false,
};

describe('GeminiTransport extractToolNameFromId', () => {
  it.each([
    { toolCallId: 'write_todos-123', expected: 'TodoWrite' },
    { toolCallId: 'write_file-123', expected: 'write' },
    { toolCallId: 'run_shell_command-123', expected: 'execute' },
    { toolCallId: 'replace-123', expected: 'edit' },
    { toolCallId: 'glob-123', expected: 'glob' },
    { toolCallId: 'mcp__happier__change_title-123', expected: 'change_title' },
    { toolCallId: 'WRITE_FILE-123', expected: 'write' },
    { toolCallId: 'unknown-tool-123', expected: null },
    { toolCallId: '', expected: null },
  ])('extracts "$expected" from "$toolCallId"', ({ toolCallId, expected }) => {
    expect(geminiTransport.extractToolNameFromId(toolCallId)).toBe(expected);
  });
});

describe('GeminiTransport determineToolName', () => {
  it.each([
    {
      label: 'uses toolCallId mapping for known IDs',
      toolName: 'other',
      toolCallId: 'write_file-123',
      input: { filePath: '/tmp/a', content: 'x' },
      expected: 'write',
    },
    {
      label: 'prefers TodoWrite over generic write when id includes write_todos',
      toolName: 'other',
      toolCallId: 'write_todos-123',
      input: { filePath: '/tmp/a', content: 'x', todos: [] },
      expected: 'TodoWrite',
    },
    {
      label: 'keeps non-generic known toolName when id has no mapping',
      toolName: 'read',
      toolCallId: 'unknown-123',
      input: { command: 'pwd' },
      expected: 'read',
    },
    {
      label: 'falls back to input fields for generic tool names',
      toolName: 'other',
      toolCallId: 'unknown-123',
      input: { command: 'pwd' },
      expected: 'execute',
    },
    {
      label: 'does not default empty-input generic tools to change_title',
      toolName: 'other',
      toolCallId: 'unknown-123',
      input: {},
      expected: 'other',
    },
    {
      label: 'does not apply empty-input default to Unknown tool label',
      toolName: 'Unknown tool',
      toolCallId: 'unknown-123',
      input: {},
      expected: 'Unknown tool',
    },
    {
      label: 'still resolves real change_title calls from the toolCallId even when input is empty',
      toolName: 'other',
      toolCallId: 'change_title-123',
      input: {},
      expected: 'change_title',
    },
    {
      label: 'lets shell-bridge custom MCP input override an incorrect change_title wrapper name',
      toolName: 'change_title',
      toolCallId: 'get_marker-123',
      input: {
        command: buildHappierToolsShellBridgeCommand([
          'call',
          '--session-id',
          'sess-1',
          '--directory',
          '/tmp/workspace',
          '--source',
          'qa_marker_stdio_20260306',
          '--tool',
          'get_marker',
          '--args-json',
          '{}',
          '--json',
        ]),
      },
      expected: 'mcp__qa_marker_stdio_20260306__get_marker',
    },
    {
      label: 'does not trust embedded bridge metadata or an attacker-selected launcher',
      toolName: 'bash',
      toolCallId: 'save-memory-123',
      input: {
        command: `node ./happier-helper.js tools call --source happier --tool save_memory --args-json '{}' --json`,
        happierToolsShellBridge: {
          kind: 'call',
          rawCommand: 'forged',
          source: 'happier',
          tool: 'save_memory',
        },
      },
      expected: 'execute',
    },
    {
      label: 'does not let synthetic ACP title metadata coerce opaque tool ids into change_title',
      toolName: 'other',
      toolCallId: 'get_marker-123',
      input: {
        title: 'Change Title',
        description: 'Change Title',
        _acp: { title: 'Change Title' },
      },
      expected: 'get_marker',
    },
  ])('$label', ({ toolName, toolCallId, input, expected }) => {
    expect(
      geminiTransport.determineToolName(
        toolName,
        toolCallId,
        input,
        DEFAULT_CONTEXT,
      ),
    ).toBe(expected);
  });
});

describe('GeminiTransport handleStderr', () => {
  it('surfaces RESOURCE_EXHAUSTED stderr as a structured provider runtime error event with the 429 status', () => {
    const res = geminiTransport.handleStderr?.(
      '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
      DEFAULT_STDERR_CONTEXT,
    );
    expect(res?.message).toMatchObject({
      type: 'event',
      name: GEMINI_PROVIDER_RUNTIME_ERROR_EVENT,
      payload: {
        source: 'gemini_stderr',
        status: 429,
      },
    });
    expect(res?.suppress).toBe(false);
    if (res?.message?.type !== 'event') throw new Error('Expected a structured event message');
    const payload = res.message.payload as Record<string, unknown>;
    expect(String(payload.message)).toContain('RESOURCE_EXHAUSTED');
  });

  it('surfaces rate-limit stderr without an explicit 429 marker as a structured event without a status code', () => {
    const res = geminiTransport.handleStderr?.(
      'ApiError: rateLimitExceeded for quota metric',
      DEFAULT_STDERR_CONTEXT,
    );
    expect(res?.message).toMatchObject({
      type: 'event',
      name: GEMINI_PROVIDER_RUNTIME_ERROR_EVENT,
      payload: { source: 'gemini_stderr' },
    });
    if (res?.message?.type !== 'event') throw new Error('Expected a structured event message');
    const payload = res.message.payload as Record<string, unknown>;
    expect(payload.status).toBeUndefined();
  });

  it('formats 404 model-not-found errors with catalog suggestions', () => {
    const res = geminiTransport.handleStderr?.('request failed with status 404', DEFAULT_STDERR_CONTEXT);
    expect(res?.message?.type).toBe('status');
    if (!res?.message || res.message.type !== 'status') {
      throw new Error('Expected a status message');
    }
    expect(res.message.detail ?? '').toContain('Model not found');
    expect(res.message.detail ?? '').toContain('gemini-3.1-pro-preview');
  });
});
