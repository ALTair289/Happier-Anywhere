import { describe, expect, it } from 'vitest';

import { resolveReactiveRuntimeAuthRecoveryClear } from './resolveReactiveRuntimeAuthRecoveryClear';

describe('resolveReactiveRuntimeAuthRecoveryClear', () => {
  it('does NOT clear on a committed-switch metadata-only signal (no verification, no from-profile)', () => {
    // onCommittedSwitch fires the instant the server CAS commits. It carries only
    // commit metadata (active profile + generation) — never provider-outcome proof.
    const decision = resolveReactiveRuntimeAuthRecoveryClear({
      activeProfileId: 'backup',
    });
    expect(decision.clear).toBe(false);
    expect(decision.proof).toBeNull();
  });

  it('does NOT clear on an observed_generation event with no verification and no candidate change', () => {
    const decision = resolveReactiveRuntimeAuthRecoveryClear({
      activeProfileId: 'primary',
      fromProfileId: 'primary',
    });
    expect(decision.clear).toBe(false);
  });

  it('does NOT clear on a switched event with no verification and no from-profile', () => {
    const decision = resolveReactiveRuntimeAuthRecoveryClear({
      activeProfileId: 'backup',
    });
    expect(decision.clear).toBe(false);
  });

  it('does NOT clear on a bare credential_refreshed signal (empty signal)', () => {
    const decision = resolveReactiveRuntimeAuthRecoveryClear({});
    expect(decision.clear).toBe(false);
  });

  it('does NOT clear on application verification without provider outcome evidence', () => {
    const decision = resolveReactiveRuntimeAuthRecoveryClear({
      activeProfileId: 'backup',
      verificationByServiceId: {
        'openai-codex': { status: 'verified' },
      },
    });
    expect(decision).toEqual({ clear: false, proof: null });
  });

  it('keeps a genuinely fresh candidate pending until later provider proof arrives', () => {
    const decision = resolveReactiveRuntimeAuthRecoveryClear({
      fromProfileId: 'primary',
      activeProfileId: 'backup',
    });
    expect(decision.clear).toBe(false);
    expect(decision.proof).toBe('fresh_candidate_selected');
  });

  it('does NOT clear a same-account hot apply (from-profile equals active)', () => {
    const decision = resolveReactiveRuntimeAuthRecoveryClear({
      fromProfileId: 'primary',
      activeProfileId: 'primary',
    });
    expect(decision.clear).toBe(false);
  });

  it('ignores unverified verification entries', () => {
    const decision = resolveReactiveRuntimeAuthRecoveryClear({
      activeProfileId: 'backup',
      verificationByServiceId: {
        'openai-codex': { status: 'unverified' } as never,
      },
    });
    expect(decision.clear).toBe(false);
  });
});
