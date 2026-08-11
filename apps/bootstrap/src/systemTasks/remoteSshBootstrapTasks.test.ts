import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RemoteBootstrapMachineParams } from '@happier-dev/cli-common/systemTasks';
import { describe, expect, it, vi } from 'vitest';

import {
    installRemoteCliDefault,
    approveLocalRemoteAuthRequestDefault,
    resolveRemoteSshHostTrustDefault,
    runRemoteBootstrapCommandDefault,
} from './remoteSshBootstrapTasks.js';

const SCANNED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const DIFFERENT_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function createParsedRemoteBootstrapParams(channel: 'stable' | 'preview' | 'dev' = 'stable'): RemoteBootstrapMachineParams {
    return {
        ssh: {
            target: 'dev@example.test',
            auth: 'agent',
        },
        relay: {
            relayUrl: 'https://relay.example.test',
        },
        channel,
    };
}

describe('resolveRemoteSshHostTrustDefault', () => {
    it('prompts to replace a mismatched persisted host key instead of trusting the host implicitly', async () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'hsetup-known-hosts-'));
        const knownHostsPath = join(tempDir, 'known_hosts');
        const runCommandCapture = vi.fn(async () => ({
            status: 0,
            stdout: `${SCANNED_HOST_KEY}\n`,
            stderr: '',
        }));

        writeFileSync(knownHostsPath, `${DIFFERENT_HOST_KEY}\n`, 'utf8');

        try {
            const resolution = await resolveRemoteSshHostTrustDefault({
                ssh: {
                    target: 'dev@example.test',
                    auth: 'agent',
                    knownHostsPath,
                },
                knownHostsMode: 'app',
            }, { runCommandCapture });

            expect(resolution.status).toBe('prompt');
            if (resolution.status !== 'prompt') {
                throw new Error('Expected an SSH trust prompt.');
            }
            expect(resolution.promptKind).toBe('ssh.replaceHostKey');
            expect(resolution.promptData).toEqual({
                host: 'example.test',
                keyType: 'ssh-ed25519',
                fingerprint: expect.stringMatching(/^SHA256:/),
                existingFingerprint: expect.stringMatching(/^SHA256:/),
            });

            await resolution.accept();

            expect(readFileSync(knownHostsPath, 'utf8').trim()).toBe(SCANNED_HOST_KEY);
            expect(runCommandCapture).toHaveBeenCalledTimes(1);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when an explicit trusted host key does not match the fresh scan result', async () => {
        const runCommandCapture = vi.fn(async () => ({
            status: 0,
            stdout: `${SCANNED_HOST_KEY}\n`,
            stderr: '',
        }));

        await expect(resolveRemoteSshHostTrustDefault({
            ssh: {
                target: 'dev@example.test',
                auth: 'agent',
                trustedHostKey: DIFFERENT_HOST_KEY,
            },
            knownHostsMode: 'app',
        }, { runCommandCapture })).rejects.toThrow(/trusted host key/i);
        expect(runCommandCapture).toHaveBeenCalledTimes(1);
    });
});

describe('installRemoteCliDefault', () => {
    it('delegates remote CLI installation to the shared first-party installer', async () => {
        const invocations: Array<Record<string, unknown>> = [];

        await installRemoteCliDefault({
            parsed: createParsedRemoteBootstrapParams(),
            auth: { mode: 'agent' },
            knownHostsMode: 'system',
        }, {
            installRemoteFirstPartyComponent: async (params) => {
                invocations.push(params as Record<string, unknown>);
                return {
                    binaryPath: '$HOME/.happier/cli/current/happier',
                    versionId: '1.2.3',
                    source: 'https://example.test/happier.tgz',
                };
            },
        });

        expect(invocations).toEqual([
            expect.objectContaining({
                componentId: 'happier-cli',
                channel: 'stable',
                knownHostsMode: 'system',
            }),
        ]);
    });
});

describe('approveLocalRemoteAuthRequestDefault', () => {
    it('uses the managed local happier cli runner instead of depending on PATH resolution', async () => {
        const runLocalHappierJsonCommand = vi.fn(async (params: Readonly<{ args: readonly string[] }>) => {
            expect(params.args).toEqual([
                'auth',
                'approve',
                '--public-key',
                'public-key-123',
                '--json',
                '--persist',
                '--server-url=https://relay.example.test',
                '--webapp-url=https://relay.example.test',
            ]);
            return { success: true };
        });

        await approveLocalRemoteAuthRequestDefault({
            publicKey: 'public-key-123',
            parsed: createParsedRemoteBootstrapParams(),
        }, {
            runLocalHappierJsonCommand,
        });

        expect(runLocalHappierJsonCommand).toHaveBeenCalledTimes(1);
    });
});

describe('runRemoteBootstrapCommandDefault', () => {
    it('uses the channel-specific managed CLI path instead of a hardcoded bin shim path', async () => {
        let remoteCommand = '';
        const runCommandCapture = vi.fn(async (params: Readonly<{ args?: readonly string[] }>) => {
            remoteCommand = params.args?.at(-1) ?? '';
            return {
                status: 0,
                stdout: `${JSON.stringify({ ok: true, data: { authenticated: false } })}\n`,
                stderr: '',
            };
        });

        await runRemoteBootstrapCommandDefault({
            label: 'auth.status',
            parsed: createParsedRemoteBootstrapParams('preview'),
            auth: { mode: 'agent' },
            knownHostsMode: 'system',
        }, { runCommandCapture });

        expect(remoteCommand).toContain('$HOME/.happier/cli-preview/current/happier auth status --json');
        expect(remoteCommand).not.toContain('$HOME/.happier/bin/happier');
        expect(runCommandCapture).toHaveBeenCalledTimes(1);
    });
});
