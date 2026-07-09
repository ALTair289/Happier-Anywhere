import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY, type ClaudeEndpointState } from '@/daemon/sessionRegistry';
import { resolveClaudeAdoptEndpointRecovery } from './runClaude';

const originalEndpointStateEnv = process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];

async function reservePort(): Promise<Readonly<{ port: number; close: () => Promise<void> }>> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Failed to reserve a local port');
    }
    return {
        port: address.port,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

async function findAvailablePort(): Promise<number> {
    const reservation = await reservePort();
    const { port } = reservation;
    await reservation.close();
    return port;
}

async function writeRecoveryArtifacts(params: Readonly<{
    root: string;
    stateHookServerPort: number;
    hooksJsonHookServerPort?: number;
    mcpPort: number;
    permissionSecret?: string;
    statuslineSecret?: string;
}>): Promise<ClaudeEndpointState> {
    const hookPluginDir = join(params.root, 'hook-plugin');
    const hooksDir = join(hookPluginDir, 'hooks');
    const hookSettingsPath = join(params.root, 'session-hook.json');
    const hookSettingsOverlayPath = join(params.root, 'session-hook.overlay.json');
    const statuslineSecretFilePath = join(params.root, 'session-hook.statusline-secret');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hookPluginDir, 'permission-hook-secret'), params.permissionSecret ?? 'permission-secret', 'utf8');
    await writeFile(hookSettingsPath, '{}', 'utf8');
    await writeFile(hookSettingsOverlayPath, '{}', 'utf8');
    await writeFile(statuslineSecretFilePath, params.statuslineSecret ?? 'statusline-secret', 'utf8');
    await writeFile(join(hooksDir, 'hooks.json'), JSON.stringify({
        hooks: {
            SessionStart: [
                {
                    matcher: '',
                    hooks: [
                        {
                            type: 'command',
                            command: `"node" "/app/session_hook_forwarder.cjs" ${params.hooksJsonHookServerPort ?? params.stateHookServerPort} "SessionStart" --secret-file "${join(hookPluginDir, 'permission-hook-secret')}"`,
                        },
                    ],
                },
            ],
        },
    }), 'utf8');
    return {
        v: 1,
        hookServerPort: params.stateHookServerPort,
        hookPluginDir,
        hookSettingsPath,
        hookSettingsOverlayPath,
        statuslineSecretFilePath,
        mcpUrl: `http://127.0.0.1:${params.mcpPort}`,
        mcpPort: params.mcpPort,
    };
}

describe('resolveClaudeAdoptEndpointRecovery', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        if (originalEndpointStateEnv === undefined) {
            delete process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];
        } else {
            process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = originalEndpointStateEnv;
        }
        for (const dir of tempDirs.splice(0)) {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('returns null when the endpoint marker env is missing', async () => {
        delete process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
    });

    it('returns null when retained endpoint artifacts are missing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-missing-'));
        tempDirs.push(root);
        const state: ClaudeEndpointState = {
            v: 1,
            hookServerPort: await findAvailablePort(),
            hookPluginDir: join(root, 'missing-plugin'),
            hookSettingsPath: join(root, 'missing-settings.json'),
            mcpUrl: `http://127.0.0.1:${await findAvailablePort()}`,
            mcpPort: await findAvailablePort(),
        };
        process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify(state);

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
    });

    it('returns null when a retained endpoint port is already taken', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-port-'));
        tempDirs.push(root);
        const occupied = await reservePort();
        try {
            const state = await writeRecoveryArtifacts({
                root,
                stateHookServerPort: occupied.port,
                mcpPort: await findAvailablePort(),
            });
            process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify(state);

            await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
        } finally {
            await occupied.close();
        }
    });

    it('returns null when hooks.json points at a different hook server port than the marker', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-mismatch-'));
        tempDirs.push(root);
        const state = await writeRecoveryArtifacts({
            root,
            stateHookServerPort: await findAvailablePort(),
            hooksJsonHookServerPort: await findAvailablePort(),
            mcpPort: await findAvailablePort(),
        });
        process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify(state);

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
    });

    it('returns retained state and re-read secrets when artifacts and ports are valid', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-happy-'));
        tempDirs.push(root);
        const state = await writeRecoveryArtifacts({
            root,
            stateHookServerPort: await findAvailablePort(),
            mcpPort: await findAvailablePort(),
            permissionSecret: 'permission-secret-happy',
            statuslineSecret: 'statusline-secret-happy',
        });
        process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify(state);

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toEqual({
            state,
            permissionHookSecret: 'permission-secret-happy',
            statuslineSecret: 'statusline-secret-happy',
        });
    });
});
