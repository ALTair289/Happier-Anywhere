import { describe, expect, it } from 'vitest';

import { createDaemonControlApp } from './controlServer';

describe('daemon control server: /list', () => {
    it('returns only the stable tracked session fields', async () => {
        const app = createDaemonControlApp({
            getChildren: () => [
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-1',
                    pid: 111,
                    spawnOptions: { directory: '/tmp/project-a' },
                },
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-2',
                    pid: 222,
                },
            ],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
        });

        try {
            await app.ready();
            const res = await app.inject({
                method: 'POST',
                url: '/list',
                headers: { 'x-happier-daemon-token': 'test-token' },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({
                children: [
                    { startedBy: 'daemon', happySessionId: 'sess-1', pid: 111, status: 'runner_alive' },
                    { startedBy: 'daemon', happySessionId: 'sess-2', pid: 222, status: 'runner_alive' },
                ],
            });
        } finally {
            await app.close();
        }
    });

    it('surfaces alive runners with dead terminal hosts as a distinct status', async () => {
        const app = createDaemonControlApp({
            getChildren: () => [
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-host-dead',
                    pid: 111,
                    terminalHostHealth: {
                        status: 'host_dead',
                        sessionId: 'sess-host-dead',
                        runnerPid: 111,
                        hostKind: 'zellij',
                        zellijSessionName: 'happier-claude-unified-111',
                        observedAt: 1234,
                        reason: 'pane_dead',
                    },
                },
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-running',
                    pid: 222,
                },
            ],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
        });

        try {
            await app.ready();
            const res = await app.inject({
                method: 'POST',
                url: '/list',
                headers: { 'x-happier-daemon-token': 'test-token' },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({
                children: [
                    {
                        startedBy: 'daemon',
                        happySessionId: 'sess-host-dead',
                        pid: 111,
                        status: 'runner_alive_host_dead',
                        terminalHostHealth: {
                            status: 'host_dead',
                            sessionId: 'sess-host-dead',
                            runnerPid: 111,
                            hostKind: 'zellij',
                            zellijSessionName: 'happier-claude-unified-111',
                            observedAt: 1234,
                            reason: 'pane_dead',
                        },
                    },
                    { startedBy: 'daemon', happySessionId: 'sess-running', pid: 222, status: 'runner_alive' },
                ],
            });
        } finally {
            await app.close();
        }
    });
});
