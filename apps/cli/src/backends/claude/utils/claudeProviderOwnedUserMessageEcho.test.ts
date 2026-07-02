import { describe, expect, it } from 'vitest';

import type { Update, UserMessage } from '@/api/types';
import { isClaudeProviderOwnedUserMessageEcho } from './claudeProviderOwnedUserMessageEcho';

function createMessage(localId: string, meta?: UserMessage['meta']): UserMessage {
  return {
    role: 'user',
    content: { type: 'text', text: 'typed in Claude TUI' },
    localId,
    ...(meta ? { meta } : {}),
  } as UserMessage;
}

function createUpdate(localId: string): Update {
  return {
    id: 'update-1',
    createdAt: 1,
    body: {
      t: 'new-message',
      sid: 'session-1',
      message: {
        id: 'message-1',
        seq: 10,
        localId,
        content: { t: 'plain', v: {} },
        createdAt: 1,
        updatedAt: 1,
      },
    },
  } as unknown as Update;
}

describe('isClaudeProviderOwnedUserMessageEcho', () => {
  it('classifies Claude JSONL CLI user echoes as provider-owned', () => {
    const localId = 'claude-jsonl:main:user:u1';

    expect(isClaudeProviderOwnedUserMessageEcho(
      createMessage(localId),
      createUpdate(localId),
    )).toBe(true);
    expect(isClaudeProviderOwnedUserMessageEcho(
      createMessage(localId, { source: 'cli' }),
      createUpdate(localId),
    )).toBe(true);
    expect(isClaudeProviderOwnedUserMessageEcho(
      createMessage(localId, { sentFrom: 'cli' }),
      createUpdate(localId),
    )).toBe(true);
  });

  it('does not classify non-Claude user rows as provider-owned', () => {
    expect(isClaudeProviderOwnedUserMessageEcho(
      createMessage('other-provider:user:u1', { source: 'cli' }),
      createUpdate('other-provider:user:u1'),
    )).toBe(false);
  });
});
