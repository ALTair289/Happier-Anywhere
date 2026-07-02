import { describe, expect, it } from 'vitest';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '@/backends/opencode/server/openCodeManagedServerEnv';

import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  serializeOpenCodeBrokerSelections,
} from './openCodeBrokerPluginEnv';
import {
  OPEN_CODE_BROKER_REFRESH_TOKEN_ENV,
  deriveOpenCodeBrokerRefreshToken,
} from './openCodeBrokerCapabilityToken';
import { applyOpenCodeBrokerRefreshTokenEnv } from './injectOpenCodeBrokerRefreshToken';

const MASTER = 'master-control-token';

function brokeredEnv(): NodeJS.ProcessEnv {
  return {
    [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|broker:1|openai-codex:p:',
    [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null },
    }),
    [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: '/tmp/daemon.state.json',
  };
}

describe('applyOpenCodeBrokerRefreshTokenEnv', () => {
  it('injects ONLY the scoped token (never the master) for a connected brokered session', () => {
    const env = brokeredEnv();
    applyOpenCodeBrokerRefreshTokenEnv(env, () => MASTER);
    expect(env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV]).toBe(deriveOpenCodeBrokerRefreshToken(MASTER));
    // The master control token must NOT appear anywhere in the env we hand to OpenCode.
    for (const value of Object.values(env)) {
      expect(typeof value === 'string' ? value : '').not.toContain(MASTER);
    }
  });

  it('is a no-op for native sessions (no selection identity)', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/u' };
    applyOpenCodeBrokerRefreshTokenEnv(env, () => MASTER);
    expect(env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV]).toBeUndefined();
  });

  it('is a no-op for direct-API-key connected sessions (selection identity but no brokered provider)', () => {
    const env: NodeJS.ProcessEnv = {
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|broker:1|anthropic:k:',
    };
    applyOpenCodeBrokerRefreshTokenEnv(env, () => MASTER);
    expect(env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV]).toBeUndefined();
  });

  it('does NOT inject when the control token is unavailable (fail-closed; broker preflight catches it)', () => {
    const env = brokeredEnv();
    applyOpenCodeBrokerRefreshTokenEnv(env, () => null);
    expect(env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV]).toBeUndefined();
  });
});
