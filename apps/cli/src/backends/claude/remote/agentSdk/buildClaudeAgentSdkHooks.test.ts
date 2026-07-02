import { describe, expect, it, vi } from 'vitest';

import type { EnhancedMode } from '../../loop';
import type { PermissionResult } from '../../sdk/types';
import { buildClaudeAgentSdkHooks } from './buildClaudeAgentSdkHooks';

const makeMode = (): EnhancedMode => ({
  permissionMode: 'default',
});

function buildHooks(
  canCallTool = vi.fn(async (): Promise<PermissionResult> => ({ behavior: 'deny', message: 'denied' })),
) {
  return buildClaudeAgentSdkHooks({
    cwd: '/tmp/project',
    claudeConfigDir: null,
    getMode: makeMode,
    onSessionFound: () => {},
    canCallTool,
  });
}

describe('buildClaudeAgentSdkHooks', () => {
  it('does not register blocking PermissionRequest hooks when canUseTool can wait indefinitely', () => {
    const { hooks } = buildHooks();

    expect(hooks.PermissionRequest).toBeUndefined();
  });

  it('preserves permission metadata and provider updates through canUseTool', async () => {
    const updatedInput = { file_path: '/tmp/file.txt' };
    const updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    const canCallTool = vi.fn(async (): Promise<PermissionResult> => ({
      behavior: 'allow',
      updatedInput,
      updatedPermissions,
    }));
    const { canUseTool } = buildHooks(canCallTool);
    const signal = new AbortController().signal;

    const output = await canUseTool('Read', { file_path: '/tmp/input.txt' }, {
      signal,
      toolUseID: 'toolu_123',
      agentID: 'agent_456',
      suggestions,
      blockedPath: '/tmp/blocked.txt',
      decisionReason: 'requires approval',
    });

    expect(canCallTool).toHaveBeenCalledWith(
      'Read',
      { file_path: '/tmp/input.txt' },
      expect.anything(),
      expect.objectContaining({
        signal,
        toolUseId: 'toolu_123',
        agentId: 'agent_456',
        suggestions,
        blockedPath: '/tmp/blocked.txt',
        decisionReason: 'requires approval',
      }),
    );
    expect(output).toEqual({
      behavior: 'allow',
      updatedInput,
      updatedPermissions,
    });
  });
});
