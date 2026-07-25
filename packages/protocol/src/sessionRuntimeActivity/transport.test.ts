import { describe, expect, it } from 'vitest';

import {
  SESSION_PUBLISHER_LEGACY_ALIVE_EVENT,
  SESSION_PUBLISHER_LEGACY_END_EVENT,
  SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
  SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT,
  SessionPublisherLegacyAliveSchema,
  SessionPublisherLegacyEndSchema,
  SessionRuntimeActivityCloseAckSchema,
  SessionRuntimeActivityCloseRequestSchema,
  SessionRuntimeActivitySnapshotAckSchema,
  SessionRuntimeActivitySnapshotRequestSchema,
} from './transport.js';

describe('Runtime Activity snapshot transport', () => {
  const request = {
    sessionId: 'session-1',
    mutationId: 'runtime-activity-snapshot:session-1',
    snapshot: { state: 'active', activeCount: 2 },
  } as const;

  it('owns one unsuffixed strict complete-snapshot event contract', () => {
    expect(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT).toBe('session-runtime-activity-snapshot');
    expect(SessionRuntimeActivitySnapshotRequestSchema.parse(request)).toEqual(request);
    expect(SessionRuntimeActivitySnapshotRequestSchema.safeParse({
      ...request,
      expiresAt: Date.now() + 30_000,
    }).success).toBe(false);
    expect(SessionRuntimeActivitySnapshotRequestSchema.safeParse({
      ...request,
      snapshot: { ...request.snapshot, revision: 4 },
    }).success).toBe(false);
  });

  it('owns an exact-socket clean-close contract with no durable envelope', () => {
    expect(SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT).toBe('session-runtime-activity-close');
    expect(SessionRuntimeActivityCloseRequestSchema.parse({ sessionId: 'session-1' })).toEqual({ sessionId: 'session-1' });
    expect(SessionRuntimeActivityCloseRequestSchema.safeParse({ sessionId: 'session-1', mutationId: 'durable-end' }).success).toBe(false);
    for (const ack of [
      { status: 'closed', sessionId: 'session-1' },
      { status: 'already_inactive', sessionId: 'session-1' },
      { status: 'rejected', sessionId: 'session-1', reason: 'superseded' },
      { status: 'retryable', sessionId: 'session-1', reason: 'internal' },
    ] as const) {
      expect(SessionRuntimeActivityCloseAckSchema.parse(ack)).toEqual(ack);
    }
  });

  it('parses only the released machine-bound alive/end identity vectors', () => {
    expect(SESSION_PUBLISHER_LEGACY_ALIVE_EVENT).toBe('session-alive');
    expect(SESSION_PUBLISHER_LEGACY_END_EVENT).toBe('session-end');
    expect(SessionPublisherLegacyAliveSchema.safeParse({
      sid: 'session-1',
      time: 100,
      thinking: true,
      mode: 'remote',
    }).success).toBe(true);
    expect(SessionPublisherLegacyAliveSchema.safeParse({
      sid: 'session-1',
      time: 101,
      thinking: false,
      mode: 'local',
      latestTurnStatus: 'running',
      latestTurnStatusObservedAt: 101,
    }).success).toBe(true);
    expect(SessionPublisherLegacyAliveSchema.safeParse({ sid: 'session-1', time: 100 }).success).toBe(false);
    expect(SessionPublisherLegacyEndSchema.safeParse({ sid: 'session-1', time: 102 }).success).toBe(true);
    expect(SessionPublisherLegacyEndSchema.safeParse({ sid: '', time: 102 }).success).toBe(false);
  });

  it('strictly distinguishes applied, unchanged, rejected, and retryable ACKs', () => {
    const projection = { ...request.snapshot, observedAt: 100, revision: 3 };
    for (const ack of [
      { status: 'applied', sessionId: request.sessionId, mutationId: request.mutationId, projection },
      { status: 'unchanged', sessionId: request.sessionId, mutationId: request.mutationId, projection },
      { status: 'rejected', sessionId: request.sessionId, mutationId: request.mutationId, reason: 'archived' },
      { status: 'retryable', sessionId: request.sessionId, mutationId: request.mutationId, reason: 'internal' },
    ] as const) {
      expect(SessionRuntimeActivitySnapshotAckSchema.parse(ack)).toEqual(ack);
    }
    expect(SessionRuntimeActivitySnapshotAckSchema.safeParse({ result: 'success' }).success).toBe(false);
    expect(SessionRuntimeActivitySnapshotAckSchema.safeParse({
      status: 'applied',
      sessionId: request.sessionId,
      mutationId: request.mutationId,
      projection,
      writerGeneration: 'generation-1',
    }).success).toBe(false);
  });
});
