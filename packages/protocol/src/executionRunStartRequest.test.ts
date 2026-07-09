import { describe, expect, it } from 'vitest';

import { ExecutionRunStartRequestSchema } from './executionRunStartRequest.js';
import { buildAcpConfigOptionOverridesV1 } from './sessionMetadata/metadataOverridesV1.js';

const base = {
  intent: 'delegate' as const,
  backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
  permissionMode: 'workspace_write',
  retentionPolicy: 'ephemeral' as const,
  runClass: 'bounded' as const,
  ioMode: 'request_response' as const,
};

describe('ExecutionRunStartRequestSchema model/effort parity', () => {
  it('accepts a top-level modelId identical in shape to session spawn', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({ ...base, modelId: 'gpt-5.5' });
    expect(parsed.modelId).toBe('gpt-5.5');
  });

  it('accepts canonical sessionConfigOptionOverrides carrying reasoning_effort', () => {
    const overrides = buildAcpConfigOptionOverridesV1({
      updatedAt: 1700000000000,
      overrides: { reasoning_effort: { updatedAt: 1700000000000, value: 'high' } },
    });
    const parsed = ExecutionRunStartRequestSchema.parse({ ...base, sessionConfigOptionOverrides: overrides });
    expect(parsed.sessionConfigOptionOverrides?.overrides.reasoning_effort?.value).toBe('high');
  });

  it('rejects a malformed modelId (empty string)', () => {
    expect(ExecutionRunStartRequestSchema.safeParse({ ...base, modelId: '' }).success).toBe(false);
  });

  it('rejects a malformed sessionConfigOptionOverrides (missing version)', () => {
    const bad = { updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } } };
    expect(ExecutionRunStartRequestSchema.safeParse({ ...base, sessionConfigOptionOverrides: bad }).success).toBe(false);
  });

  it('omitted model/effort leaves the fields undefined (today defaults)', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({ ...base });
    expect(parsed.modelId).toBeUndefined();
    expect(parsed.sessionConfigOptionOverrides).toBeUndefined();
  });
});
