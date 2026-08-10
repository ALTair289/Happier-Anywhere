import { describe, expect, it } from 'vitest';

import {
  parseRemoteBootstrapMachineParams,
  redactRemoteBootstrapPayload,
} from './remoteSshBootstrapMachineKind.js';

const BASE_PARAMS = {
  ssh: {
    target: 'dev@example.test',
    auth: 'agent',
  },
  relay: {
    relayUrl: 'https://relay.example.test',
  },
};

describe('parseRemoteBootstrapMachineParams local CLI payload', () => {
  it('preserves an optional local payload root for the live SSH installer', () => {
    const parsed = parseRemoteBootstrapMachineParams({
      ...BASE_PARAMS,
      cliPayload: {
        rootPath: '/verified/happier-v0.2.10-linux-x64',
      },
    });

    expect(parsed.cliPayload).toEqual({
      rootPath: '/verified/happier-v0.2.10-linux-x64',
    });
  });

  it('keeps the released download behavior when no local payload is supplied', () => {
    const parsed = parseRemoteBootstrapMachineParams(BASE_PARAMS);

    expect(parsed.cliPayload).toBeUndefined();
  });

  it('rejects malformed local payload config instead of silently downloading', () => {
    expect(() => parseRemoteBootstrapMachineParams({
      ...BASE_PARAMS,
      cliPayload: {
        rootPath: '',
      },
    })).toThrow(/cliPayload\.rootPath/i);
  });

  it('redacts the operator-local payload path from task output', () => {
    const sensitivePath = 'C:\\Users\\operator\\private\\happier-v0.2.10-linux-x64';
    const redacted = redactRemoteBootstrapPayload({
      ...BASE_PARAMS,
      cliPayload: {
        rootPath: sensitivePath,
      },
    });

    expect(redacted.cliPayload).toEqual({ provided: true });
    expect(JSON.stringify(redacted)).not.toContain(sensitivePath);
    expect(JSON.stringify(redacted)).not.toContain('rootPath');
  });
});
