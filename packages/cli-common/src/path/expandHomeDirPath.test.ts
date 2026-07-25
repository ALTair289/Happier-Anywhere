import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';

import { expandHomeDirPath, resolveHomeDirFromEnvironment } from './expandHomeDirPath';

describe('expandHomeDirPath', () => {
  it.each([
    ['~', 'C:\\Users\\alice'],
    ['~/projects/repo', 'C:\\Users\\alice\\projects\\repo'],
    ['~\\projects\\repo', 'C:\\Users\\alice\\projects\\repo'],
    ['~/projects\\mixed/repo', 'C:\\Users\\alice\\projects\\mixed\\repo'],
    ['C:\\Users\\alice2\\repo', 'C:\\Users\\alice2\\repo'],
  ])('normalizes Windows path %s independently of the host platform', (input, expected) => {
    const env = { USERPROFILE: 'C:\\Users\\alice' };

    expect(resolveHomeDirFromEnvironment(env, 'win32')).toBe('C:\\Users\\alice');
    expect(expandHomeDirPath(input, env, 'win32')).toBe(expected);
  });

  it('keeps non-home prefixes distinct and falls back through the platform environment contract', () => {
    expect(expandHomeDirPath('~alice/project', { HOME: '/users/alice' }, 'linux')).toBe(
      '~alice/project',
    );
    expect(expandHomeDirPath('~/project\\mixed', { HOME: '/users/alice' }, 'linux')).toBe(
      '/users/alice/project/mixed',
    );
    expect(resolveHomeDirFromEnvironment({ HOME: 'C:\\fallback' }, 'win32')).toBe(
      'C:\\fallback',
    );
    expect(resolveHomeDirFromEnvironment({}, 'linux')).toBe(homedir());
  });
});
