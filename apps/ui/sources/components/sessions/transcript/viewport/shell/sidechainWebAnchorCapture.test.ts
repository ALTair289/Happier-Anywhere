import { describe, expect, it } from 'vitest';

import {
    resolveSidechainWebLocalHeightChangeAnchor,
    resolveSidechainWebPrependAnchor,
} from './sidechainWebAnchorCapture';

describe('sidechain web anchor capture', () => {
    it('captures older-prepend metrics only when the viewport is scrollable and away from the live tail', () => {
        const element = {
            clientHeight: 400,
            scrollHeight: 1200,
            scrollTop: 100,
        } as HTMLElement;

        expect(resolveSidechainWebPrependAnchor({
            element,
            pinThresholdPx: 80,
        })).toEqual({
            clientHeight: 400,
            element,
            scrollHeight: 1200,
            scrollTop: 100,
        });
    });

    it('does not capture older-prepend metrics near the live tail or for unscrollable content', () => {
        expect(resolveSidechainWebPrependAnchor({
            element: {
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 760,
            } as HTMLElement,
            pinThresholdPx: 80,
        })).toBeNull();

        expect(resolveSidechainWebPrependAnchor({
            element: {
                clientHeight: 400,
                scrollHeight: 400,
                scrollTop: 0,
            } as HTMLElement,
            pinThresholdPx: 80,
        })).toBeNull();
    });

    it('captures local-height preserve mode when the web viewport is away from the live tail', () => {
        const element = {
            clientHeight: 400,
            scrollHeight: 1200,
            scrollTop: 100,
        } as HTMLElement;

        expect(resolveSidechainWebLocalHeightChangeAnchor({
            element,
            platformOS: 'web',
            resolveViewportGuardThresholdPx: () => 80,
            sessionId: 'session-1',
        })).toEqual({
            metrics: {
                clientHeight: 400,
                element,
                scrollHeight: 1200,
                scrollTop: 100,
            },
            mode: 'preserve-position',
            sessionId: 'session-1',
        });
    });

    it('captures local-height follow-bottom mode when the web viewport is inside the live-tail guard', () => {
        expect(resolveSidechainWebLocalHeightChangeAnchor({
            element: {
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 760,
            } as HTMLElement,
            platformOS: 'web',
            resolveViewportGuardThresholdPx: () => 80,
            sessionId: 'session-1',
        })).toMatchObject({
            mode: 'follow-bottom',
            sessionId: 'session-1',
        });
    });

    it('does not capture local-height anchors outside web or without scrollable content', () => {
        expect(resolveSidechainWebLocalHeightChangeAnchor({
            element: {
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 100,
            } as HTMLElement,
            platformOS: 'ios',
            resolveViewportGuardThresholdPx: () => 80,
            sessionId: 'session-1',
        })).toBeNull();

        expect(resolveSidechainWebLocalHeightChangeAnchor({
            element: {
                clientHeight: 400,
                scrollHeight: 400,
                scrollTop: 0,
            } as HTMLElement,
            platformOS: 'web',
            resolveViewportGuardThresholdPx: () => 80,
            sessionId: 'session-1',
        })).toBeNull();
    });
});
