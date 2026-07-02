import { describe, expect, it } from 'vitest';

import { DaemonTerminalErrorSchema } from './daemonTerminal';

describe('DaemonTerminalErrorSchema', () => {
  it('accepts explicit resize-unavailable errors', () => {
    expect(
      DaemonTerminalErrorSchema.safeParse({
        ok: false,
        errorCode: 'terminal_resize_unavailable',
        error: 'terminal_resize_unavailable',
      }).success,
    ).toBe(true);
  });
});
