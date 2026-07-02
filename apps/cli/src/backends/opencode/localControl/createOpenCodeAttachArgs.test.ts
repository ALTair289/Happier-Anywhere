import { homedir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createOpenCodeAttachArgs } from './createOpenCodeAttachArgs';

function dirArg(args: string[]): string {
  const index = args.indexOf('--dir');
  return index >= 0 ? args[index + 1] ?? '' : '';
}

describe('createOpenCodeAttachArgs', () => {
  it('preserves the attach arg structure', () => {
    const args = createOpenCodeAttachArgs({ baseUrl: 'http://127.0.0.1:5000', directory: '/work/project', sessionId: 'ses_1' });
    expect(args).toEqual(['attach', 'http://127.0.0.1:5000', '--dir', '/work/project', '--session', 'ses_1']);
  });

  it('canonicalizes a trailing-slash directory so the OpenCode TUI directory filter matches', () => {
    const args = createOpenCodeAttachArgs({ baseUrl: 'http://127.0.0.1:5000', directory: '/work/project/', sessionId: 'ses_1' });
    expect(dirArg(args)).toBe('/work/project');
  });

  it('canonicalizes redundant path segments', () => {
    const args = createOpenCodeAttachArgs({ baseUrl: 'http://127.0.0.1:5000', directory: '/work/./project/sub/..', sessionId: 'ses_1' });
    expect(dirArg(args)).toBe('/work/project');
  });

  it('expands a home-relative directory', () => {
    const args = createOpenCodeAttachArgs({ baseUrl: 'http://127.0.0.1:5000', directory: '~/project', sessionId: 'ses_1' });
    expect(dirArg(args)).toBe(path.resolve(homedir(), 'project'));
  });

  it('passes through an empty directory unchanged (no cwd resolution)', () => {
    const args = createOpenCodeAttachArgs({ baseUrl: 'http://127.0.0.1:5000', directory: '', sessionId: 'ses_1' });
    expect(dirArg(args)).toBe('');
  });
});
