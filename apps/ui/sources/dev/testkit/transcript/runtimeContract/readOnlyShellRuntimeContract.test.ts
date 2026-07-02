import { describe, expect, it } from 'vitest';

import { createReadOnlyShellRuntimeModel } from './sidechainShellRuntimeModel';

const DELETED_LEGACY_FALLBACK_CAPABILITY = ['uses', 'LegacyFallback'].join('');

describe('read-only shell runtime contract', () => {
    it('keeps public/read-only capability semantics and bottom notice while using bottom-start FlashList', () => {
        const model = createReadOnlyShellRuntimeModel({
            bottomNotice: true,
            hasThinkingMessage: true,
            messageCount: 100,
            platformOS: 'web',
        });

        expect(model.observeCapability()).toEqual({
            accessKind: 'public',
            bottomNoticeVisible: true,
            canApprovePermissions: false,
            canSendMessages: false,
            composerVisible: false,
            flashListStartsFromBottom: true,
            permissionDisabledReason: 'public',
            toolNavigationDisabled: true,
        });
        expect(model.observeCapability()).not.toHaveProperty(DELETED_LEGACY_FALLBACK_CAPABILITY);
        expect(model.observeFrame()).toEqual({
            dataOrder: 'oldest-first',
            renderer: 'flashList',
        });
        expect(model.toggleThinkingExpansion('thinking-1')).toEqual({
            expanded: true,
            messageId: 'thinking-1',
        });
    });

    it('keeps large read-only scroll position stable across same-data rerenders', () => {
        const model = createReadOnlyShellRuntimeModel({
            bottomNotice: false,
            hasThinkingMessage: false,
            messageCount: 800,
            platformOS: 'web',
            rowHeightPx: 96,
            viewportHeightPx: 640,
        });

        model.scrollTo(16000);
        const before = model.observeScroll();
        model.rerenderSameRows();

        expect(model.observeScroll()).toEqual(before);
    });

    it('uses the standard FlashList shell on web without reading the persisted implementation setting', () => {
        const model = createReadOnlyShellRuntimeModel({
            bottomNotice: true,
            hasThinkingMessage: false,
            messageCount: 12,
            platformOS: 'web',
        });

        expect(model.observeCapability()).toMatchObject({
            accessKind: 'public',
            flashListStartsFromBottom: true,
            permissionDisabledReason: 'public',
        });
        expect(model.observeCapability()).not.toHaveProperty(DELETED_LEGACY_FALLBACK_CAPABILITY);
        expect(model.observeFrame()).toEqual({
            dataOrder: 'oldest-first',
            renderer: 'flashList',
        });
    });

    it('uses the canonical inverted FlashList shell on native without reading the persisted implementation setting', () => {
        const model = createReadOnlyShellRuntimeModel({
            bottomNotice: true,
            hasThinkingMessage: false,
            messageCount: 12,
            platformOS: 'ios',
        });

        expect(model.observeCapability()).toMatchObject({
            accessKind: 'public',
            flashListStartsFromBottom: true,
            permissionDisabledReason: 'public',
        });
        expect(model.observeCapability()).not.toHaveProperty(DELETED_LEGACY_FALLBACK_CAPABILITY);
        expect(model.observeFrame()).toEqual({
            dataOrder: 'newest-first',
            renderer: 'flashList',
        });
    });
});
