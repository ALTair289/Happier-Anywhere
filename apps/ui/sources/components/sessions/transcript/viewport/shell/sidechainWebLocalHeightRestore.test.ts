import { describe, expect, it } from 'vitest';

import {
    createWebDomScrollObservation,
} from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    applySidechainWebLocalHeightRestore,
    buildSidechainWebLocalHeightRestoreTelemetryEvent,
} from './sidechainWebLocalHeightRestore';
import type { SidechainWebLocalHeightChangeAnchor } from './sidechainWebAnchorCapture';

function buildAnchor(overrides: Partial<SidechainWebLocalHeightChangeAnchor> = {}): SidechainWebLocalHeightChangeAnchor {
    const element = {
        clientHeight: 300,
        scrollHeight: 1320,
        scrollTop: 360,
    } as HTMLElement;
    return {
        metrics: {
            clientHeight: 300,
            element,
            scrollHeight: 1200,
            scrollTop: 240,
        },
        mode: 'preserve-position',
        sessionId: 'session-1',
        ...overrides,
    };
}

describe('sidechain web local-height restore telemetry', () => {
    it('builds restore-anchor telemetry from live post-restore DOM metrics', () => {
        const anchor = buildAnchor();

        expect(buildSidechainWebLocalHeightRestoreTelemetryEvent({
            anchor,
            flashListContentHeightPx: 1400,
            flashListLayoutHeightPx: 500,
            itemCount: 7,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: false,
                phase: 'armed',
                suspendedReasons: ['negative-offset'],
            },
            platformOS: 'web',
            rendererKind: 'legendList',
            result: {
                distanceFromBottom: 660,
                landedScrollTop: 360,
                ok: true,
                previousScrollTop: 240,
                targetScrollTop: 360,
            },
            timestampMs: 123,
        })).toEqual({
            coldCount: 7,
            contentHeight: 1320,
            distanceFromBottom: 660,
            domClientHeight: 300,
            domScrollHeight: 1320,
            domScrollTop: 360,
            flashListContentHeight: 1400,
            flashListLayoutHeight: 500,
            hotCount: 0,
            layoutHeight: 300,
            listImplementation: 'legend',
            mode: 'restore-anchor',
            paginationPhase: 'armed',
            paginationSuspendedReasons: ['negative-offset'],
            pendingWebPrependAnchorKind: 'none',
            platform: 'web',
            previousOffsetY: 240,
            programmaticWebWrite: true,
            reason: 'content-size-change',
            scrollable: true,
            sessionId: 'session-1',
            targetOffsetY: 360,
            timestampMs: 123,
            trigger: 'restore',
            type: 'scroll-write',
            writer: 'web-dom-restore',
        });
    });

    it('builds follow-bottom telemetry for bottom-local height restores', () => {
        const anchor = buildAnchor({ mode: 'follow-bottom' });

        expect(buildSidechainWebLocalHeightRestoreTelemetryEvent({
            anchor,
            flashListContentHeightPx: 1320,
            flashListLayoutHeightPx: 300,
            itemCount: 4,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: true,
                phase: 'idle',
                suspendedReasons: [],
            },
            platformOS: 'web',
            rendererKind: 'flashList',
            result: {
                distanceFromBottom: 0,
                landedScrollTop: 1020,
                ok: true,
                previousScrollTop: 900,
                targetScrollTop: 1020,
            },
            timestampMs: 456,
        })).toMatchObject({
            distanceFromBottom: 0,
            mode: 'follow-bottom',
            previousOffsetY: 900,
            targetOffsetY: 1020,
        });
    });

    it('applies a preserve-position restore and records exactly one telemetry event', () => {
        const element = {
            clientHeight: 300,
            scrollHeight: 1320,
            scrollTop: 240,
        } as HTMLElement;
        const anchor = buildAnchor({
            metrics: {
                clientHeight: 300,
                element,
                scrollHeight: 1200,
                scrollTop: 240,
            },
        });
        const events: unknown[] = [];

        const result = applySidechainWebLocalHeightRestore({
            anchor,
            flashListContentHeightPx: 1400,
            flashListLayoutHeightPx: 500,
            itemCount: 7,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: false,
                phase: 'armed',
                suspendedReasons: ['negative-offset'],
            },
            platformOS: 'web',
            rendererKind: 'legendList',
            recordTelemetry: (event) => events.push(event),
            timestampMs: 123,
            webDomObservation: createWebDomScrollObservation(),
        });

        expect(result).toBe(true);
        expect(anchor.metrics.element.scrollTop).toBe(360);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            mode: 'restore-anchor',
            previousOffsetY: 240,
            targetOffsetY: 360,
            type: 'scroll-write',
            writer: 'web-dom-restore',
        });
    });

    it('does not record telemetry when the restore driver has no write to apply', () => {
        const anchor = buildAnchor();
        const events: unknown[] = [];

        const result = applySidechainWebLocalHeightRestore({
            anchor,
            flashListContentHeightPx: 1200,
            flashListLayoutHeightPx: 500,
            itemCount: 7,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: false,
                phase: 'armed',
                suspendedReasons: [],
            },
            platformOS: 'web',
            rendererKind: 'flashList',
            recordTelemetry: (event) => events.push(event),
            timestampMs: 123,
            webDomObservation: createWebDomScrollObservation(),
        });

        expect(result).toBe(false);
        expect(events).toEqual([]);
    });

    it('applies follow-bottom restores with follow-bottom telemetry mode', () => {
        const anchor = buildAnchor({
            metrics: {
                clientHeight: 300,
                element: {
                    clientHeight: 300,
                    scrollHeight: 1320,
                    scrollTop: 900,
                } as HTMLElement,
                scrollHeight: 1200,
                scrollTop: 900,
            },
            mode: 'follow-bottom',
        });
        const events: unknown[] = [];

        expect(applySidechainWebLocalHeightRestore({
            anchor,
            flashListContentHeightPx: 1320,
            flashListLayoutHeightPx: 300,
            itemCount: 4,
            paginationSnapshot: {
                hasMore: true,
                insideThreshold: true,
                phase: 'idle',
                suspendedReasons: [],
            },
            platformOS: 'web',
            rendererKind: 'flashList',
            recordTelemetry: (event) => events.push(event),
            timestampMs: 456,
            webDomObservation: createWebDomScrollObservation(),
        })).toBe(true);

        expect(anchor.metrics.element.scrollTop).toBe(1020);
        expect(events[0]).toMatchObject({
            distanceFromBottom: 0,
            mode: 'follow-bottom',
            targetOffsetY: 1020,
        });
    });
});
