import { describe, expect, it } from 'vitest';

import { applyClaudeUnifiedTerminalLaunchIntent } from './launchIntent';

describe('applyClaudeUnifiedTerminalLaunchIntent', () => {
  it('makes an exact resume the only Claude session-identity argument', () => {
    expect(applyClaudeUnifiedTerminalLaunchIntent([
      '--model',
      'claude-sonnet-4-5',
      '--continue',
      '--resume=stale-session',
      '--session-id',
      'fresh-session-id',
      '--fork-session',
    ], {
      kind: 'resume_native',
      providerSessionId: 'requested-session',
    })).toEqual([
      '--model',
      'claude-sonnet-4-5',
      '--resume',
      'requested-session',
    ]);
  });

  it('preserves a native continue while removing competing identity arguments', () => {
    expect(applyClaudeUnifiedTerminalLaunchIntent([
      '--resume',
      'stale-session',
      '--model',
      'claude-sonnet-4-5',
    ], { kind: 'continue_native' })).toEqual([
      '--model',
      'claude-sonnet-4-5',
      '--continue',
    ]);
  });

  it('removes continuation identity from a new-session launch', () => {
    expect(applyClaudeUnifiedTerminalLaunchIntent([
      '--continue',
      '--model',
      'claude-sonnet-4-5',
    ], { kind: 'new_session' })).toEqual([
      '--model',
      'claude-sonnet-4-5',
    ]);
  });
});
