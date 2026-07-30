import { describe, expect, it } from 'vitest';

import {
  ProviderPromptSubmissionRejectedBeforeEffectError,
  ProviderPromptSubmissionUnconfirmedError,
  resolveProviderPromptFailureDeliveryReason,
} from './providerPromptSubmission';

describe('provider prompt failure delivery ownership', () => {
  it('retains possible provider effect as ambiguous instead of manufacturing pre-effect rejection', () => {
    expect(resolveProviderPromptFailureDeliveryReason(
      new ProviderPromptSubmissionUnconfirmedError(),
      true,
    )).toBe('ambiguous_terminal_delivery');
  });

  it('preserves proven pre-dispatch failure but treats an ordinary attempted-send error as ambiguous', () => {
    expect(resolveProviderPromptFailureDeliveryReason(new Error('runtime unavailable'), false))
      .toBe('runtime_disposed_before_delivery');
    expect(resolveProviderPromptFailureDeliveryReason(new Error('provider response lost'), true))
      .toBe('ambiguous_terminal_delivery');
  });

  it('preserves an explicit proven pre-effect reason even after the provider call was attempted', () => {
    expect(resolveProviderPromptFailureDeliveryReason(
      new ProviderPromptSubmissionRejectedBeforeEffectError(
        'runtime_disposed_before_delivery',
        new Error('ACP session not started'),
      ),
      true,
    )).toBe('runtime_disposed_before_delivery');
    expect(resolveProviderPromptFailureDeliveryReason(
      new ProviderPromptSubmissionRejectedBeforeEffectError(
        'provider_unavailable_before_acceptance',
        new Error('OpenCode broker preflight failed before prompt_async'),
      ),
      true,
    )).toBe('provider_unavailable_before_acceptance');
  });
});
