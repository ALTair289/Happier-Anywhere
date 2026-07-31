import { describe, expect, it } from 'vitest';

import { normalizePathForComparison } from './normalizePathForComparison';

describe('normalizePathForComparison', () => {
  it('expands home-relative paths and normalizes mixed separators', () => {
    const env = { HOME: '/Users/alice' };

    expect(normalizePathForComparison('~/workspace\\project/', { env, platform: 'darwin' })).toBe(
      normalizePathForComparison('/Users/alice/workspace/project', { env, platform: 'darwin' }),
    );
  });

  it('normalizes Windows drive paths case-insensitively', () => {
    const env = { USERPROFILE: 'C:\\Users\\Alice' };

    expect(normalizePathForComparison('~\\Workspace/project\\', { env, platform: 'win32' })).toBe(
      normalizePathForComparison('c:/users/alice/workspace/project', { env, platform: 'win32' }),
    );
  });

  it('keeps sibling paths distinct', () => {
    const env = { HOME: '/Users/alice' };

    expect(normalizePathForComparison('/Users/alice/workspace', { env, platform: 'darwin' })).not.toBe(
      normalizePathForComparison('/Users/alice/workspace-other', { env, platform: 'darwin' }),
    );
  });
});
