import { describe, expect, it } from 'vitest';

import { SessionSummarySchema, V2SessionRecordSchema } from '../sessionControl/contract.js';
import { UpdateBodySchema } from '../updates.js';

const projection = {
  runtimeActivityVersion: 2,
  runtimeActivityState: 'unknown',
  runtimeActivityActiveCount: 0,
  runtimeActivityObservedAt: null,
  runtimeActivityExpiresAt: null,
  runtimeActivitySourceClass: null,
  runtimeActivityRevision: 7,
} as const;

describe('runtime activity v2 public contracts', () => {
  it('carries the coarse v2 projection through session summary and full records', () => {
    expect(Object.keys(SessionSummarySchema.shape)).toEqual(expect.arrayContaining([
      'runtimeActivityVersion',
      'runtimeActivityState',
      'runtimeActivityRevision',
    ]));
    expect(Object.keys(SessionSummarySchema.shape)).not.toContain('runtimeActivityWriterGeneration');
    expect(Object.keys(V2SessionRecordSchema.shape)).toEqual(expect.arrayContaining([
      'runtimeActivityVersion',
      'runtimeActivityState',
      'runtimeActivityRevision',
    ]));
    expect(Object.keys(V2SessionRecordSchema.shape)).not.toContain('runtimeActivityWriterGeneration');
    const summary = SessionSummarySchema.parse({
      id: 'session-1', createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryption: { type: 'dataKey' }, host: 'host', ...projection,
    });
    expect(summary).toMatchObject(projection);

    const record = V2SessionRecordSchema.parse({
      id: 'session-1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      metadata: 'metadata', metadataVersion: 1, agentState: null, agentStateVersion: 1,
      dataEncryptionKey: null, ...projection,
    });
    expect(record).toMatchObject(projection);
  });

  it('carries the same projection through new-session and update-session events', () => {
    const runtimeFieldNames = ['runtimeActivityVersion', 'runtimeActivityState', 'runtimeActivityRevision'];
    const sessionEventSchemas = UpdateBodySchema.options.filter((option) => {
      const type = option.shape.t.value;
      return type === 'new-session' || type === 'update-session';
    });
    expect(sessionEventSchemas).toHaveLength(2);
    for (const schema of sessionEventSchemas) {
      expect(Object.keys(schema.shape)).toEqual(expect.arrayContaining(runtimeFieldNames));
      expect(Object.keys(schema.shape)).not.toContain('runtimeActivityWriterGeneration');
    }
    const created = UpdateBodySchema.parse({
      t: 'new-session', id: 'session-1', seq: 1, metadata: 'metadata', metadataVersion: 1,
      agentState: null, agentStateVersion: 1, dataEncryptionKey: null,
      active: true, activeAt: 1, createdAt: 1, updatedAt: 1, ...projection,
    });
    expect(created).toMatchObject(projection);

    const updated = UpdateBodySchema.parse({ t: 'update-session', id: 'session-1', ...projection });
    expect(updated).toMatchObject(projection);
  });

  it('rejects known private authority and provider-source fields even through passthrough DTOs', () => {
    const privateFields = {
      runtimeActivityWriterGeneration: 'generation-private',
      runtimeActivityWriterCredentialHash: 'credential-hash-private',
      runtimeActivityExpectedOwnerScopes: ['claude.provider-task'],
      runtimeActivitySources: [{ sourceKey: 'provider-private' }],
    };
    expect(SessionSummarySchema.safeParse({
      id: 'session-1', createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryption: { type: 'dataKey' }, host: 'host', ...projection, ...privateFields,
    }).success).toBe(false);
    expect(V2SessionRecordSchema.safeParse({
      id: 'session-1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      metadata: 'metadata', metadataVersion: 1, agentState: null, agentStateVersion: 1,
      dataEncryptionKey: null, ...projection, ...privateFields,
    }).success).toBe(false);
    expect(UpdateBodySchema.safeParse({
      t: 'update-session', id: 'session-1', ...projection, ...privateFields,
    }).success).toBe(false);
  });

  it('preserves a bounded future activity version for fail-closed compatibility mapping', () => {
    const futureProjection = { ...projection, runtimeActivityVersion: 3 };
    expect(SessionSummarySchema.safeParse({
      id: 'session-1', createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryption: { type: 'dataKey' }, host: 'host', ...futureProjection,
    }).success).toBe(true);
    expect(UpdateBodySchema.safeParse({
      t: 'update-session', id: 'session-1', ...futureProjection,
    }).success).toBe(true);
  });
});
