import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionSettingsCommonModuleMocks } from './sessionSettingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setCoalesceEnabled = vi.fn();
const setPartialOutputEnabled = vi.fn();
const setListImplementation = vi.fn();
const requestedSettings: string[] = [];

installSessionSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TextInput: 'TextInput',
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: (key: string) => {
                    requestedSettings.push(key);
                    if (key === 'transcriptStreamingCoalesceEnabled') return [true, setCoalesceEnabled];
                    if (key === 'transcriptStreamingCoalesceWindowMs') return [16, vi.fn()];
                    if (key === 'transcriptStreamingCoalesceMaxBatchSize') return [200, vi.fn()];
                    if (key === 'transcriptStreamingPartialOutputEnabled') return [true, setPartialOutputEnabled];
                    if (key === 'transcriptThinkingPulseStaleMs') return [120_000, vi.fn()];
                    if (key === 'transcriptListImplementation') return ['flash_v2', setListImplementation];
                    if (key === 'transcriptMotionPreset') return ['subtle', vi.fn()];
                    if (key === 'transcriptMotionFreshnessMs') return [60_000, vi.fn()];
                    if (key === 'transcriptAnimateNewItemsEnabled') return [true, vi.fn()];
                    if (key === 'transcriptAnimateToolExpandCollapseEnabled') return [true, vi.fn()];
                    if (key === 'transcriptAnimateToolExpandCollapseFreshOnly') return [true, vi.fn()];
                    if (key === 'transcriptAnimateThinkingEnabled') return [true, vi.fn()];
                    if (key === 'transcriptScrollPinOffsetThresholdPx') return [72, vi.fn()];
                    if (key === 'transcriptScrollAutoFollowWhenPinned') return [true, vi.fn()];
                    if (key === 'transcriptScrollJumpToBottomMinNewCount') return [1, vi.fn()];
                    if (key === 'transcriptScrollJumpToBottomAnimateScroll') return [true, vi.fn()];
                    return [null, vi.fn()];
                },
            },
        });
    },
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

afterEach(() => {
    standardCleanup();
    setCoalesceEnabled.mockClear();
    setPartialOutputEnabled.mockClear();
    setListImplementation.mockClear();
    requestedSettings.length = 0;
});

describe('Transcript advanced settings (performance)', () => {
    it('toggles streaming coalescing enabled', async () => {
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findRowByTitle('settingsSession.transcript.advanced.coalesceEnabledTitle')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settingsSession.transcript.advanced.coalesceEnabledTitle');
        });

        expect(setCoalesceEnabled).toHaveBeenCalledWith(false);
    });

    it('toggles partial streaming output visibility', async () => {
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findRowByTitle('settingsSession.transcript.advanced.streamingPartialOutputTitle')).toBeTruthy();

        await act(async () => {
            screen.pressRowByTitle('settingsSession.transcript.advanced.streamingPartialOutputTitle');
        });

        expect(setPartialOutputEnabled).toHaveBeenCalledWith(false);
    });

    it('omits the obsolete list implementation menu while keeping advanced controls available', async () => {
        const mod = await import('./TranscriptRenderingAdvancedSettingsView');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findRowByTitle('settingsSession.transcript.advanced.coalesceWindowTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.transcript.advanced.streamingPartialOutputTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.transcript.advanced.listImplementationTitle')).toBeNull();
        expect(screen.findAll((node) => String(node.type) === 'DropdownMenu')).toHaveLength(0);
        expect(requestedSettings).not.toContain('transcriptListImplementation');
        expect(setListImplementation).not.toHaveBeenCalled();
    });
});
