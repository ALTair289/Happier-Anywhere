import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { claudeRemoteDispatch } from './claudeRemoteDispatch';
import { getProjectPath } from '../utils/path';

describe('claudeRemoteDispatch', () => {
    it('routes to unified terminal before Agent SDK and clears the prior SDK-stream owner', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const mockUnified = vi.fn(async () => {});
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: {
                            permissionMode: 'default',
                            claudeRemoteAgentSdkEnabled: true,
                            claudeUnifiedTerminalEnabled: true,
                            claudeUnifiedTerminalHost: 'auto',
                        } as any,
                    };
                },
            } as any,
            {
                claudeRemote: mockLegacy,
                claudeRemoteAgentSdk: mockAgentSdk,
                claudeUnifiedTerminal: mockUnified,
                resolveClaudeUnifiedTerminalFeatureDecision: () => ({ state: 'enabled' }),
            } as any,
        );

        expect(onRunnerSelected).toHaveBeenCalledExactlyOnceWith(null);
        expect(mockUnified).toHaveBeenCalledTimes(1);
        expect(mockUnified).toHaveBeenCalledWith(expect.objectContaining({
            allowFirstInputBeforeSessionStart: true,
        }));
        expect(mockAgentSdk).toHaveBeenCalledTimes(0);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('routes to unified terminal before legacy when Agent SDK is disabled', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const mockUnified = vi.fn(async () => {});

        let sent = false;
        await claudeRemoteDispatch(
            {
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: {
                            permissionMode: 'default',
                            claudeRemoteAgentSdkEnabled: false,
                            claudeUnifiedTerminalEnabled: true,
                            claudeUnifiedTerminalHost: 'auto',
                        } as any,
                    };
                },
            } as any,
            {
                claudeRemote: mockLegacy,
                claudeRemoteAgentSdk: mockAgentSdk,
                claudeUnifiedTerminal: mockUnified,
                resolveClaudeUnifiedTerminalFeatureDecision: () => ({ state: 'enabled' }),
            } as any,
        );

        expect(mockUnified).toHaveBeenCalledTimes(1);
        expect(mockAgentSdk).toHaveBeenCalledTimes(0);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('passes the explicit --resume session id into the unified terminal runner before SessionStart', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const mockUnified = vi.fn(async () => {});

        let sent = false;
        await claudeRemoteDispatch(
            {
                sessionId: null,
                transcriptPath: null,
                path: '/tmp/workspace',
                claudeArgs: ['--resume', 'resume-123'],
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: {
                            permissionMode: 'default',
                            claudeUnifiedTerminalEnabled: true,
                            claudeUnifiedTerminalHost: 'auto',
                        } as any,
                    };
                },
            } as any,
            {
                claudeRemote: mockLegacy,
                claudeRemoteAgentSdk: mockAgentSdk,
                claudeUnifiedTerminal: mockUnified,
                resolveClaudeUnifiedTerminalFeatureDecision: () => ({ state: 'enabled' }),
            } as any,
        );

        expect(mockUnified).toHaveBeenCalledTimes(1);
        expect(mockUnified).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'resume-123',
            transcriptPath: null,
            claudeArgs: ['--resume', 'resume-123'],
            allowFirstInputBeforeSessionStart: true,
            startupLifecycleIntent: {
                kind: 'resume_native',
                providerSessionId: 'resume-123',
            },
        }));
    });

    it('marks explicit --continue as a native continuation before the unified terminal runner starts', async () => {
        const mockUnified = vi.fn(async () => {});
        let sent = false;

        await claudeRemoteDispatch(
            {
                sessionId: null,
                transcriptPath: null,
                path: '/tmp/workspace',
                claudeArgs: ['--continue'],
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: {
                            permissionMode: 'default',
                            claudeUnifiedTerminalEnabled: true,
                            claudeUnifiedTerminalHost: 'auto',
                        } as any,
                    };
                },
            } as any,
            {
                claudeRemote: vi.fn(async () => {}),
                claudeRemoteAgentSdk: vi.fn(async () => {}),
                claudeUnifiedTerminal: mockUnified,
                resolveClaudeUnifiedTerminalFeatureDecision: () => ({ state: 'enabled' }),
            } as any,
        );

        expect(mockUnified).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: null,
            claudeArgs: ['--continue'],
            startupLifecycleIntent: { kind: 'continue_native' },
        }));
    });

    it('restores the exact resume argv when an Agent SDK launch already consumed its one-time flag', async () => {
        const mockUnified = vi.fn(async () => {});
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-dispatch-consumed-resume-'));
        const workspaceDir = join(claudeConfigDir, 'workspace');
        const transcriptPath = join(
            getProjectPath(workspaceDir, claudeConfigDir),
            'resume-after-agent-sdk.jsonl',
        );
        await mkdir(dirname(transcriptPath), { recursive: true });
        await writeFile(transcriptPath, `${JSON.stringify({
            type: 'user',
            uuid: 'resume-after-agent-sdk-row',
            sessionId: 'resume-after-agent-sdk',
            message: { role: 'user', content: 'existing conversation' },
        })}\n`);
        let sent = false;

        await claudeRemoteDispatch(
            {
                sessionId: 'resume-after-agent-sdk',
                transcriptPath,
                path: workspaceDir,
                claudeArgs: ['--model', 'claude-sonnet-4-5'],
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'switch this running session to unified terminal',
                        mode: {
                            permissionMode: 'default',
                            claudeUnifiedTerminalEnabled: true,
                            claudeUnifiedTerminalHost: 'auto',
                        } as any,
                    };
                },
            } as any,
            {
                claudeRemote: vi.fn(async () => {}),
                claudeRemoteAgentSdk: vi.fn(async () => {}),
                claudeUnifiedTerminal: mockUnified,
                resolveClaudeUnifiedTerminalFeatureDecision: () => ({ state: 'enabled' }),
            } as any,
        );

        expect(mockUnified).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'resume-after-agent-sdk',
            claudeArgs: ['--model', 'claude-sonnet-4-5', '--resume', 'resume-after-agent-sdk'],
            startupLifecycleIntent: {
                kind: 'resume_native',
                providerSessionId: 'resume-after-agent-sdk',
            },
        }));
    });

    it('defaults missing Agent SDK flag to the Agent SDK runner', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});

        let sent = false;
        await claudeRemoteDispatch(
            {
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default' } as any,
                    };
                },
            } as any,
            {
                claudeRemote: mockLegacy,
                claudeRemoteAgentSdk: mockAgentSdk,
            } as any,
        );

        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });


    it.each(['disabled', 'unsupported', 'unknown'] as const)(
        'fails clearly without fallback when unified terminal feature policy is %s',
        async (featureState) => {
            const mockLegacy = vi.fn(async () => {});
            const mockAgentSdk = vi.fn(async () => {});
            const mockUnified = vi.fn(async () => {});

            let sent = false;
            await expect(
                claudeRemoteDispatch(
                    {
                        nextMessage: async () => {
                            if (sent) return null;
                            sent = true;
                            return {
                                message: 'hello',
                                mode: {
                                    permissionMode: 'default',
                                    claudeRemoteAgentSdkEnabled: true,
                                    claudeUnifiedTerminalEnabled: true,
                                    claudeUnifiedTerminalHost: 'auto',
                                } as any,
                            };
                        },
                    } as any,
                    {
                        claudeRemote: mockLegacy,
                        claudeRemoteAgentSdk: mockAgentSdk,
                        claudeUnifiedTerminal: mockUnified,
                        resolveClaudeUnifiedTerminalFeatureDecision: () => ({ state: featureState }),
                    } as any,
                ),
            ).rejects.toThrow(/unified terminal runtime is disabled by feature policy/i);

            expect(mockUnified).toHaveBeenCalledTimes(0);
            expect(mockAgentSdk).toHaveBeenCalledTimes(0);
            expect(mockLegacy).toHaveBeenCalledTimes(0);
        },
    );

    it('does not fall back after unified terminal has been selected', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const mockUnified = vi.fn(async () => {
            throw new Error('unified runner failed');
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await expect(
            claudeRemoteDispatch(
                {
                    onRunnerSelected,
                    nextMessage: async () => {
                        if (sent) return null;
                        sent = true;
                        return {
                            message: 'hello',
                            mode: {
                                permissionMode: 'default',
                                claudeRemoteAgentSdkEnabled: true,
                                claudeUnifiedTerminalEnabled: true,
                                claudeUnifiedTerminalHost: 'auto',
                            } as any,
                        };
                    },
                } as any,
                {
                    claudeRemote: mockLegacy,
                    claudeRemoteAgentSdk: mockAgentSdk,
                    claudeUnifiedTerminal: mockUnified,
                    resolveClaudeUnifiedTerminalFeatureDecision: () => ({ state: 'enabled' }),
                } as any,
            ),
        ).rejects.toThrow(/unified runner failed/);

        expect(onRunnerSelected).toHaveBeenCalledExactlyOnceWith(null);
        expect(mockUnified).toHaveBeenCalledTimes(1);
        expect(mockAgentSdk).toHaveBeenCalledTimes(0);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('repairs interrupted tool calls before invoking the runner (preflight)', async () => {
        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-remote-dispatch-preflight-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const workDir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(workDir, { recursive: true });

        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
        try {
            const transcriptPath = join(getProjectPath(workDir, claudeConfigDir), 'sess_1.jsonl');
            await mkdir(dirname(transcriptPath), { recursive: true });
            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: { command: 'sleep 1000' },
                            },
                        ],
                    },
                })}\n`,
            );

            const mockLegacy = vi.fn(async () => {});
            const mockAgentSdk = vi.fn(async () => {
                const contents = await readFile(transcriptPath, 'utf8');
                expect(contents).toMatch(/\"type\":\"tool_result\"/);
            });

            let sent = false;
            await claudeRemoteDispatch(
                {
                    sessionId: 'sess_1',
                    transcriptPath: null,
                    path: workDir,
                    nextMessage: async () => {
                        if (sent) return null;
                        sent = true;
                        return { message: 'continue', mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any };
                    },
                } as any,
                { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
            );

            expect(mockAgentSdk).toHaveBeenCalledTimes(1);
            expect(mockLegacy).toHaveBeenCalledTimes(0);
        } finally {
            if (previousClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
            }
        }
    });

    it('routes to Agent SDK runner when enabled on first message', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('routes to Agent SDK runner when the enablement flag is missing on first message (back-compat default)', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default' } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('falls back to legacy runner when Agent SDK runner fails with an authentication error before consuming additional messages', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {
            throw new Error(
                'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
            );
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenNthCalledWith(1, 'agentSdk');
        expect(onRunnerSelected).toHaveBeenNthCalledWith(2, 'legacy');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to legacy runner if Agent SDK has already started a session before failing with an authentication error', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async (params: any) => {
            params.onSessionFound?.('sess_started');
            throw new Error(
                'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
            );
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await expect(
            claudeRemoteDispatch(
                {
                    onSessionFound: vi.fn(),
                    onRunnerSelected,
                    nextMessage: async () => {
                        if (sent) return null;
                        sent = true;
                        return {
                            message: 'hello',
                            mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                        };
                    },
                } as any,
                { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/Failed to authenticate/);

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('falls back to legacy runner when Agent SDK runner exits with code 1 before emitting any messages', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {
            throw new Error('Claude Code process exited with code 1');
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                onMessage: vi.fn(),
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'continue',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenNthCalledWith(1, 'agentSdk');
        expect(onRunnerSelected).toHaveBeenNthCalledWith(2, 'legacy');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(1);
    });

    it('does not fall back or replay after the Agent SDK reports an attempted transport crossing', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async (params: any) => {
            params.onPromptTransportFailure?.({
                kind: 'effect_may_have_occurred',
                maxUserMessageSeq: 1,
                userMessageLocalIds: ['transport-attempt-local-id'],
            });
            throw new Error('Claude Code process exited with code 1');
        });

        let sent = false;
        await expect(claudeRemoteDispatch(
            {
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'must not replay',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        )).rejects.toThrow('Claude Code process exited with code 1');

        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).not.toHaveBeenCalled();
    });

    it('retries Agent SDK once when startup fails with ENOENT before the session starts', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi
            .fn()
            .mockRejectedValueOnce(new Error('Failed to spawn Claude Code process: spawn /home/hidde/.local/bin/claude ENOENT'))
            .mockResolvedValueOnce(undefined);
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenNthCalledWith(1, 'agentSdk');
        expect(onRunnerSelected).toHaveBeenNthCalledWith(2, 'agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(2);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('retries Agent SDK without resumeSessionAt when Claude rejects the matching message anchor', async () => {
        const mockLegacy = vi.fn(async () => {});
        const seenPrompts: string[] = [];
        const capturedResumeAnchors: Array<unknown> = [];
        const rejectedAnchors: string[] = [];
        const mockAgentSdk = vi
            .fn()
            .mockImplementationOnce(async (params: any) => {
                capturedResumeAnchors.push(params.resumeSessionAt);
                const next = await params.nextMessage();
                seenPrompts.push(next.message);
                throw new Error(
                    'Claude Code returned an error result: No message found with message.uuid of: 84a6076b-82b1-4450-b584-ddbb2142472f',
                );
            })
            .mockImplementationOnce(async (params: any) => {
                capturedResumeAnchors.push(params.resumeSessionAt);
                const next = await params.nextMessage();
                seenPrompts.push(next.message);
            });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                sessionId: 'sess_1',
                resumeSessionAt: '84a6076b-82b1-4450-b584-ddbb2142472f',
                onResumeSessionAtRejected: (anchor: string) => {
                    rejectedAnchors.push(anchor);
                },
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'continue from phone',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenNthCalledWith(1, 'agentSdk');
        expect(onRunnerSelected).toHaveBeenNthCalledWith(2, 'agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(2);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
        expect(capturedResumeAnchors).toEqual([
            '84a6076b-82b1-4450-b584-ddbb2142472f',
            null,
        ]);
        expect(seenPrompts).toEqual(['continue from phone', 'continue from phone']);
        expect(rejectedAnchors).toEqual(['84a6076b-82b1-4450-b584-ddbb2142472f']);
    });

    it('does not retry without resumeSessionAt when Claude rejects a different message anchor', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async (params: any) => {
            await params.nextMessage();
            throw new Error(
                'Claude Code returned an error result: No message found with message.uuid of: 00000000-0000-4000-8000-000000000000',
            );
        });
        const onResumeSessionAtRejected = vi.fn();

        let sent = false;
        await expect(
            claudeRemoteDispatch(
                {
                    sessionId: 'sess_1',
                    resumeSessionAt: '84a6076b-82b1-4450-b584-ddbb2142472f',
                    onResumeSessionAtRejected,
                    nextMessage: async () => {
                        if (sent) return null;
                        sent = true;
                        return {
                            message: 'continue from phone',
                            mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                        };
                    },
                } as any,
                { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/No message found with message\.uuid/);

        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
        expect(onResumeSessionAtRejected).not.toHaveBeenCalled();
    });

    it('does not fall back to legacy runner when Agent SDK exits with code 1 after emitting a message', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async (params: any) => {
            params.onMessage?.({ type: 'assistant', message: { role: 'assistant', content: [] } });
            throw new Error('Claude Code process exited with code 1');
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await expect(
            claudeRemoteDispatch(
                {
                    onRunnerSelected,
                    onMessage: vi.fn(),
                    nextMessage: async () => {
                        if (sent) return null;
                        sent = true;
                        return {
                            message: 'continue',
                            mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                        };
                    },
                } as any,
                { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/exited with code 1/);

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('still routes to Agent SDK runner when enabled even if --mcp-config flags are present (runner parses and maps to mcpServers)', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                claudeArgs: ['--mcp-config', '{"mcpServers":{}}'],
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('routes to legacy runner when Agent SDK is not enabled on first message', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: false } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('legacy');
        expect(mockAgentSdk).toHaveBeenCalledTimes(0);
        expect(mockLegacy).toHaveBeenCalledTimes(1);
    });
});
