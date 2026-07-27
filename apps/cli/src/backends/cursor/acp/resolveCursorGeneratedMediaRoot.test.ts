import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveCursorGeneratedMediaRoot } from './resolveCursorGeneratedMediaRoot';

describe('resolveCursorGeneratedMediaRoot', () => {
  it('scopes generated-media access to the current Cursor project assets directory', () => {
    expect(resolveCursorGeneratedMediaRoot({
      directory: '/Users/tester/Documents/My Project',
      env: { HOME: '/Users/tester' },
      platform: 'darwin',
    })).toBe(join(
      '/Users/tester',
      '.cursor',
      'projects',
      'Users-tester-Documents-My-Project',
      'assets',
    ));
  });

  it('uses the effective Windows home and removes drive punctuation from the project key', () => {
    expect(resolveCursorGeneratedMediaRoot({
      directory: 'C:\\Users\\tester\\Documents\\My Project',
      env: { USERPROFILE: 'C:\\Users\\tester' },
      platform: 'win32',
    })).toBe('C:\\Users\\tester\\.cursor\\projects\\C--Users-tester-Documents-My-Project\\assets');
  });

  it('returns null when no effective home directory is available', () => {
    expect(resolveCursorGeneratedMediaRoot({
      directory: '/workspace/project',
      env: {},
      platform: 'linux',
      homedir: () => '',
    })).toBeNull();
  });
});
