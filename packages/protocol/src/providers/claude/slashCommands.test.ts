import { describe, expect, it } from 'vitest';

import {
  isClaudeSlashCommandSupported,
  normalizeClaudeSlashCommandName,
  readClaudeSlashCommandNames,
} from './slashCommands.js';

describe('normalizeClaudeSlashCommandName', () => {
  it('normalizes a bare command name', () => {
    expect(normalizeClaudeSlashCommandName('goal')).toBe('goal');
  });

  it('strips a single leading slash', () => {
    expect(normalizeClaudeSlashCommandName('/goal')).toBe('goal');
  });

  it('trims surrounding whitespace and lowercases', () => {
    expect(normalizeClaudeSlashCommandName('  /GOAL  ')).toBe('goal');
    expect(normalizeClaudeSlashCommandName('Goal')).toBe('goal');
  });

  it('strips only ONE leading slash so a double slash is not a goal command', () => {
    expect(normalizeClaudeSlashCommandName('//goal')).toBe('/goal');
  });

  it('returns null for empty, whitespace, slash-only, or non-string values', () => {
    expect(normalizeClaudeSlashCommandName('')).toBeNull();
    expect(normalizeClaudeSlashCommandName('   ')).toBeNull();
    expect(normalizeClaudeSlashCommandName('/')).toBeNull();
    expect(normalizeClaudeSlashCommandName(42)).toBeNull();
    expect(normalizeClaudeSlashCommandName(null)).toBeNull();
    expect(normalizeClaudeSlashCommandName(undefined)).toBeNull();
    expect(normalizeClaudeSlashCommandName({ name: 'goal' })).toBeNull();
  });
});

describe('readClaudeSlashCommandNames', () => {
  it('returns the normalized names from an array, dropping malformed entries', () => {
    expect(readClaudeSlashCommandNames(['/goal', 'Compact', '', 7, null, '  diff '])).toEqual([
      'goal',
      'compact',
      'diff',
    ]);
  });

  it('returns an empty list for a non-array (fail-closed)', () => {
    expect(readClaudeSlashCommandNames(undefined)).toEqual([]);
    expect(readClaudeSlashCommandNames(null)).toEqual([]);
    expect(readClaudeSlashCommandNames('goal')).toEqual([]);
    expect(readClaudeSlashCommandNames({ '0': 'goal' })).toEqual([]);
  });
});

describe('isClaudeSlashCommandSupported', () => {
  it('accepts both the bare and slash-prefixed command shapes', () => {
    expect(isClaudeSlashCommandSupported(['goal'], 'goal')).toBe(true);
    expect(isClaudeSlashCommandSupported(['/goal'], 'goal')).toBe(true);
    expect(isClaudeSlashCommandSupported(['  /Goal '], 'goal')).toBe(true);
  });

  it('normalizes the queried command name as well', () => {
    expect(isClaudeSlashCommandSupported(['goal'], '/goal')).toBe(true);
  });

  it('is fail-closed on missing command, garbage entries, or a non-array list', () => {
    expect(isClaudeSlashCommandSupported(['compact', 'diff'], 'goal')).toBe(false);
    expect(isClaudeSlashCommandSupported([], 'goal')).toBe(false);
    expect(isClaudeSlashCommandSupported(undefined, 'goal')).toBe(false);
    expect(isClaudeSlashCommandSupported('goal', 'goal')).toBe(false);
    expect(isClaudeSlashCommandSupported(['goal'], '   ')).toBe(false);
  });
});
