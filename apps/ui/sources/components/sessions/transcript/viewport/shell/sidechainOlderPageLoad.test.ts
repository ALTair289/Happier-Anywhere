import { describe, expect, it, vi } from 'vitest';

import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';

import {
    applySidechainOlderPageLoad,
    applySidechainPaginationOlderPageLoad,
    type SidechainOlderPageLoadResult,
} from './sidechainOlderPageLoad';

class FakeElement {
    public clientHeight: number;
    public scrollHeight: number;
    private scrollTopValue: number;

    public constructor(params: Readonly<{
        clientHeight: number;
        scrollHeight: number;
        scrollTop: number;
    }>) {
        this.clientHeight = params.clientHeight;
        this.scrollHeight = params.scrollHeight;
        this.scrollTopValue = params.scrollTop;
    }

    public get scrollTop(): number {
        return this.scrollTopValue;
    }

    public set scrollTop(value: number) {
        const max = Math.max(0, this.scrollHeight - this.clientHeight);
        this.scrollTopValue = Math.max(0, Math.min(value, max));
    }
}

function createMetrics(params: Readonly<{
    clientHeight?: number;
    scrollHeight?: number;
    scrollTop?: number;
}> = {}) {
    const element = new FakeElement({
        clientHeight: params.clientHeight ?? 500,
        scrollHeight: params.scrollHeight ?? 1000,
        scrollTop: params.scrollTop ?? 100,
    });
    return {
        element,
        metrics: {
            clientHeight: element.clientHeight,
            element: element as unknown as HTMLElement,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
        },
    };
}

function createResult(result: Partial<SidechainOlderPageLoadResult> = {}): SidechainOlderPageLoadResult {
    return {
        loaded: result.loaded ?? 1,
        hasMore: result.hasMore ?? true,
        status: result.status ?? 'loaded',
    };
}

describe('applySidechainOlderPageLoad', () => {
    it('does not start an older-page load without a loader', async () => {
        const setLoadingOlder = vi.fn();

        await expect(applySidechainOlderPageLoad({
            hasMoreOlder: true,
            isLoadingOlder: false,
            loadOlder: null,
            setHasMoreOlder: vi.fn(),
            setLoadingOlder,
            waitForVisualUpdate: vi.fn(),
            webDomObservation: createWebDomScrollObservation(),
            webPrependAnchor: null,
        })).resolves.toBeNull();

        expect(setLoadingOlder).not.toHaveBeenCalled();
    });

    it.each([
        { hasMoreOlder: true, isLoadingOlder: true },
        { hasMoreOlder: false, isLoadingOlder: false },
    ])('does not start an older-page load for guarded state %j', async (state) => {
        const loadOlder = vi.fn(async () => createResult());

        await expect(applySidechainOlderPageLoad({
            ...state,
            loadOlder,
            setHasMoreOlder: vi.fn(),
            setLoadingOlder: vi.fn(),
            waitForVisualUpdate: vi.fn(),
            webDomObservation: createWebDomScrollObservation(),
            webPrependAnchor: null,
        })).resolves.toBeNull();

        expect(loadOlder).not.toHaveBeenCalled();
    });

    it('waits for the sidechain visual update before preserving web prepend growth', async () => {
        const { element, metrics } = createMetrics();
        const observation = createWebDomScrollObservation();
        const events: string[] = [];

        const result = await applySidechainOlderPageLoad({
            hasMoreOlder: true,
            isLoadingOlder: false,
            loadOlder: vi.fn(async () => {
                events.push('load');
                return createResult({ loaded: 2 });
            }),
            setHasMoreOlder: vi.fn(),
            setLoadingOlder: (loading) => {
                events.push(`loading:${loading}`);
            },
            waitForVisualUpdate: async () => {
                events.push('visual-update');
                element.scrollHeight = 1300;
            },
            webDomObservation: observation,
            webPrependAnchor: metrics,
        });

        expect(result).toEqual(createResult({ loaded: 2 }));
        expect(events).toEqual(['loading:true', 'load', 'visual-update', 'loading:false']);
        expect(element.scrollTop).toBe(400);
        expect(observation.getState()).toMatchObject({
            observedScrollHeight: 1300,
            observedScrollTop: 400,
        });
    });

    it('does not wait or restore web prepend growth when no older rows loaded', async () => {
        const { element, metrics } = createMetrics();
        const waitForVisualUpdate = vi.fn(async () => {
            element.scrollHeight = 1300;
        });

        const result = await applySidechainOlderPageLoad({
            hasMoreOlder: true,
            isLoadingOlder: false,
            loadOlder: vi.fn(async () => createResult({ loaded: 0 })),
            setHasMoreOlder: vi.fn(),
            setLoadingOlder: vi.fn(),
            waitForVisualUpdate,
            webDomObservation: createWebDomScrollObservation(),
            webPrependAnchor: metrics,
        });

        expect(result).toEqual(createResult({ loaded: 0 }));
        expect(waitForVisualUpdate).not.toHaveBeenCalled();
        expect(element.scrollTop).toBe(100);
    });

    it.each([
        createResult({ status: 'no_more' }),
        createResult({ hasMore: false }),
    ])('marks no-more state from load result %j', async (loadResult) => {
        const setHasMoreOlder = vi.fn();

        await expect(applySidechainOlderPageLoad({
            hasMoreOlder: true,
            isLoadingOlder: false,
            loadOlder: vi.fn(async () => loadResult),
            setHasMoreOlder,
            setLoadingOlder: vi.fn(),
            waitForVisualUpdate: vi.fn(),
            webDomObservation: createWebDomScrollObservation(),
            webPrependAnchor: null,
        })).resolves.toEqual(loadResult);

        expect(setHasMoreOlder).toHaveBeenCalledOnce();
        expect(setHasMoreOlder).toHaveBeenCalledWith(false);
    });

    it('clears the in-flight flag and rethrows loader failures', async () => {
        const events: string[] = [];

        await expect(applySidechainOlderPageLoad({
            hasMoreOlder: true,
            isLoadingOlder: false,
            loadOlder: vi.fn(async () => {
                events.push('load');
                throw new Error('load failed');
            }),
            setHasMoreOlder: vi.fn(),
            setLoadingOlder: (loading) => {
                events.push(`loading:${loading}`);
            },
            waitForVisualUpdate: vi.fn(),
            webDomObservation: createWebDomScrollObservation(),
            webPrependAnchor: null,
        })).rejects.toThrow('load failed');

        expect(events).toEqual(['loading:true', 'load', 'loading:false']);
    });
});

describe('applySidechainPaginationOlderPageLoad', () => {
    it('returns no-more without calling the older-page loader when pagination already exhausted', async () => {
        const loadOlder = vi.fn(async () => createResult());

        await expect(applySidechainPaginationOlderPageLoad({
            hasMoreOlder: false,
            listLayoutHeightPx: 500,
            loadOlder,
            resolveViewportGuardThresholdPx: vi.fn(() => 72),
            resolveWebPrependAnchor: vi.fn(() => null),
        })).resolves.toEqual({
            loaded: 0,
            hasMore: false,
            status: 'no_more',
        });

        expect(loadOlder).not.toHaveBeenCalled();
    });

    it('captures the viewport-guarded web prepend anchor before delegating to the older-page operation', async () => {
        const { metrics } = createMetrics();
        const resolveViewportGuardThresholdPx = vi.fn(() => 96);
        const resolveWebPrependAnchor = vi.fn(() => metrics);
        const loadOlder = vi.fn(async () => createResult({ loaded: 3 }));

        await expect(applySidechainPaginationOlderPageLoad({
            hasMoreOlder: true,
            listLayoutHeightPx: 640,
            loadOlder,
            resolveViewportGuardThresholdPx,
            resolveWebPrependAnchor,
        })).resolves.toEqual(createResult({ loaded: 3 }));

        expect(resolveViewportGuardThresholdPx).toHaveBeenCalledOnce();
        expect(resolveViewportGuardThresholdPx).toHaveBeenCalledWith(640);
        expect(resolveWebPrependAnchor).toHaveBeenCalledOnce();
        expect(resolveWebPrependAnchor).toHaveBeenCalledWith(96);
        expect(loadOlder).toHaveBeenCalledOnce();
        expect(loadOlder).toHaveBeenCalledWith({ webPrependAnchor: metrics });
    });
});
