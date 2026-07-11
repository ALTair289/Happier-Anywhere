import { describe, expect, it } from 'vitest';

import {
  CLIENT_COMPATIBILITY_HTTP_HEADERS_V1,
  CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
  CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
  CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
  ClientCompatibilityCapabilitiesV1Schema,
  ClientCompatibilityDeclarationV1Schema,
  ClientCompatibilitySocketAuthV1Schema,
  ClientUpgradeRequiredV1Schema,
  ClientVersionCheckRequestV1Schema,
  ClientVersionCheckResponseV1Schema,
  SESSION_SYNC_PROTOCOL_VERSION_V1,
  SessionSyncCompatibilityDecisionSchema,
  SessionSyncServerRequirementsV1Schema,
  VERSION_ENDPOINT_PATH,
  buildClientCompatibilityHttpHeadersV1,
  buildClientCompatibilitySocketAuthV1,
  classifySessionSyncProtocolCompatibility,
  parseClientCompatibilityHttpHeadersV1,
  parseClientCompatibilitySocketAuthV1,
} from './index.js';

const declaration = {
  v: 1 as const,
  clientKind: 'ui-web' as const,
  appVersion: '0.12.0-preview.3+build.7',
  releaseChannel: 'preview',
  sessionSyncProtocolVersion: 2,
};

describe('client compatibility protocol contracts', () => {
  it('defines a monotonic session-sync protocol epoch', () => {
    expect(SESSION_SYNC_PROTOCOL_VERSION_V1).toBe(1);
    expect(CURRENT_SESSION_SYNC_PROTOCOL_VERSION).toBe(2);
    expect(CURRENT_SESSION_SYNC_PROTOCOL_VERSION).toBeGreaterThan(SESSION_SYNC_PROTOCOL_VERSION_V1);
  });

  it('accepts only strict, bounded, canonical client declarations', () => {
    expect(ClientCompatibilityDeclarationV1Schema.parse(declaration)).toEqual(declaration);
    expect(ClientCompatibilityDeclarationV1Schema.safeParse({ ...declaration, clientKind: 'browser' }).success).toBe(false);
    expect(ClientCompatibilityDeclarationV1Schema.safeParse({ ...declaration, appVersion: `1.${'0'.repeat(128)}` }).success).toBe(false);
    expect(ClientCompatibilityDeclarationV1Schema.safeParse({ ...declaration, appVersion: ' 0.12.0' }).success).toBe(false);
    expect(ClientCompatibilityDeclarationV1Schema.safeParse({ ...declaration, releaseChannel: 'Preview' }).success).toBe(false);
    expect(ClientCompatibilityDeclarationV1Schema.safeParse({ ...declaration, extra: true }).success).toBe(false);
  });

  it('models observe/required server requirements and one strict capability envelope', () => {
    const requirements = {
      v: 1 as const,
      enforcement: 'required' as const,
      minimumSessionSyncProtocolVersion: 2,
      declarationTransport: 'headers-v1' as const,
      minimumVersionsByClientKind: {
        'ui-web': '0.12.0',
        cli: '0.12.0-preview.1',
      },
      upgradeUrlsByClientKind: {
        'ui-web': 'https://app.happier.dev/update?channel=stable',
      },
    };

    expect(SessionSyncServerRequirementsV1Schema.parse(requirements)).toEqual(requirements);
    expect(ClientCompatibilityCapabilitiesV1Schema.parse({ v: 1, sessionSync: requirements })).toEqual({
      v: 1,
      sessionSync: requirements,
    });
    expect(SessionSyncServerRequirementsV1Schema.safeParse({ ...requirements, enforcement: 'warn' }).success).toBe(false);
    expect(SessionSyncServerRequirementsV1Schema.safeParse({
      ...requirements,
      upgradeUrlsByClientKind: { 'ui-web': 'http://app.happier.dev/update' },
    }).success).toBe(false);
    expect(SessionSyncServerRequirementsV1Schema.safeParse({
      ...requirements,
      upgradeUrlsByClientKind: { 'ui-web': ' https://app.happier.dev/update' },
    }).success).toBe(false);
    expect(SessionSyncServerRequirementsV1Schema.safeParse({
      ...requirements,
      upgradeUrlsByClientKind: { 'ui-web': 'https://app.happier.dev/\tupdate' },
    }).success).toBe(false);
    expect(SessionSyncServerRequirementsV1Schema.safeParse({ ...requirements, extra: true }).success).toBe(false);
  });

  it('uses one bounded upgrade-required payload for HTTP and socket failures', () => {
    const payload = {
      error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
      requirement: {
        v: 1 as const,
        minimumSessionSyncProtocolVersion: 2,
        clientKind: 'ui-web' as const,
        minimumAppVersion: '0.12.0',
        updateUrl: 'https://app.happier.dev/update',
      },
    };

    expect(CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).toBe(426);
    expect(ClientUpgradeRequiredV1Schema.parse(payload)).toEqual(payload);
    expect(ClientUpgradeRequiredV1Schema.safeParse({
      ...payload,
      requirement: { ...payload.requirement, updateUrl: 'https://user:secret@app.happier.dev/update' },
    }).success).toBe(false);
    expect(ClientUpgradeRequiredV1Schema.safeParse({ ...payload, sessionId: 'secret' }).success).toBe(false);
  });

  it('builds and parses the exact HTTP header declaration', () => {
    const headers = buildClientCompatibilityHttpHeadersV1(declaration);

    expect(headers).toEqual({
      [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.clientKind]: 'ui-web',
      [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.appVersion]: '0.12.0-preview.3+build.7',
      [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.releaseChannel]: 'preview',
      [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.sessionSyncProtocolVersion]: '2',
    });
    expect(parseClientCompatibilityHttpHeadersV1(headers)).toEqual({ status: 'valid', declaration });
    expect(parseClientCompatibilityHttpHeadersV1({
      'X-Happier-Client-Kind': 'ui-web',
      'X-Happier-Client-Version': '0.12.0-preview.3+build.7',
      'X-Happier-Client-Release-Channel': 'preview',
      'X-Happier-Session-Sync-Protocol': '2',
    })).toEqual({ status: 'valid', declaration });
  });

  it('distinguishes missing declarations from malformed, duplicate, and comma-joined headers', () => {
    expect(parseClientCompatibilityHttpHeadersV1({ authorization: 'Bearer token' })).toEqual({ status: 'missing' });
    expect(parseClientCompatibilityHttpHeadersV1({
      [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.clientKind]: 'ui-web',
    })).toEqual({ status: 'malformed' });
    expect(parseClientCompatibilityHttpHeadersV1({
      ...buildClientCompatibilityHttpHeadersV1(declaration),
      'X-Happier-Client-Kind': 'ui-web',
    })).toEqual({ status: 'malformed' });
    expect(parseClientCompatibilityHttpHeadersV1({
      ...buildClientCompatibilityHttpHeadersV1(declaration),
      [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.appVersion]: '0.12.0, 0.12.1',
    })).toEqual({ status: 'malformed' });
    expect(parseClientCompatibilityHttpHeadersV1({
      ...buildClientCompatibilityHttpHeadersV1(declaration),
      [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.sessionSyncProtocolVersion]: ['2'],
    })).toEqual({ status: 'malformed' });
  });

  it('builds and parses a nested Socket.IO auth declaration without constraining sibling auth fields', () => {
    const compatibilityAuth = buildClientCompatibilitySocketAuthV1(declaration);

    expect(compatibilityAuth).toEqual({ clientCompatibility: declaration });
    expect(ClientCompatibilitySocketAuthV1Schema.parse({ token: 'secret', ...compatibilityAuth })).toEqual({
      token: 'secret',
      ...compatibilityAuth,
    });
    expect(parseClientCompatibilitySocketAuthV1({ token: 'secret', ...compatibilityAuth })).toEqual({
      status: 'valid',
      declaration,
    });
    expect(parseClientCompatibilitySocketAuthV1({ token: 'secret' })).toEqual({ status: 'missing' });
    expect(parseClientCompatibilitySocketAuthV1({
      clientCompatibility: { ...declaration, unknown: true },
    })).toEqual({ status: 'malformed' });
  });

  it.each([
    [undefined, 'missing'],
    [null, 'missing'],
    ['', 'malformed'],
    ['2', 'malformed'],
    [0, 'malformed'],
    [1, 'older'],
    [2, 'exact'],
    [3, 'future'],
  ] as const)('classifies protocol value %p as %s', (value, expected) => {
    expect(SessionSyncCompatibilityDecisionSchema.parse(expected)).toBe(expected);
    expect(classifySessionSyncProtocolCompatibility(value, 2)).toBe(expected);
  });

  it('owns one strict /v1/version request and response contract with a required-upgrade state', () => {
    expect(VERSION_ENDPOINT_PATH).toBe('/v1/version');
    expect(ClientVersionCheckRequestV1Schema.parse({
      v: 1,
      clientKind: 'ui-ios',
      appVersion: '0.11.0',
      releaseChannel: 'stable',
      appId: 'dev.happier.app',
    })).toEqual({
      v: 1,
      clientKind: 'ui-ios',
      appVersion: '0.11.0',
      releaseChannel: 'stable',
      appId: 'dev.happier.app',
    });

    const required = {
      v: 1 as const,
      status: 'upgrade-required' as const,
      minimumAppVersion: '0.12.0',
      latestAppVersion: '0.12.3',
      updateUrl: null,
    };
    expect(ClientVersionCheckResponseV1Schema.parse(required)).toEqual(required);
    expect(ClientVersionCheckResponseV1Schema.safeParse({
      v: 1,
      status: 'current',
      updateUrl: 'https://app.happier.dev/update',
    }).success).toBe(false);
    expect(ClientVersionCheckResponseV1Schema.safeParse({
      ...required,
      updateUrl: 'http://app.happier.dev/update',
    }).success).toBe(false);
  });
});
