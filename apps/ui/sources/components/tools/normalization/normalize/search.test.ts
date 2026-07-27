import { describe, expect, it } from 'vitest';

import {
  normalizeCodeSearchResultForRendering,
  normalizeGrepResultForRendering,
} from './search';

describe('normalizeCodeSearchResultForRendering aggregate compatibility', () => {
  it('upgrades the exact cli-v0.2.1 CodeSearch record shape without inventing another producer shape', () => {
    // Immutable provenance:
    // cli-v0.2.1@b1d15a8a9c241737d1ca9b167459901e6259173a
    // normalizeCodeSearchResult preserved aggregate fields and always added matches: [].
    expect(normalizeCodeSearchResultForRendering({ matches: [], totalMatches: 4, truncated: false })).toEqual({
      totalMatches: 4,
      truncated: false,
      matches: [],
      detailsUnavailable: true,
    });
    expect(normalizeCodeSearchResultForRendering({ matches: [], totalMatches: 0 })).toBeNull();
  });

  it('does not promote unsupported raw CodeSearch or aggregate-looking Grep records', () => {
    expect(normalizeCodeSearchResultForRendering({ totalMatches: 4 })).toBeNull();
    expect(normalizeCodeSearchResultForRendering({ totalMatches: 0 })).toBeNull();
    expect(normalizeGrepResultForRendering({ matches: [], totalMatches: 4 })).toBeNull();
  });

  it('keeps detailed, error, and malformed CodeSearch results semantically distinct', () => {
    expect(normalizeCodeSearchResultForRendering({
      totalMatches: 1,
      matches: [{ filePath: '/repo/a.ts', line: 1, excerpt: 'needle' }],
    })).toBeNull();
    expect(normalizeCodeSearchResultForRendering({ error: 'unavailable' })).toBeNull();
    expect(normalizeCodeSearchResultForRendering({
      error: 'unavailable',
      totalMatches: 4,
      matches: [],
    })).toBeNull();
    expect(normalizeCodeSearchResultForRendering({
      error: 'unavailable',
      totalMatches: 4,
      matches: [],
      detailsUnavailable: true,
    })).toBeNull();
    expect(normalizeCodeSearchResultForRendering({ totalMatches: -1 })).toBeNull();
  });
});
