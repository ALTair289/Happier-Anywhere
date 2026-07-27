import { describe, expect, it } from 'vitest';

import {
  assertClaudeUnifiedHookActivationBeforeTranscriptFallback,
  ClaudeUnifiedTerminalHookActivationError,
  isClaudeUnifiedTrustedHookActivationEvidence,
} from './claudeUnifiedHookActivation';

describe('assertClaudeUnifiedHookActivationBeforeTranscriptFallback', () => {
  it('fails when a Happier-owned hook plugin reaches transcript acceptance without trusted hook evidence', () => {
    expect(() => assertClaudeUnifiedHookActivationBeforeTranscriptFallback({
      hookPluginDir: '/tmp/happier-session-hooks',
      hookSubscriptionConfigured: true,
      trustedHookActivationObserved: false,
    })).toThrow(ClaudeUnifiedTerminalHookActivationError);
  });

  it('allows fresh-session transcript acceptance after the owned plugin reports SessionStart', () => {
    expect(() => assertClaudeUnifiedHookActivationBeforeTranscriptFallback({
      hookPluginDir: '/tmp/happier-session-hooks',
      hookSubscriptionConfigured: true,
      trustedHookActivationObserved: true,
    })).not.toThrow();
  });

  it('allows a delayed resume SessionStart when it still precedes exact current-prompt acceptance', () => {
    let providerSessionStartedObserved = false;
    providerSessionStartedObserved = true;

    expect(() => assertClaudeUnifiedHookActivationBeforeTranscriptFallback({
      hookPluginDir: '/tmp/happier-session-hooks',
      hookSubscriptionConfigured: true,
      trustedHookActivationObserved: providerSessionStartedObserved,
    })).not.toThrow();
  });

  it('retains hookless transcript fallback when Happier did not install a plugin', () => {
    expect(() => assertClaudeUnifiedHookActivationBeforeTranscriptFallback({
      hookPluginDir: null,
      hookSubscriptionConfigured: true,
      trustedHookActivationObserved: false,
    })).not.toThrow();
  });

  it('retains transcript fallback when no Happier hook subscription is configured', () => {
    expect(() => assertClaudeUnifiedHookActivationBeforeTranscriptFallback({
      hookPluginDir: '/tmp/external-or-unowned-plugin',
      hookSubscriptionConfigured: false,
      trustedHookActivationObserved: false,
    })).not.toThrow();
  });
});

describe('isClaudeUnifiedTrustedHookActivationEvidence', () => {
  it.each(['SessionStart', 'UserPromptSubmit'])('trusts owned main-session %s with a nonblank session id', (hookEventName) => {
    expect(isClaudeUnifiedTrustedHookActivationEvidence({
      hook_event_name: hookEventName,
      session_id: ' claude-session-id ',
    })).toBe(true);
  });

  it.each([
    { hook_event_name: 'UserPromptSubmit' },
    { hook_event_name: 'UserPromptSubmit', session_id: '   ' },
    { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id', agent_id: 'sidechain-1' },
    { hook_event_name: 'PermissionRequest', session_id: 'claude-session-id' },
    { hook_event_name: 'Stop', session_id: 'claude-session-id' },
  ])('rejects malformed, sidechain, and non-activation hook evidence %#', (data) => {
    expect(isClaudeUnifiedTrustedHookActivationEvidence(data)).toBe(false);
  });
});
