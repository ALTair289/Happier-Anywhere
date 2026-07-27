import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptFlashListEstimatedItemSize: 120,
            transcriptBackwardPrefetchThresholdPx: 800,
        }),
    },
}));

vi.mock('@shopify/flash-list', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        const instance = {
            scrollToEnd: vi.fn(),
            scrollToIndex: vi.fn(() => Promise.resolve()),
            scrollToOffset: vi.fn(),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        return React.createElement('FlashList', props, props.ListFooterComponent ?? null);
    }),
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock().module;
});

describe('ChainTranscriptList empty-state footer spinner', () => {
    type ChainTranscriptListTestProps =
        Omit<React.ComponentProps<typeof import('./ChainTranscriptList')['ChainTranscriptList']>, 'datasetKey'>
        & { datasetKey?: string };

    async function renderChainTranscriptList(
        props: ChainTranscriptListTestProps,
    ) {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        return renderScreen(React.createElement(ChainTranscriptList, {
            ...props,
            datasetKey: props.datasetKey ?? JSON.stringify([props.sessionId, 'test-sidechain']),
        }));
    }

    afterEach(() => {
        standardCleanup();
    });

    it('keeps the initial-load footer spinner while an empty list is still loading', async () => {
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            isInitialLoadInFlight: true,
        });

        expect(screen.findByTestId('chain-transcript-loading-footer')).toBeTruthy();
    });

    it('does not show a perpetual footer spinner for a loaded-but-empty list', async () => {
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            isInitialLoadInFlight: false,
        });

        expect(screen.findByTestId('chain-transcript-loading-footer')).toBeNull();
    });

    it('keeps the initial-load footer spinner when no explicit load state is provided (legacy callers)', async () => {
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
        });

        expect(screen.findByTestId('chain-transcript-loading-footer')).toBeTruthy();
    });
});
