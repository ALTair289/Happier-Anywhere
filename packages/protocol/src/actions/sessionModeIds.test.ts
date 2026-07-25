import { describe, expect, it } from 'vitest';

import { resolveRequestedSessionModeId } from './sessionModeIds.js';

describe('resolveRequestedSessionModeId', () => {
  it('preserves exact nonblank opaque mode identifiers', () => {
    expect(resolveRequestedSessionModeId(' plan ', [
      { id: 'plan' },
      { id: ' plan ' },
    ])).toBe(' plan ');
  });

  it('treats only the exact host default sentinel specially', () => {
    expect(resolveRequestedSessionModeId('default', [{ id: 'default' }])).toBe('default');
    expect(resolveRequestedSessionModeId('default', [{ id: 'plan' }])).toBe('');
    expect(resolveRequestedSessionModeId(' default ', [{ id: ' default ' }])).toBe(' default ');
  });
});
