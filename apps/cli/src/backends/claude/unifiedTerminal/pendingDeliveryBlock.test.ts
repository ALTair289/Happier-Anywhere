import { describe, expect, it } from 'vitest';

import {
  resolveClaudeUnifiedPendingDeliveryBlock,
  resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker,
} from './pendingDeliveryBlock';

describe('resolveClaudeUnifiedPendingDeliveryBlock', () => {
  it('classifies after-enter provider acceptance timeouts as blocked pending delivery', () => {
    const error = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
      userMessageLocalIds: ['pending-local-timeout', 'pending-local-timeout', 'pending-local-2'],
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toEqual({
      localIds: ['pending-local-timeout', 'pending-local-2'],
      reason: 'provider_acceptance_timeout',
    });
  });

  it('classifies recoverable after-enter host ambiguity as ambiguous blocked pending delivery', () => {
    const error = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'host_unreachable',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      recoverable: true,
      userMessageLocalIds: ['pending-local-visible-after-enter'],
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toEqual({
      localIds: ['pending-local-visible-after-enter'],
      reason: 'ambiguous_terminal_delivery',
    });
  });

  it('does not classify provider acceptance timeouts without pending local ids', () => {
    const error = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
      userMessageLocalIds: [],
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toBeNull();
  });

  it('preserves deterministic oversized prompt classification', () => {
    const error = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'payload_too_large',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: true,
      userMessageLocalIds: ['pending-local-too-large'],
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toEqual({
      localIds: ['pending-local-too-large'],
      reason: 'payload_too_large',
    });
  });

  it('classifies host loss after writing a pending prompt as blocked pending delivery', () => {
    const error = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'host_unreachable',
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
      recoverable: true,
      userMessageLocalIds: ['pending-local-host-lost'],
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toEqual({
      localIds: ['pending-local-host-lost'],
      reason: 'terminal_host_unreachable',
    });
  });

  it('maps sustained head blockers to retryable pending delivery block reasons', () => {
    expect(resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker({
      localIds: ['pending-local-draft', 'pending-local-draft', 'pending-local-2'],
      blocker: {
        kind: 'terminal_user_draft',
        source: 'draft_guard',
        guardStatus: 'foreign_draft',
        draftLength: 12,
      },
    })).toEqual({
      localIds: ['pending-local-draft', 'pending-local-2'],
      reason: 'terminal_composer_draft',
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker({
      localIds: ['pending-local-runtime-config'],
      blocker: {
        kind: 'runtime_config_blocked',
        source: 'runtime_control',
        blockedReason: 'user_draft',
      },
    })).toEqual({
      localIds: ['pending-local-runtime-config'],
      reason: 'runtime_config_blocked',
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker({
      localIds: ['pending-local-provider-unavailable'],
      blocker: {
        kind: 'provider_unavailable',
        source: 'draft_guard',
        detail: 'claude_usage_limit_dialog',
      },
    })).toEqual({
      localIds: ['pending-local-provider-unavailable'],
      reason: 'provider_unavailable_before_acceptance',
    });
  });
});
