import { describe, expect, it, vi } from 'vitest';

import type { ClaudeProviderRuntimeActivityPublisher } from '../providerActivity/createClaudeProviderActivityLedger';

import {
    createClaudeRuntimeActivityEvidence,
    observeProviderTaskRuntimeActivity,
    reconcileClaudeRuntimeActivity,
    setProviderTaskRuntimeActivityActive,
} from './runtimeActivityEvidence';

function createPublisher(): ClaudeProviderRuntimeActivityPublisher {
    return {
        setSourceActive: vi.fn(async () => {}),
        observeSource: vi.fn(async () => {}),
        clearSource: vi.fn(async () => {}),
        clearProviderSources: vi.fn(async () => {}),
    };
}

async function flushEffects(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('Claude runtime activity evidence', () => {
    it('renews progress through the source-keyed observe path after this owner has published the task', async () => {
        const evidence = createClaudeRuntimeActivityEvidence();
        const publisher = createPublisher();
        const logger = { debug: vi.fn() };

        setProviderTaskRuntimeActivityActive({
            evidence,
            logger,
            logPrefix: '[test]',
            runtimeActivityPublisher: publisher,
            taskId: 'task_1',
        });
        await flushEffects();

        observeProviderTaskRuntimeActivity({
            evidence,
            logger,
            logPrefix: '[test]',
            runtimeActivityPublisher: publisher,
            taskId: 'task_1',
        });
        await flushEffects();

        expect(publisher.setSourceActive).toHaveBeenCalledTimes(1);
        expect(publisher.observeSource).toHaveBeenCalledWith({
            id: 'claude:provider-task:task_1',
            reason: 'claude_provider_task_progress',
        });
    });

    it('reconciles renewals from the verified live task set', async () => {
        const evidence = createClaudeRuntimeActivityEvidence();
        const publisher = createPublisher();
        const logger = { debug: vi.fn() };

        evidence.providerActivityLedger.noteBackgroundProviderTask('stale_task');
        evidence.providerActivityLedger.noteBackgroundProviderTask('live_task');
        evidence.liveProviderTaskIds.add('live_task');

        await reconcileClaudeRuntimeActivity({
            evidence,
            logger,
            logPrefix: '[test]',
            runtimeActivityPublisher: publisher,
            reason: 'foreground_result',
        });

        expect(publisher.clearProviderSources).toHaveBeenCalledWith('claude', 'foreground_result');
        expect(publisher.setSourceActive).toHaveBeenCalledTimes(1);
        expect(publisher.setSourceActive).toHaveBeenCalledWith({
            id: 'claude:provider-task:live_task',
            sourceClass: 'provider_detached_task',
            providerId: 'claude',
        });

        observeProviderTaskRuntimeActivity({
            evidence,
            logger,
            logPrefix: '[test]',
            runtimeActivityPublisher: publisher,
            taskId: 'live_task',
        });
        await flushEffects();

        expect(publisher.setSourceActive).toHaveBeenCalledTimes(1);
        expect(publisher.observeSource).toHaveBeenCalledWith({
            id: 'claude:provider-task:live_task',
            reason: 'claude_provider_task_progress',
        });
    });
});
