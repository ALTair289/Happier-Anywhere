import { describe, expect, it } from 'vitest';

import { normalizeCodeSearchResult } from './search';

describe('normalizeCodeSearchResult aggregate semantics', () => {
  it('keeps a true zero distinct from positive aggregate results without details', () => {
    expect(normalizeCodeSearchResult({ totalMatches: 0, truncated: false })).toEqual({
      totalMatches: 0,
      truncated: false,
      matches: [],
    });
    expect(normalizeCodeSearchResult({ totalMatches: 4, truncated: false })).toEqual({
      totalMatches: 4,
      truncated: false,
      matches: [],
      detailsUnavailable: true,
    });
  });

  it('preserves file counts, truncation, and detailed matches without claiming details are unavailable', () => {
    expect(normalizeCodeSearchResult({ totalFiles: 3, truncated: true })).toEqual({
      totalFiles: 3,
      truncated: true,
      matches: [],
      detailsUnavailable: true,
    });
    expect(normalizeCodeSearchResult({
      totalMatches: 1,
      truncated: true,
      matches: [{ filePath: '/repo/a.ts', line: 2, excerpt: 'needle' }],
    })).toEqual({
      totalMatches: 1,
      truncated: true,
      matches: [{ filePath: '/repo/a.ts', line: 2, excerpt: 'needle' }],
    });
  });

  it('preserves error-only and malformed results without fabricating a zero-result assertion', () => {
    expect(normalizeCodeSearchResult({ error: 'provider unavailable', retryable: true })).toEqual({
      error: 'provider unavailable',
      retryable: true,
    });
    expect(normalizeCodeSearchResult({ totalMatches: -1, totalFiles: 'four' })).toEqual({
      totalMatches: -1,
      totalFiles: 'four',
    });
    expect(normalizeCodeSearchResult({ error: 'timeout', totalMatches: 4, truncated: true })).toEqual({
      error: 'timeout',
      totalMatches: 4,
      truncated: true,
    });
    expect(normalizeCodeSearchResult({
      error: 'timeout',
      totalMatches: 4,
      matches: [],
      truncated: true,
    })).toEqual({
      error: 'timeout',
      totalMatches: 4,
      matches: [],
      truncated: true,
    });
    expect(normalizeCodeSearchResult({ error: false, totalMatches: 2 })).toEqual({
      error: false,
      totalMatches: 2,
      matches: [],
      detailsUnavailable: true,
    });
  });

  it('normalizes concurrent result objects independently without shared cache state', () => {
    const first = normalizeCodeSearchResult({ totalMatches: 2 });
    const second = normalizeCodeSearchResult({ totalMatches: 0 });
    expect(first).toMatchObject({ totalMatches: 2, detailsUnavailable: true });
    expect(second).toEqual({ totalMatches: 0, matches: [] });
  });
});
