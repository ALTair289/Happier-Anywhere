// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LegendList } from '@legendapp/list/react-native';

import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { resolveMainTranscriptListShellFrame } from '../transcriptListShellCapabilities';
import { legendListRenderer } from './legendListRenderer';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

type Row = Readonly<{
    height: number;
    id: string;
    index: number;
}>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

const resizeObservers = new Set<ResizeObserverRecord>();
let viewportHeight = 772;

function rect(width: number, height: number): DOMRectReadOnly {
    return {
        bottom: height,
        height,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    };
}

function measuredRect(element: Element): DOMRectReadOnly {
    const htmlElement = element as HTMLElement;
    if (htmlElement.id === 'virt-legend-host') {
        return rect(800, viewportHeight);
    }
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, viewportHeight);
    }
    const row = htmlElement.querySelector<HTMLElement>('[data-testid^="virt-row-"]');
    if (row) {
        return rect(800, Number(row.dataset.height ?? 72));
    }
    return rect(800, Number.parseFloat(htmlElement.style.height || '0') || 0);
}

function flushResizeObservers(): void {
    for (const observer of resizeObservers) {
        const entries = [...observer.elements].map((element) => ({
            borderBoxSize: [],
            contentBoxSize: [],
            contentRect: measuredRect(element),
            devicePixelContentBoxSize: [],
            target: element,
        })) as ResizeObserverEntry[];
        if (entries.length > 0) observer.callback(entries, {} as ResizeObserver);
    }
}

async function flushLegendWork(passes = 10): Promise<void> {
    for (let pass = 0; pass < passes; pass += 1) {
        await act(async () => {
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
    }
}

function renderRow({ item }: Readonly<{ item: Row }>): React.ReactElement {
    return (
        <div
            data-height={item.height}
            data-index={item.index}
            data-testid={`virt-row-${item.id}`}
            style={{ height: item.height }}
        >
            {item.id}
        </div>
    );
}

function findScrollElement(): HTMLElement {
    const element = document.getElementById('virt-legend-host')
        ?.querySelector<HTMLElement>('[style*="overflow"]');
    expect(element).not.toBeNull();
    return element!;
}

/**
 * A user scroll on web is a wheel/gesture followed by the browser moving the scroller and
 * emitting `scroll`. Reproduce both halves: the transcript adapter classifies movement without
 * a preceding input event as programmatic and re-asserts its held tail, which would mask
 * whatever Legend did with the offset.
 */
async function userScrollTo(element: HTMLElement & { __scrollTop?: number }, top: number): Promise<void> {
    const delta = top - (element.__scrollTop ?? 0);
    await act(async () => {
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: delta }));
    });
    await act(async () => {
        element.__scrollTop = Math.max(0, Math.min(top, Math.max(0, element.scrollHeight - element.clientHeight)));
        element.dispatchEvent(new Event('scroll'));
    });
}

function renderedIndices(): number[] {
    return [...document.querySelectorAll<HTMLElement>('[data-testid^="virt-row-"]')]
        .map((element) => Number(element.dataset.index))
        .filter((index) => Number.isFinite(index))
        .sort((a, b) => a - b);
}

describe('Legend web transcript re-virtualizes from real scroller movement', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        viewportHeight = 772;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        container = document.createElement('div');
        container.style.height = '772px';
        document.body.appendChild(container);
        root = createRoot(container);

        class TestResizeObserver implements ResizeObserver {
            private readonly record: ResizeObserverRecord;

            constructor(callback: ResizeObserverCallback) {
                this.record = { callback, elements: new Set() };
                resizeObservers.add(this.record);
            }

            disconnect(): void {
                this.record.elements.clear();
                resizeObservers.delete(this.record);
            }

            observe(target: Element): void {
                resizeObservers.add(this.record);
                this.record.elements.add(target);
            }

            unobserve(target: Element): void {
                this.record.elements.delete(target);
            }
        }

        vi.stubGlobal('ResizeObserver', TestResizeObserver);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect(this: HTMLElement) {
            return measuredRect(this);
        });
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            get() {
                return measuredRect(this).height;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get() {
                return measuredRect(this).width;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get() {
                const element = this as HTMLElement;
                let materializedTotal = 0;
                for (const row of element.querySelectorAll<HTMLElement>('[data-height]')) {
                    materializedTotal += Number(row.dataset.height ?? 0);
                }
                let virtualContentHeight = 0;
                for (const descendant of element.querySelectorAll<HTMLElement>('[style]')) {
                    virtualContentHeight = Math.max(
                        virtualContentHeight,
                        Number.parseFloat(descendant.style.height || '0') || 0,
                    );
                }
                return Math.max(element.clientHeight, materializedTotal, virtualContentHeight);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
            configurable: true,
            get() {
                return (this as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0;
            },
            set(value: number) {
                const element = this as HTMLElement & { __scrollTop?: number };
                const max = Math.max(0, element.scrollHeight - element.clientHeight);
                element.__scrollTop = Math.max(0, Math.min(value, max));
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const top = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
                this.scrollTop = top;
                this.dispatchEvent(new Event('scroll'));
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const delta = typeof options === 'number' ? (y ?? 0) : (options.top ?? 0);
                this.scrollTo({ top: this.scrollTop + delta });
            },
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 0) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
            clearTimeout(handle);
        });
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });


    // CONTROL: the installed Legend web build with no transcript adapter in the path. Isolates
    // "does Legend re-virtualize from a DOM scroll event" from "does the adapter let it".
    it('control: the installed Legend web build re-virtualizes on a raw scroll event', async () => {
        const data: Row[] = Array.from({ length: 54 }, (_value, index) => ({
            height: index === 1 ? 3_800 : 72,
            id: `virt-${index}`,
            index,
        }));

        await act(async () => {
            root.render(
                <div id="virt-legend-host" style={{ height: 772 }}>
                    <LegendList
                        alignItemsAtEnd
                        data={data}
                        estimatedItemSize={240}
                        initialScrollAtEnd
                        keyExtractor={(item: Row) => item.id}
                        maintainVisibleContentPosition={{ data: true, size: true }}
                        recycleItems={false}
                        renderItem={renderRow}
                        style={{ flex: 1, minHeight: 0 }}
                    />
                </div>,
            );
        });
        await flushLegendWork();

        const scrollElement = findScrollElement() as HTMLElement & { __scrollTop?: number };
        expect(renderedIndices()).toContain(53);

        await act(async () => {
            scrollElement.__scrollTop = 0;
            scrollElement.dispatchEvent(new Event('scroll'));
        });
        await flushLegendWork();

        const topIndices = renderedIndices();
        expect(
            topIndices,
            `raw Legend must mount index 0 at scrollTop 0; mounted=${topIndices.join(',')}`,
        ).toContain(0);
    });

    // Live web capture (session cms3bvdv13hlutm9p19hw1n9s, 2026-07-28): the transcript scroller
    // reported scrollHeight 16235 / scrollTop 15463 while only THREE rows were mounted, all of
    // them at the very top of the content box (tops 0, 0, 3870) and identical at BOTH scroll
    // extremes. That is a list that no longer re-virtualizes: the viewport is painted ~15k px
    // below the only rows Legend has laid out, so the user sees a ~12.3k px empty tail.
    //
    // The transcript's row heights are wildly larger than the 240px estimate scalar, which is
    // exactly the shape reproduced here: one oversized row plus many small ones.
    it('moves the mounted index range when the DOM scroller moves', async () => {
        const Renderer = legendListRenderer.Component;
        const data: Row[] = Array.from({ length: 54 }, (_value, index) => ({
            height: index === 1 ? 3_800 : 72,
            id: `virt-${index}`,
            index,
        }));

        await act(async () => {
            root.render(
                <div id="virt-legend-host" style={{ height: 772 }}>
                    <Renderer
                        data={data}
                        dataKey="virtualization-session"
                        frame={resolveMainTranscriptListShellFrame({
                            legendInitialScrollAtEnd: true,
                            maintainScrollAtEndThreshold: 0.1,
                            nativeID: 'virt-legend-host',
                            platformOS: 'web',
                        })}
                        keyExtractor={(item: Row) => item.id}
                        renderItem={renderRow}
                        webDomObservation={createWebDomScrollObservation()}
                    />
                </div>,
            );
        });
        await flushLegendWork();

        const scrollElement = findScrollElement() as HTMLElement & { __scrollTop?: number };
        const tailIndices = renderedIndices();
        expect(
            tailIndices,
            `initial end placement must mount the last row; mounted=${tailIndices.join(',')}`,
        ).toContain(53);

        // Genuine user scroll to the very top of the same scroller.
        await userScrollTo(scrollElement, 0);
        await flushLegendWork();

        const topIndices = renderedIndices();
        expect(
            topIndices,
            `scrolling to offset 0 must mount the first row; mounted=${topIndices.join(',')}`,
        ).toContain(0);
        expect(
            topIndices,
            `scrolling to offset 0 must unmount the tail row; mounted=${topIndices.join(',')}`,
        ).not.toContain(53);

        // ...and back to the live tail.
        const maxOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
        await userScrollTo(scrollElement, maxOffset);
        await flushLegendWork();

        const backIndices = renderedIndices();
        expect(
            backIndices,
            `scrolling back to the tail must remount the last row; mounted=${backIndices.join(',')}`,
        ).toContain(53);

        // The defect signature: an enormous empty region below the last mounted row.
        const rowElements = [...document.querySelectorAll<HTMLElement>('[data-testid^="virt-row-"]')];
        expect(rowElements.length).toBeGreaterThan(0);
        const contentSize = scrollElement.scrollHeight;
        const lastMountedBottom = Math.max(...rowElements.map((element) => {
            const positioned = element.closest<HTMLElement>('[style*="position"]');
            const top = Number.parseFloat(positioned?.style.top || '0') || 0;
            return top + Number(element.dataset.height ?? 0);
        }));
        expect(
            contentSize - lastMountedBottom,
            `tail gap below the last mounted row must stay bounded (content=${contentSize} lastBottom=${lastMountedBottom})`,
        ).toBeLessThan(viewportHeight * 2);
    });

    // Why the same rows appear at both scroll extremes when a probe MOVES the scroller from
    // JavaScript: a bare `scrollTop = n` write carries no user-input evidence, so the adapter
    // classifies the resulting `scroll` event as an external offset rollback and re-asserts its
    // live held-'end' intent inside the same flush. The offset never rests where the probe put
    // it, so the mounted index range has no reason to move. Instrumentation that writes
    // `scrollTop` directly therefore cannot observe virtualization at all - it must dispatch the
    // input event too (see `userScrollTo` above), or the reading is an artifact.
    it('re-asserts the held tail when a scroll offset is written without user input', async () => {
        const Renderer = legendListRenderer.Component;
        const data: Row[] = Array.from({ length: 54 }, (_value, index) => ({
            height: index === 1 ? 3_800 : 72,
            id: `virt-${index}`,
            index,
        }));

        await act(async () => {
            root.render(
                <div id="virt-legend-host" style={{ height: 772 }}>
                    <Renderer
                        data={data}
                        dataKey="programmatic-write-session"
                        frame={resolveMainTranscriptListShellFrame({
                            legendInitialScrollAtEnd: true,
                            maintainScrollAtEndThreshold: 0.1,
                            nativeID: 'virt-legend-host',
                            platformOS: 'web',
                        })}
                        keyExtractor={(item: Row) => item.id}
                        renderItem={renderRow}
                        webDomObservation={createWebDomScrollObservation()}
                    />
                </div>,
            );
        });
        await flushLegendWork();

        const scrollElement = findScrollElement() as HTMLElement & { __scrollTop?: number };
        const restingTail = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
        expect(scrollElement.scrollTop).toBeGreaterThanOrEqual(restingTail - 1);

        await act(async () => {
            scrollElement.__scrollTop = 0;
            scrollElement.dispatchEvent(new Event('scroll'));
        });
        await flushLegendWork();

        expect(
            Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight) - scrollElement.scrollTop,
            `an input-less scrollTop write must not detach the held tail (top=${scrollElement.scrollTop} of ${scrollElement.scrollHeight})`,
        ).toBeLessThanOrEqual(viewportHeight);
        expect(
            renderedIndices(),
            'the tail row stays mounted because the offset was restored, not because virtualization is dead',
        ).toContain(53);
    });
});
