import { describe, expect, it, vi } from 'vitest';

const { refreshBridgeMock } = vi.hoisted(() => ({
  refreshBridgeMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  refreshDaemonClaudeSubscriptionAnthropicAuthTokensForBridge: refreshBridgeMock,
}));

vi.mock('@/daemon/connectedServices/connectedServiceChildEnvironment', () => ({
  findConnectedServiceChildSelection: vi.fn(),
}));

import { computeClaudeCodeCredentialSafeTokenFingerprint } from './nativeAuth/claudeCodeCredentialFile';
import { createClaudeSubscriptionAccessTokenRefreshCallback } from './claudeSubscriptionAccessTokenRefresh';

describe('createClaudeSubscriptionAccessTokenRefreshCallback', () => {
  it('returns the current token first, then forces refresh with the previously delivered fingerprint', async () => {
    refreshBridgeMock
      .mockResolvedValueOnce({ accessToken: 'first-access', anthropicAccountId: 'acct', expiresAt: 1_000 })
      .mockResolvedValueOnce({ accessToken: 'second-access', anthropicAccountId: 'acct', expiresAt: 2_000 });
    const selection = {
      kind: 'profile' as const,
      serviceId: 'claude-subscription' as const,
      profileId: 'work',
    };
    const callback = createClaudeSubscriptionAccessTokenRefreshCallback({
      sessionId: 'session-1',
      selection,
    });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();

    await expect(callback({ signal: firstAbort.signal })).resolves.toBe('first-access');
    await expect(callback({ signal: secondAbort.signal })).resolves.toBe('second-access');

    expect(refreshBridgeMock).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      selection,
      forceRefresh: false,
    });
    expect(refreshBridgeMock).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      selection,
      forceRefresh: true,
      failingAccessTokenFingerprint: computeClaudeCodeCredentialSafeTokenFingerprint('first-access'),
    });
  });
});
