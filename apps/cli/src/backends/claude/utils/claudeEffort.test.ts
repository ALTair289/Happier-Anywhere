import { describe, expect, it } from 'vitest';

import {
  buildClaudeEffortCliArgs,
  resolveClaudeDefaultEffortForModel,
  resolveClaudeUltracodeForModel,
} from './claudeEffort';

describe('buildClaudeEffortCliArgs', () => {
  it('treats Fable 5 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats Opus 4.8 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-8', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-8', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats Opus 5 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-5', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats the generic opus alias as the current flagship Claude model for default effort resolution', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'opus', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'opus', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('keeps Opus 4.7 behavior where high still requires an explicit override', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-7', effort: 'high' })).toEqual(['--effort', 'high']);
  });

  it('resolves effort for [1m]-suffixed model ids the same as the bare id', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5[1m]', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5[1m]', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-sonnet-4-6[1m]', effort: 'low' })).toEqual(['--effort', 'low']);
  });
});

describe('resolveClaudeUltracodeForModel', () => {
  it('enables ultracode only when requested AND the model is xhigh-capable', () => {
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-fable-5', ultracode: true })).toBe(true);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-opus-5', ultracode: true })).toBe(true);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-opus-4-8', ultracode: true })).toBe(true);
    expect(resolveClaudeUltracodeForModel({ modelId: 'opus', ultracode: true })).toBe(true);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-fable-5[1m]', ultracode: true })).toBe(true);
  });

  it('never enables ultracode for non-xhigh models or when not requested', () => {
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-sonnet-4-6', ultracode: true })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-opus-4-6', ultracode: true })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-haiku-4-5', ultracode: true })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-fable-5', ultracode: false })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-fable-5', ultracode: undefined })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: undefined, ultracode: true })).toBe(false);
  });
});

describe('resolveClaudeDefaultEffortForModel', () => {
  it('resolves the model default effort with alias and [1m] tolerance', () => {
    expect(resolveClaudeDefaultEffortForModel('claude-fable-5')).toBe('high');
    expect(resolveClaudeDefaultEffortForModel('opus')).toBe('high');
    expect(resolveClaudeDefaultEffortForModel('claude-opus-4-7[1m]')).toBe('xhigh');
    expect(resolveClaudeDefaultEffortForModel('claude-haiku-4-5')).toBeNull();
  });
});
