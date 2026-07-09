import { describe, expect, it } from 'vitest';

import { resolveWebViewportResizeObservation } from './webViewportResizeObservation';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

function metrics(
    overrides: Partial<WebTranscriptScrollMetrics> = {},
): WebTranscriptScrollMetrics {
    const element = {} as HTMLElement;
    return {
        clientHeight: 570,
        element,
        scrollHeight: 4864,
        scrollTop: 4294,
        ...overrides,
    };
}

describe('web viewport resize observation', () => {
    it('requests a live-tail resize pin when the same scroller height changes', () => {
        const previous = metrics();
        const next = metrics({
            clientHeight: 435,
            element: previous.element,
        });

        expect(resolveWebViewportResizeObservation({
            nextMetrics: next,
            previousMetrics: previous,
        })).toEqual({
            previousWebMetrics: previous,
            reason: 'viewport-resized',
        });
    });

    it('does not request a pin for same-height observations or scroller replacement baselines', () => {
        const previous = metrics();

        expect(resolveWebViewportResizeObservation({
            nextMetrics: metrics({ element: previous.element }),
            previousMetrics: previous,
        })).toBeNull();
        expect(resolveWebViewportResizeObservation({
            nextMetrics: metrics({ clientHeight: 435 }),
            previousMetrics: previous,
        })).toBeNull();
        expect(resolveWebViewportResizeObservation({
            nextMetrics: previous,
            previousMetrics: null,
        })).toBeNull();
    });
});
