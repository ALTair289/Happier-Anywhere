import { afterEach, describe, expect, it } from 'vitest';

import {
  OpenCodeBrokerLoadHandshakeRequestSchema,
  readOpenCodeBrokerLoadHandshakeObservation,
  recordOpenCodeBrokerLoadHandshake,
  resetOpenCodeBrokerLoadHandshakesForTests,
  wasOpenCodeBrokerLoadHandshakeObserved,
} from './openCodeBrokerLoadHandshakeRegistry';

const IDENTITY = 'opencode|connected|broker:1|openai-codex:p:';
const PROCESS_PID = 4242;
const PLUGIN_VERSION = '1';

const observationKey = (
  overrides: Partial<Readonly<{
    runtimeKind: 'opencode_managed_server' | 'pi_rpc_process';
    selectionIdentity: string;
    loadNonce: string;
    providers: readonly ('openai' | 'anthropic')[];
    pluginVersion: string;
  }>> = {},
) => ({
  runtimeKind: 'opencode_managed_server' as const,
  selectionIdentity: IDENTITY,
  loadNonce: 'spawn-a',
  providers: ['openai'] as const,
  pluginVersion: PLUGIN_VERSION,
  ...overrides,
});

const handshake = (
  overrides: Partial<Readonly<{
    runtimeKind: 'opencode_managed_server' | 'pi_rpc_process';
    selectionIdentity: string;
    loadNonce: string;
    providers: readonly ('openai' | 'anthropic')[];
    pluginVersion: string;
    processPid: number;
  }>> = {},
) => ({
  ...observationKey(),
  processPid: PROCESS_PID,
  ...overrides,
});

describe('openCodeBrokerLoadHandshakeRegistry', () => {
  afterEach(() => {
    resetOpenCodeBrokerLoadHandshakesForTests();
  });

  it('records an exact process/provider/version handshake and exposes its bounded observation', () => {
    expect(wasOpenCodeBrokerLoadHandshakeObserved(observationKey(), 1_000)).toBe(false);
    recordOpenCodeBrokerLoadHandshake(handshake(), 1_000);
    expect(wasOpenCodeBrokerLoadHandshakeObserved(observationKey(), 1_500)).toBe(true);
    expect(readOpenCodeBrokerLoadHandshakeObservation(observationKey(), 1_500)).toEqual({
      runtimeKind: 'opencode_managed_server',
      selectionIdentity: IDENTITY,
      loadNonce: 'spawn-a',
      providers: ['openai'],
      pluginVersion: PLUGIN_VERSION,
      processPid: PROCESS_PID,
      observedAtMs: 1_000,
    });
  });

  it('requires selection identity, nonce, complete provider set, and plugin version to match', () => {
    recordOpenCodeBrokerLoadHandshake(handshake(), 1_000);

    expect(wasOpenCodeBrokerLoadHandshakeObserved(observationKey(), 1_500)).toBe(true);
    expect(wasOpenCodeBrokerLoadHandshakeObserved(
      observationKey({ selectionIdentity: 'other-identity' }),
      1_500,
    )).toBe(false);
    expect(wasOpenCodeBrokerLoadHandshakeObserved(
      observationKey({ loadNonce: 'spawn-b' }),
      1_500,
    )).toBe(false);
    expect(wasOpenCodeBrokerLoadHandshakeObserved(
      observationKey({ providers: ['anthropic'] }),
      1_500,
    )).toBe(false);
    expect(wasOpenCodeBrokerLoadHandshakeObserved(
      observationKey({ providers: ['openai', 'anthropic'] }),
      1_500,
    )).toBe(false);
    expect(wasOpenCodeBrokerLoadHandshakeObserved(
      observationKey({ pluginVersion: '2' }),
      1_500,
    )).toBe(false);
  });

  it('aggregates same-process provider handshakes and rejects conflicting process/version evidence', () => {
    recordOpenCodeBrokerLoadHandshake(handshake({ providers: ['openai'] }), 1_000);
    recordOpenCodeBrokerLoadHandshake(handshake({ providers: ['anthropic'] }), 1_100);

    expect(readOpenCodeBrokerLoadHandshakeObservation(
      observationKey({ providers: ['anthropic', 'openai'] }),
      1_500,
    )).toEqual(expect.objectContaining({
      providers: ['anthropic', 'openai'],
      processPid: PROCESS_PID,
      pluginVersion: PLUGIN_VERSION,
    }));

    recordOpenCodeBrokerLoadHandshake(handshake({
      providers: ['openai'],
      processPid: PROCESS_PID + 1,
    }), 1_600);
    expect(readOpenCodeBrokerLoadHandshakeObservation(
      observationKey({ providers: ['anthropic', 'openai'] }),
      1_700,
    )).toBeNull();

    resetOpenCodeBrokerLoadHandshakesForTests();
    recordOpenCodeBrokerLoadHandshake(handshake(), 2_000);
    recordOpenCodeBrokerLoadHandshake(handshake({ pluginVersion: '2' }), 2_100);
    expect(readOpenCodeBrokerLoadHandshakeObservation(observationKey(), 2_200)).toBeNull();
  });

  it('keeps the exact observation for the daemon lifetime instead of expiring a healthy child by wall clock', () => {
    recordOpenCodeBrokerLoadHandshake(handshake(), 1_000);
    // The generated plugin handshakes once. Child-generation identity and exact process proof—not a
    // timer—bound authority, so a healthy long-lived managed child remains usable after 24 hours.
    expect(wasOpenCodeBrokerLoadHandshakeObserved(
      observationKey(),
      1_000 + 48 * 60 * 60 * 1000,
    )).toBe(true);
  });

  it('bounds abandoned daemon-local nonce observations without adding a child-expiry timer', () => {
    for (let index = 0; index < 1_025; index += 1) {
      recordOpenCodeBrokerLoadHandshake(handshake({
        selectionIdentity: `opencode|connected|broker:1|openai-codex:p:${index}`,
        loadNonce: `spawn-${index}`,
      }), 1_000 + index);
    }

    expect(readOpenCodeBrokerLoadHandshakeObservation(observationKey({
      selectionIdentity: 'opencode|connected|broker:1|openai-codex:p:0',
      loadNonce: 'spawn-0',
    }))).toBeNull();
    expect(readOpenCodeBrokerLoadHandshakeObservation(observationKey({
      selectionIdentity: 'opencode|connected|broker:1|openai-codex:p:1024',
      loadNonce: 'spawn-1024',
    }))).not.toBeNull();
  });

  it('validates the handshake request schema', () => {
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse(handshake()).success).toBe(true);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      loadNonce: undefined,
    }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      selectionIdentity: '',
    }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      providers: ['nope'],
    }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      pluginVersion: undefined,
    }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      processPid: 0,
    }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      runtimeKind: undefined,
    }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      runtimeKind: 'pi_rpc_process',
    }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      selectionIdentity: 'unknown|connected|broker:1|openai-codex:p:',
    }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      providers: ['openai', 'anthropic', 'openai'],
    }).success).toBe(false);
    expect(OpenCodeBrokerLoadHandshakeRequestSchema.safeParse({
      ...handshake(),
      selectionIdentity: `opencode|${'x'.repeat(4_096)}`,
    }).success).toBe(false);
  });
});
