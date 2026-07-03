import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConcurrentTargets } from './concurrentSessionCache';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

describe('resolveConcurrentTargets', () => {
    const profiles = [
        { id: 'server-a', serverUrl: 'https://a.example.test', name: 'Server A' },
        { id: 'server-b', serverUrl: 'https://b.example.test', name: 'Server B' },
        { id: 'server-c', serverUrl: 'https://c.example.test', name: 'Server C' },
    ] as const;

    it('returns selected non-active server targets when active selection is a group', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        });
        expect(result).toEqual([
            {
                id: 'server-c',
                serverUrl: 'https://c.example.test',
                serverName: 'Server C',
            },
        ]);
    });

    it('returns empty targets when active selection is a concrete server', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: 'server-a',
            },
        });
        expect(result).toEqual([]);
    });

    it('honors explicit active server target and ignores concurrent selection sets', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: 'server-b',
            } as any,
        });
        expect(result).toEqual([]);
    });

    it('honors explicit group target when resolving concurrent targets', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-b',
            profiles,
            settings: {
                serverSelectionGroups: [
                    {
                        id: 'group-dev',
                        name: 'Dev',
                        serverIds: ['server-b', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-dev',
            } as any,
        });
        expect(result).toEqual([
            {
                id: 'server-c',
                serverUrl: 'https://c.example.test',
                serverName: 'Server C',
            },
        ]);
    });

    it('starts periodic refresh through the runtime-active gated interval', async () => {
        vi.resetModules();
        const stopInterval = vi.fn();
        const startRuntimeActiveGatedInterval = vi.fn(() => stopInterval);
        vi.doMock('@/utils/runtime/isRuntimeActive', () => ({
            isRuntimeActive: () => true,
            startRuntimeActiveGatedInterval,
        }));

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();

        expect(startRuntimeActiveGatedInterval).toHaveBeenCalledWith(expect.any(Function), expect.any(Number));

        stopConcurrentSessionCacheSync();
        expect(stopInterval).toHaveBeenCalledTimes(1);
    });
});
