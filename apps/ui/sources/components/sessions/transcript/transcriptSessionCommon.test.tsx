import { describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { Settings } from '@/sync/domains/settings/settings';

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

const settingValues = {
    sessionReplayEnabled: false,
    sessionReplayMaxSeedChars: 1200,
    sessionReplayStrategy: 'recent_messages',
    sessionReplaySummaryRunnerV1: null,
    sessionThinkingDisplayMode: 'inline',
    sessionThinkingInlineChrome: 'card',
    sessionThinkingInlinePresentation: 'summary',
    toolViewTimelineChromeMode: 'cards',
    transcriptMessageTimestampDisplayMode: 'hover_web_hidden_mobile',
    transcriptMessageSelectionEnabled: false,
    transcriptMessageSendToSessionEnabled: true,
    transcriptStreamingMarkdownRenderingEnabled: true,
    transcriptStreamingPartialOutputEnabled: true,
    transcriptStreamingSettleDelayMs: 90,
    transcriptStreamingSmoothingEnabled: true,
    transcriptToolCallsCollapsedPreviewCount: 5,
    transcriptToolCallsGroupShowBackground: true,
} satisfies Partial<Settings>;

// Storage is a testkit-owned boundary: stub it through `@/dev/testkit/mocks/storage` so the whole
// module surface stays in step with its owner. A hand-rolled literal here silently omits every export
// the hook grows next (it previously dropped `useLocalSetting`, which `useSessionDebugInformationEnabled`
// reads), turning an owner change into an unrelated red test.
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSessionForkSupportSource: () => null,
        useSessionMessagesById: () => ({}),
        useSessionMessagesReducerState: () => null,
        useSessionWorkspacePath: () => '/repo',
        useSetting: createUseSettingMock({ values: settingValues }),
    });
});

describe('useTranscriptSessionCommon', () => {
    it('includes row-level transcript message action settings in message display common', async () => {
        const { useTranscriptSessionCommon } = await import('./transcriptSessionCommon');
        const hook = await renderHook(() => useTranscriptSessionCommon('s1'));

        expect(hook.getCurrent().messageDisplay.transcriptMessageSelectionEnabled).toBe(false);
        expect(hook.getCurrent().messageDisplay.transcriptMessageSendToSessionEnabled).toBe(true);

        await hook.unmount();
        standardCleanup();
    });
});
