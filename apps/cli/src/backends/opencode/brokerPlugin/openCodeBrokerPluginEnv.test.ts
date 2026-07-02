import { describe, expect, it } from 'vitest';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '@/backends/opencode/server/openCodeManagedServerEnv';

import {
  OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV,
  buildOpenCodeBrokerMarker,
  isOpenCodeBrokerMarker,
  parseOpenCodeBrokerSelections,
  readOpenCodeBrokerMarkerProvider,
  serializeOpenCodeBrokerSelections,
} from './openCodeBrokerPluginEnv';

describe('openCodeBrokerPluginEnv', () => {
  it('keeps the broker selection-identity env name in lockstep with the managed-server-env owner', () => {
    // The broker source must be self-contained (no import from the server module), so it duplicates the
    // env-var NAME. This guard fails loudly if the canonical owner ever renames it.
    expect(OPEN_CODE_BROKER_SELECTION_IDENTITY_ENV).toBe(OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV);
  });

  it('builds + detects broker markers and extracts the provider', () => {
    const marker = buildOpenCodeBrokerMarker('openai', '1');
    expect(marker).toBe('happier-broker:openai:1');
    expect(isOpenCodeBrokerMarker(marker)).toBe(true);
    expect(isOpenCodeBrokerMarker('sk-real-key')).toBe(false);
    expect(readOpenCodeBrokerMarkerProvider(marker)).toBe('openai');
    expect(readOpenCodeBrokerMarkerProvider(buildOpenCodeBrokerMarker('anthropic', '1'))).toBe('anthropic');
    expect(readOpenCodeBrokerMarkerProvider('sk-real-key')).toBeNull();
  });

  it('round-trips broker selections and rejects mismatched service ids', () => {
    const serialized = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'p1', accountId: 'acct', planType: 'pro' },
      anthropic: { serviceId: 'claude-subscription', profileId: 'p2', accountId: null, planType: null },
    });
    const parsed = parseOpenCodeBrokerSelections(serialized);
    expect(parsed.openai).toEqual({ serviceId: 'openai-codex', profileId: 'p1', accountId: 'acct', planType: 'pro' });
    expect(parsed.anthropic).toEqual({ serviceId: 'claude-subscription', profileId: 'p2', accountId: null, planType: null });

    expect(parseOpenCodeBrokerSelections('not json')).toEqual({});
    expect(parseOpenCodeBrokerSelections(undefined)).toEqual({});
    // Mismatched serviceId for the provider slot is dropped.
    expect(parseOpenCodeBrokerSelections(JSON.stringify({ openai: { serviceId: 'claude-subscription', profileId: 'x' } }))).toEqual({});
  });
});
