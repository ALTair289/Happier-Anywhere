import { describe, expect, it } from 'vitest';

import { buildSpawnHappySessionRpcParams } from './spawnSessionPayload';

describe('buildSpawnHappySessionRpcParams', () => {
    it('preserves exact nonblank opaque model identifiers', () => {
        expect(buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'cursor' },
            modelId: ' model-a ',
            modelUpdatedAt: 123,
        } as any)).toEqual(expect.objectContaining({ modelId: ' model-a ', modelUpdatedAt: 123 }));
    });

    it('preserves exact nonblank opaque agent mode identifiers', () => {
        expect(buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'cursor' },
            agentModeId: ' plan\t',
            agentModeUpdatedAt: 123,
        } as any)).toEqual(expect.objectContaining({ agentModeId: ' plan\t', agentModeUpdatedAt: 123 }));
    });

    it('includes configured ACP backend targets and omits removed workspace linkage fields', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        }));
        expect(params).not.toHaveProperty('workspaceId');
        expect(params).not.toHaveProperty('workspaceLocationId');
        expect(params).not.toHaveProperty('workspaceCheckoutId');
    });

    it('prefers codexBackendMode over legacy experimentalCodexAcp when provided together', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            experimentalCodexAcp: true,
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
        }));
        expect(params).not.toHaveProperty('experimentalCodexAcp');
    });

    it('normalizes legacy experimentalCodexAcp onto canonical codexBackendMode when codexBackendMode is absent', () => {
        expect(buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            experimentalCodexAcp: true,
        } as any)).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'acp',
            agentRuntimeDescriptorV1: expect.objectContaining({
                v: 1,
                providerId: 'codex',
                provider: expect.objectContaining({
                    backendMode: 'acp',
                }),
            }),
        }));
    });

    it('prefers agentRuntimeDescriptorV1 over legacy experimentalCodexAcp when codexBackendMode is absent', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            experimentalCodexAcp: true,
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'codex-session-2',
                },
            },
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'codex-session-2',
                },
            },
        }));
        expect(params).not.toHaveProperty('experimentalCodexAcp');
    });

    it('derives agentRuntimeDescriptorV1 for codex spawn requests when codexBackendMode is set', () => {
        expect(buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'codex-session-1',
            codexBackendMode: 'appServer',
        } as any)).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            agentRuntimeDescriptorV1: expect.objectContaining({
                v: 1,
                providerId: 'codex',
                provider: expect.objectContaining({
                    backendMode: 'appServer',
                    vendorSessionId: 'codex-session-1',
                }),
            }),
        }));
    });

    it('omits legacy spawn token passthrough when present on a compatibility-shaped input', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            token: 'legacy-spawn-token',
        } as any);

        expect(params).not.toHaveProperty('token');
    });

    it('includes the account settings version hint in daemon spawn requests', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            accountSettingsVersionHint: 12,
        } as any);

        expect(params).toEqual(expect.objectContaining({
            accountSettingsVersionHint: 12,
        }));
    });

    it('keeps first-input authority out of the daemon spawn wire', () => {
        const compatibilityInput = {
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            initialPrompt: '  preserve this exact prompt  ',
            spawnNonce: ' spawn-nonce-opaque ',
            executionAuthorization: {
                provenance: 'user_request',
                requestId: ' first-turn-123 ',
            },
        } as unknown as Parameters<typeof buildSpawnHappySessionRpcParams>[0];
        const params = buildSpawnHappySessionRpcParams(compatibilityInput);

        expect(params).toEqual(expect.objectContaining({
            spawnNonce: ' spawn-nonce-opaque ',
        }));
        expect(params).not.toHaveProperty('initialPrompt');
        expect(params).not.toHaveProperty('executionAuthorization');
    });
});
