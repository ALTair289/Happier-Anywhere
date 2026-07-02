import { describe, expect, it } from 'vitest';

import { buildNativeProviderAccountUsageSourceProfileId } from './nativeSourceIdentity';

describe('native provider account-usage source identity', () => {
  it('builds stable native source profile ids without quota or alias vocabulary', () => {
    const providerSubject = buildNativeProviderAccountUsageSourceProfileId({
      kind: 'providerSubject',
      providerId: 'codex',
      material: 'acct_native_codex',
    });
    const localCredential = buildNativeProviderAccountUsageSourceProfileId({
      kind: 'localCredential',
      providerId: 'codex',
      material: '/Users/alice/.codex',
    });

    expect(providerSubject).toMatch(/^acct:[a-f0-9]{48}$/u);
    expect(localCredential).toMatch(/^native:[a-f0-9]{48}$/u);
    expect(providerSubject).toBe(buildNativeProviderAccountUsageSourceProfileId({
      kind: 'providerSubject',
      providerId: ' codex ',
      material: ' acct_native_codex ',
    }));
    expect(providerSubject).not.toBe(localCredential);
  });
});
