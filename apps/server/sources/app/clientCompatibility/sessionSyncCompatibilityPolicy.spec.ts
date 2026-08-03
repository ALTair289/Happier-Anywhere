import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
    CLIENT_COMPATIBILITY_HTTP_HEADERS_V1,
    buildClientCompatibilityHttpHeadersV1,
} from '@happier-dev/protocol';

import {
    SESSION_SYNC_COMPATIBILITY_ENV_KEYS,
    resolveSessionSyncCompatibilityPolicy,
} from './policy';
import { evaluateSessionSyncCompatibility } from './decision';
import { createSessionSyncCompatibilityHttpPreHandler } from './httpEnforcement';
import { isSessionSyncHttpRoute } from './routeInventory';
import { evaluateSessionSyncSocketCompatibility } from './socketEnforcement';

const compatibleDeclaration = {
    v: 1 as const,
    clientKind: 'ui-web' as const,
    appVersion: '0.2.10',
    releaseChannel: 'preview',
    sessionSyncProtocolVersion: 2,
};

// Immutable released UI evidence for F-087: ui-web-v0.2.6-preview.2
// (1f8fcd20bfd67786cc8a60f59060fd5b6e9846db) has package version 0.2.6,
// performs the broad session-end Stop fallback, and predates the v1 client
// compatibility declaration. Its HTTP/socket declaration vector is therefore
// intentionally absent rather than reconstructed from current UI types.
const f087LegacyUiWebPreviewDeclaration = { status: 'missing' } as const;

const f087CurrentUiWebDeclaration = {
    ...compatibleDeclaration,
    appVersion: '0.2.10',
};

function requiredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.enforcement]: 'required',
        [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumProtocolVersion]: '2',
        [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumVersionsByClientKind]: JSON.stringify({
            daemon: '0.2.10',
            'session-runner': '0.2.10',
        }),
        ...overrides,
    };
}

describe('session-sync compatibility policy', () => {
    it('defaults to valid observe mode at the current protocol floor', () => {
        const policy = resolveSessionSyncCompatibilityPolicy({});

        expect(policy.valid).toBe(true);
        expect(policy.requirements).toMatchObject({
            enforcement: 'observe',
            minimumSessionSyncProtocolVersion: 2,
        });
    });

    it('rejects provider-host activation when explicitly required policy input is malformed', () => {
        const policy = resolveSessionSyncCompatibilityPolicy(requiredEnv({
            [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumProtocolVersion]: '2.5',
        }));

        expect(policy.valid).toBe(false);
        expect(policy.requirements.enforcement).toBe('observe');
        expect(evaluateSessionSyncCompatibility({
            status: 'valid',
            declaration: {
                ...compatibleDeclaration,
                clientKind: 'daemon',
            },
        }, policy)).toMatchObject({
            accepted: false,
            outcome: 'reject-policy-invalid',
            upgradeRequired: { error: 'client-upgrade-required' },
        });
    });

    it('fails closed when a configured minimum app version is not semantic-version comparable', () => {
        const policy = resolveSessionSyncCompatibilityPolicy(requiredEnv({
            [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumVersionsByClientKind]: JSON.stringify({
                'ui-web': 'latest',
            }),
        }));

        expect(policy.valid).toBe(false);
        expect(policy.requirements.enforcement).toBe('observe');
    });

    it.each(['daemon', 'session-runner'] as const)(
        'rejects %s activation when required policy omits its configured app-version floor',
        (clientKind) => {
            const otherKind = clientKind === 'daemon' ? 'session-runner' : 'daemon';
            const policy = resolveSessionSyncCompatibilityPolicy(requiredEnv({
                [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumVersionsByClientKind]: JSON.stringify({
                    [otherKind]: '0.2.10',
                }),
            }));

            expect(evaluateSessionSyncCompatibility({
                status: 'valid',
                declaration: {
                    ...compatibleDeclaration,
                    clientKind,
                },
            }, policy)).toMatchObject({
                accepted: false,
                outcome: 'reject-policy-invalid',
                upgradeRequired: {
                    error: 'client-upgrade-required',
                    requirement: {
                        clientKind,
                        minimumAppVersion: null,
                    },
                },
            });
        },
    );

    it('accepts exact and future protocol declarations but rejects missing, malformed, and older in required mode', () => {
        const policy = resolveSessionSyncCompatibilityPolicy(requiredEnv());

        expect(evaluateSessionSyncCompatibility({ status: 'missing' }, policy).outcome).toBe('reject-missing');
        expect(evaluateSessionSyncCompatibility({ status: 'malformed' }, policy).outcome).toBe('reject-malformed');
        expect(evaluateSessionSyncCompatibility({
            status: 'valid',
            declaration: { ...compatibleDeclaration, sessionSyncProtocolVersion: 1 },
        }, policy).outcome).toBe('reject-protocol-too-old');
        expect(evaluateSessionSyncCompatibility({
            status: 'valid',
            declaration: compatibleDeclaration,
        }, policy).outcome).toBe('accepted');
        expect(evaluateSessionSyncCompatibility({
            status: 'valid',
            declaration: { ...compatibleDeclaration, sessionSyncProtocolVersion: 3 },
        }, policy).outcome).toBe('accepted');
    });

    it('enforces configured minimum app versions without using app semver as the protocol gate', () => {
        const policy = resolveSessionSyncCompatibilityPolicy(requiredEnv({
            [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumVersionsByClientKind]: JSON.stringify({
                'ui-web': '0.2.11',
            }),
        }));

        const rejected = evaluateSessionSyncCompatibility({
            status: 'valid',
            declaration: compatibleDeclaration,
        }, policy);
        expect(rejected.outcome).toBe('reject-app-version-too-old');
        expect(rejected.upgradeRequired?.requirement).toMatchObject({
            clientKind: 'ui-web',
            minimumAppVersion: '0.2.11',
        });
    });

    it('rejects the provenance-pinned legacy UI while admitting the current declared UI at the server compatibility owner', () => {
        const policy = resolveSessionSyncCompatibilityPolicy(requiredEnv({
            [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumVersionsByClientKind]: JSON.stringify({
                'ui-web': '0.2.10',
            }),
        }));

        expect(evaluateSessionSyncCompatibility(f087LegacyUiWebPreviewDeclaration, policy)).toMatchObject({
            accepted: false,
            outcome: 'reject-missing',
            upgradeRequired: {
                error: 'client-upgrade-required',
            },
        });
        expect(evaluateSessionSyncCompatibility({
            status: 'valid',
            declaration: f087CurrentUiWebDeclaration,
        }, policy)).toMatchObject({
            accepted: true,
            outcome: 'accepted',
            upgradeRequired: null,
        });
    });

    it('rejects a valid declaration whose client kind cannot own the socket role', () => {
        const policy = resolveSessionSyncCompatibilityPolicy(requiredEnv());

        const rejected = evaluateSessionSyncCompatibility({
            status: 'valid',
            declaration: compatibleDeclaration,
        }, policy, { allowedClientKinds: ['session-runner'] });

        expect(rejected.outcome).toBe('reject-client-kind-mismatch');
        expect(rejected.accepted).toBe(false);
        expect(rejected.upgradeRequired?.requirement).toMatchObject({
            clientKind: null,
            minimumAppVersion: null,
            updateUrl: null,
        });
    });

    it('applies the canonical client-kind constraint at the socket boundary', () => {
        const result = evaluateSessionSyncSocketCompatibility({
            clientCompatibility: compatibleDeclaration,
        }, requiredEnv(), 'session-scoped');

        expect(result.evaluation.outcome).toBe('reject-client-kind-mismatch');
    });

    it('allows a session runner to own its auxiliary user-scoped socket', () => {
        const result = evaluateSessionSyncSocketCompatibility({
            clientCompatibility: {
                ...compatibleDeclaration,
                clientKind: 'session-runner',
            },
        }, requiredEnv(), 'user-scoped');

        expect(result.evaluation.outcome).toBe('accepted');
    });
});

describe('session-sync HTTP enforcement', () => {
    async function injectProbe(env: NodeJS.ProcessEnv, headers: Record<string, string | string[]> = {}) {
        const app = Fastify();
        app.get('/v2/sessions', {
            preHandler: createSessionSyncCompatibilityHttpPreHandler(() => env),
        }, async () => ({ ok: true }));
        const response = await app.inject({ method: 'GET', url: '/v2/sessions', headers });
        await app.close();
        return response;
    }

    it('returns the protocol-owned 426 payload before a protected route runs', async () => {
        const response = await injectProbe(requiredEnv());

        expect(response.statusCode).toBe(426);
        expect(response.json()).toEqual({
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                minimumSessionSyncProtocolVersion: 2,
                clientKind: null,
                minimumAppVersion: null,
                updateUrl: null,
            },
        });
    });

    it('accepts exact/future declarations and observe-mode legacy requests', async () => {
        const exact = await injectProbe(requiredEnv(), buildClientCompatibilityHttpHeadersV1(compatibleDeclaration));
        const future = await injectProbe(requiredEnv(), buildClientCompatibilityHttpHeadersV1({
            ...compatibleDeclaration,
            sessionSyncProtocolVersion: 3,
        }));
        const observed = await injectProbe({}, {});

        expect(exact.statusCode).toBe(200);
        expect(future.statusCode).toBe(200);
        expect(observed.statusCode).toBe(200);
    });

    it('rejects Fastify array-normalized duplicate headers as malformed', async () => {
        const headers = {
            ...buildClientCompatibilityHttpHeadersV1(compatibleDeclaration),
            [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.clientKind]: ['ui-web', 'ui-web'],
        };
        const response = await injectProbe(requiredEnv(), headers);

        expect(response.statusCode).toBe(426);
    });
});

describe('session-sync route inventory', () => {
    it.each([
        '/v1/sessions',
        '/v1/sessions/:sessionId/messages',
        '/v2/sessions',
        '/v2/sessions/:sessionId',
        '/v2/session-organization',
        '/v2/session-organization/tags',
        '/v2/changes',
        '/v2/cursor',
    ])('protects %s', (route) => {
        expect(isSessionSyncHttpRoute(route)).toBe(true);
    });

    it.each([
        '/v1/features',
        '/v1/version',
        '/v1/auth/request',
        '/health',
    ])('keeps recovery/discovery route %s outside enforcement', (route) => {
        expect(isSessionSyncHttpRoute(route)).toBe(false);
    });
});
