import { describe, expect, it } from 'vitest';

import { readClaudeRemoteProviderPromptAcceptance } from './providerPromptAcceptance';

describe('readClaudeRemoteProviderPromptAcceptance', () => {
  it('preserves and dedupes Happier local ids by exact bytes', () => {
    expect(readClaudeRemoteProviderPromptAcceptance({
      message: 'hello',
      mode: {} as never,
      maxUserMessageSeq: 7,
      userMessageLocalIds: ['local-1', ' local-1\n', 'local-1', '   '],
    })).toEqual({
      maxUserMessageSeq: 7,
      userMessageLocalIds: ['local-1', ' local-1\n'],
    });
  });

  it('captures the new-turn model but does not attribute an in-flight steer to it', () => {
    expect(readClaudeRemoteProviderPromptAcceptance({
      message: 'new turn',
      mode: { model: 'claude-opus-4-6' } as never,
      userMessageLocalIds: ['new-turn-local'],
      pendingProviderAction: 'send',
    })).toMatchObject({
      appliedModelId: 'claude-opus-4-6',
    });
    expect(readClaudeRemoteProviderPromptAcceptance({
      message: 'steer',
      mode: { model: 'claude-opus-4-6' } as never,
      userMessageLocalIds: ['steer-local'],
      pendingProviderAction: 'steer',
    })).not.toHaveProperty('appliedModelId');
  });
});
