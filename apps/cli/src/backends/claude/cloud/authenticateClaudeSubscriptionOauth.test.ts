import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_CALLBACK_URL,
} from '@happier-dev/agents';

const openBrowserSpy = vi.fn(async (_url: string) => {});
vi.mock('@/ui/openBrowser', () => ({ openBrowser: openBrowserSpy }));

const promptInputSpy = vi.fn(async () => '');
vi.mock('@/terminal/prompts/promptInput', () => ({ promptInput: promptInputSpy }));

describe('authenticateClaudeSubscriptionOauth', () => {
  it('opens the authorization URL using the supported console callback redirect URI', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as any);
    const { authenticateClaudeSubscriptionOauth } = await import('./authenticateClaudeSubscriptionOauth');

    await expect(authenticateClaudeSubscriptionOauth({ paste: true })).rejects.toThrow();

    expect(openBrowserSpy).toHaveBeenCalledTimes(1);
    const url = String(openBrowserSpy.mock.calls[0]?.[0] ?? '');
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(CLAUDE_OAUTH_AUTHORIZE_URL);
    expect(parsed.searchParams.get('redirect_uri')).toBe(CLAUDE_OAUTH_CALLBACK_URL);
    expect(parsed.searchParams.get('scope')).toBe(CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE);

    stdoutSpy.mockRestore();
  });
});
