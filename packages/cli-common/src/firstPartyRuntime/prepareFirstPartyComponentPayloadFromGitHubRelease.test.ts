import { describe, expect, it } from 'vitest';

import { normalizeReleaseAssetArch } from './prepareFirstPartyComponentPayloadFromGitHubRelease';

describe('normalizeReleaseAssetArch', () => {
  it.each([
    ['aarch64', 'arm64'],
    ['arm64', 'arm64'],
    ['amd64', 'x64'],
    ['x86_64', 'x64'],
  ] as const)('normalizes %s to %s', (input, expected) => {
    expect(normalizeReleaseAssetArch(input)).toBe(expected);
  });

  it('rejects unsupported architectures', () => {
    expect(() => normalizeReleaseAssetArch('sparc')).toThrow(/unsupported/i);
  });
});
