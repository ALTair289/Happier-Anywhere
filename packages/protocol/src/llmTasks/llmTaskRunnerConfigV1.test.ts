import { describe, expect, it } from 'vitest';

import { LlmTaskRunnerConfigV1Schema } from './llmTaskRunnerConfigV1.js';

describe('LlmTaskRunnerConfigV1Schema', () => {
  it('validates without transforming a nonblank opaque model identifier', () => {
    const parsed = LlmTaskRunnerConfigV1Schema.parse({
      v: 1,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      modelId: ' model-a\t',
    });

    expect(parsed.modelId).toBe(' model-a\t');
  });

  it('rejects a whitespace-only model identifier', () => {
    expect(() => LlmTaskRunnerConfigV1Schema.parse({
      v: 1,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      modelId: ' \t',
    })).toThrow();
  });
});
