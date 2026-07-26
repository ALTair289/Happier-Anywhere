import { describe, expect, it, vi } from 'vitest';
import {
  applyAcknowledgedRuntimeActivityProjection,
  handleSessionStateUpdate,
} from './sessionStateUpdateHandling';

describe('handleSessionStateUpdate', () => {
  it('parses plaintext metadata updates when sessionEncryptionMode=plain', () => {
    const onWarning = vi.fn();
    const onMetadataUpdated = vi.fn();

    const result = handleSessionStateUpdate({
      update: {
        id: 'u1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          sid: 's1',
          metadata: {
            version: 1,
            value: JSON.stringify({ path: '/tmp', host: 'h1', flavor: 'claude' }),
          },
        },
      } as any,
      updateSource: 'session-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      metadata: null,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      onMetadataUpdated,
      onWarning,
    });

    expect(result.handled).toBe(true);
    expect(result.metadata?.path).toBe('/tmp');
    expect(onMetadataUpdated).toHaveBeenCalledTimes(1);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('ignores user-scoped update-machine broadcasts without warning', () => {
    const onWarning = vi.fn();

    const result = handleSessionStateUpdate({
      update: { id: 'u1', seq: 1, createdAt: Date.now(), body: { t: 'update-machine', machineId: 'm1' } } as any,
      updateSource: 'user-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'e2ee',
      metadata: null,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      encryptionKey: new Uint8Array(),
      encryptionVariant: 'dataKey',
      onMetadataUpdated: () => {},
      onWarning,
    });

    expect(result.handled).toBe(true);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('tracks pending count/version from pending-changed updates', () => {
    const onMetadataUpdated = vi.fn();
    const onPendingChangedDrainTrigger = vi.fn();

    const result = handleSessionStateUpdate({
      update: {
        id: 'u1',
        seq: 1,
        createdAt: Date.now(),
        body: { t: 'pending-changed', sid: 's1', pendingCount: 2, pendingVersion: 7 },
      } as any,
      updateSource: 'user-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'e2ee',
      metadata: null,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      pendingQueueState: { known: false },
      encryptionKey: new Uint8Array(),
      encryptionVariant: 'dataKey',
      onMetadataUpdated,
      onPendingChangedDrainTrigger,
      onWarning: () => {},
    } as any);

    expect(result.pendingWakeSeq).toBe(1);
    expect((result as any).pendingQueueState).toEqual({
      known: true,
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 7,
    });
    expect(onMetadataUpdated).toHaveBeenCalledTimes(1);
    expect(onPendingChangedDrainTrigger).toHaveBeenCalledWith({
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 7,
    });
  });

  it('accepts only newer complete target Runtime Activity projections', () => {
    const current = {
      runtimeActivityState: 'active' as const,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 10,
      runtimeActivityRevision: 4,
    };
    const result = handleSessionStateUpdate({
      update: {
        id: 'u-runtime', seq: 2, createdAt: 20,
        body: {
          t: 'update-session', sid: 's1',
          runtimeActivityState: 'idle',
          runtimeActivityActiveCount: 0,
          runtimeActivityObservedAt: 20,
          runtimeActivityRevision: 5,
        },
      } as any,
      updateSource: 'session-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'e2ee',
      metadata: null,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      runtimeActivityProjection: current,
      encryptionKey: new Uint8Array(),
      encryptionVariant: 'dataKey',
      onMetadataUpdated: () => {},
      onWarning: () => {},
    });

    expect(result.runtimeActivityProjection).toEqual({
      runtimeActivityState: 'idle',
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: 20,
      runtimeActivityRevision: 5,
    });
    expect(result.pendingWakeSeq).toBe(1);
  });

  it('retains the current Runtime Activity projection and requests a typed resync on an equal-revision conflict', () => {
    const current = {
      runtimeActivityState: 'active' as const,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 10,
      runtimeActivityRevision: 4,
    };
    const onRuntimeActivityResyncRequired = vi.fn();

    const result = handleSessionStateUpdate({
      update: {
        id: 'u-runtime-conflict', seq: 2, createdAt: 20,
        body: {
          t: 'update-session', sid: 's1',
          runtimeActivityState: 'idle',
          runtimeActivityActiveCount: 0,
          runtimeActivityObservedAt: 20,
          runtimeActivityRevision: 4,
        },
      } as any,
      updateSource: 'session-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'e2ee',
      metadata: null,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      runtimeActivityProjection: current,
      encryptionKey: new Uint8Array(),
      encryptionVariant: 'dataKey',
      onMetadataUpdated: () => {},
      onRuntimeActivityResyncRequired,
      onWarning: () => {},
    });

    expect(result.runtimeActivityProjection).toBe(current);
    expect(result.pendingWakeSeq).toBe(0);
    expect(onRuntimeActivityResyncRequired).toHaveBeenCalledWith({
      reason: 'equal_revision_conflict',
      current: { state: 'active', activeCount: 1, observedAt: 10, revision: 4 },
      incoming: { state: 'idle', activeCount: 0, observedAt: 20, revision: 4 },
    });
  });

  it('applies a target snapshot acknowledgement idempotently', () => {
    const current = {
      runtimeActivityState: 'active' as const,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 10,
      runtimeActivityRevision: 4,
    };
    const first = applyAcknowledgedRuntimeActivityProjection({
      current,
      projection: { state: 'idle', activeCount: 0, observedAt: 20, revision: 5 },
    });
    const duplicate = applyAcknowledgedRuntimeActivityProjection({
      current: first.projection,
      projection: { state: 'idle', activeCount: 0, observedAt: 20, revision: 5 },
    });

    expect(first.didBecomeIdle).toBe(true);
    expect(duplicate.didBecomeIdle).toBe(false);
    expect(duplicate.projection).toBe(first.projection);
  });

  it('warns when session-scoped socket receives update-machine', () => {
    const onWarning = vi.fn();

    const result = handleSessionStateUpdate({
      update: { id: 'u1', seq: 1, createdAt: Date.now(), body: { t: 'update-machine', machineId: 'm1' } } as any,
      updateSource: 'session-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'e2ee',
      metadata: null,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      encryptionKey: new Uint8Array(),
      encryptionVariant: 'dataKey',
      onMetadataUpdated: () => {},
      onWarning,
    });

    expect(result.handled).toBe(true);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('does not advance metadataVersion when an encrypted metadata update cannot be decrypted', () => {
    const onWarning = vi.fn();
    const onMetadataUpdated = vi.fn();
    const previousMetadata = { path: '/tmp/original', host: 'h1', flavor: 'claude' } as any;

    const result = handleSessionStateUpdate({
      update: {
        id: 'u1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          sid: 's1',
          metadata: {
            version: 5,
            value: 'not-valid-base64-ciphertext',
          },
        },
      } as any,
      updateSource: 'session-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'e2ee',
      metadata: previousMetadata,
      metadataVersion: 4,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      onMetadataUpdated,
      onWarning,
    });

    expect(result.handled).toBe(true);
    expect(result.metadata).toBe(previousMetadata);
    expect(result.metadataVersion).toBe(4);
    expect(onMetadataUpdated).not.toHaveBeenCalled();
    expect(onWarning).not.toHaveBeenCalled();
  });
});
