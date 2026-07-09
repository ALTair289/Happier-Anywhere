import { describe, expect, it } from 'vitest';

import { buildAcpConfigOptionOverridesV1 } from '../sessionMetadata/metadataOverridesV1.js';
import { readSpawnConfigOptionOverrideValue } from './sessionSpawnConfigOptions.js';

describe('readSpawnConfigOptionOverrideValue', () => {
  const overrides = buildAcpConfigOptionOverridesV1({
    updatedAt: 1,
    overrides: {
      reasoning_effort: { updatedAt: 1, value: 'high' },
      ultracode: { updatedAt: 1, value: false },
      cleared: { updatedAt: 1, value: null },
    },
  });

  it('reads a present string option value', () => {
    expect(readSpawnConfigOptionOverrideValue(overrides, 'reasoning_effort')).toBe('high');
  });

  it('reads a present boolean option value', () => {
    expect(readSpawnConfigOptionOverrideValue(overrides, 'ultracode')).toBe(false);
  });

  it('returns undefined for a cleared (null) option', () => {
    expect(readSpawnConfigOptionOverrideValue(overrides, 'cleared')).toBeUndefined();
  });

  it('returns undefined for an absent option or absent overrides', () => {
    expect(readSpawnConfigOptionOverrideValue(overrides, 'missing')).toBeUndefined();
    expect(readSpawnConfigOptionOverrideValue(null, 'reasoning_effort')).toBeUndefined();
    expect(readSpawnConfigOptionOverrideValue(undefined, 'reasoning_effort')).toBeUndefined();
  });
});
