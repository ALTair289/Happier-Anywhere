import { TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import {
    getWebTranscriptDistanceFromBottom,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    scrollWebDomToTranscriptItem,
} from '@/components/sessions/transcript/viewport/driver/webDom';
import {
    createWebDomScrollObservation,
} from '@/components/sessions/transcript/viewport/driver/webDomObservation';

export type WebDomNavigationRuntimeModelOptions = Readonly<{
    clientHeightPx: number;
    itemCount: number;
    mountedIndexes: readonly number[];
    rowHeightPx: number;
    scrollTopPx?: number;
}>;

export type WebDomNavigationWriteResult =
    | Readonly<{
        ok: true;
        landedScrollTop: number;
        targetScrollTop: number;
        targetWasMounted: boolean;
    }>
    | Readonly<{
        ok: false;
        reason: 'invalid_geometry' | 'not_found' | 'write_failed';
        targetWasMounted: boolean;
    }>;

type RuntimeRect = Readonly<{ bottom: number; height: number; top: number }>;

type RuntimeItemPosition = Readonly<{
    bottom: number;
    center: number;
    top: number;
}>;

class RuntimeElement {
    private readonly children: RuntimeElement[] = [];
    private readonly attributes = new Map<string, string>();
    private scrollTopValue = 0;

    public constructor(
        testId: string | null,
        private readonly resolveRect: () => RuntimeRect,
        public readonly clientHeight: number,
        public readonly scrollHeight: number,
    ) {
        if (testId) this.attributes.set('data-testid', testId);
    }

    public get scrollTop(): number {
        return this.scrollTopValue;
    }

    public set scrollTop(value: number) {
        const max = Math.max(0, this.scrollHeight - this.clientHeight);
        this.scrollTopValue = Math.max(0, Math.min(value, max));
    }

    public appendChild(child: RuntimeElement): void {
        this.children.push(child);
    }

    public getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    public getBoundingClientRect(): RuntimeRect {
        return this.resolveRect();
    }

    public querySelectorAll(selector: string): RuntimeElement[] {
        if (selector !== '[data-testid]') return [];
        const matches: RuntimeElement[] = [];
        const visit = (node: RuntimeElement) => {
            if (node.getAttribute('data-testid') != null) matches.push(node);
            for (const child of node.children) visit(child);
        };
        for (const child of this.children) visit(child);
        return matches;
    }
}

export class WebDomNavigationRuntimeModel {
    private readonly clientHeightPx: number;
    private readonly itemCount: number;
    private readonly mountedIndexes: Set<number>;
    private readonly rowHeightPx: number;
    private readonly scrollHeightPx: number;
    private readonly container: RuntimeElement;
    private readonly observation = createWebDomScrollObservation();

    public constructor(options: WebDomNavigationRuntimeModelOptions) {
        this.clientHeightPx = options.clientHeightPx;
        this.itemCount = options.itemCount;
        this.mountedIndexes = new Set(options.mountedIndexes);
        this.rowHeightPx = options.rowHeightPx;
        this.scrollHeightPx = options.itemCount * options.rowHeightPx;
        this.container = new RuntimeElement(
            null,
            () => ({ bottom: this.clientHeightPx, height: this.clientHeightPx, top: 0 }),
            this.clientHeightPx,
            this.scrollHeightPx,
        );
        this.container.scrollTop = options.scrollTopPx ?? 0;

        for (const index of this.mountedIndexes) {
            if (!this.hasMeasuredLayout(index)) continue;
            this.container.appendChild(new RuntimeElement(
                `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${this.itemIdForIndex(index)}`,
                () => this.rectForIndex(index),
                this.rowHeightPx,
                this.rowHeightPx,
            ));
        }
    }

    restoreIndex(params: Readonly<{ index: number; itemId: string; itemOffsetPx: number }>): WebDomNavigationWriteResult {
        return this.scrollToItem({
            align: { kind: 'top-with-item-offset', itemOffsetPx: params.itemOffsetPx },
            index: params.index,
            itemId: params.itemId,
        });
    }

    jumpToSeq(params: Readonly<{ index: number; itemId: string }>): WebDomNavigationWriteResult {
        return this.scrollToItem({
            align: { kind: 'center' },
            index: params.index,
            itemId: params.itemId,
        });
    }

    observe(): Readonly<{ scrollHeight: number; scrollTop: number }> {
        return {
            scrollHeight: this.container.scrollHeight,
            scrollTop: this.container.scrollTop,
        };
    }

    observeMountedTestIds(): readonly string[] {
        return this.container
            .querySelectorAll('[data-testid]')
            .map((node) => node.getAttribute('data-testid'))
            .filter((testId): testId is string => typeof testId === 'string');
    }

    observeItem(index: number): RuntimeItemPosition | null {
        if (!this.hasMeasuredLayout(index)) return null;
        const top = index * this.rowHeightPx - this.container.scrollTop;
        const bottom = top + this.rowHeightPx;
        return {
            bottom,
            center: top + this.rowHeightPx / 2,
            top,
        };
    }

    observeSelfWrite(): Readonly<{
        echoIsGenuineUserMovement: boolean;
        observedScrollHeight: number | null;
        observedScrollTop: number | null;
    }> {
        const metrics = this.metrics();
        const movement = this.observation.observeGenuineScrollMovement({
            distanceFromBottom: getWebTranscriptDistanceFromBottom(metrics),
            fallbackObservedScrollTop: null,
            isTrusted: true,
            pinThresholdPx: 72,
            metrics,
            sustainFrames: 2,
        });
        const state = this.observation.getState();
        return {
            echoIsGenuineUserMovement: movement.isGenuineUserMovement,
            observedScrollHeight: state.observedScrollHeight,
            observedScrollTop: state.observedScrollTop,
        };
    }

    private scrollToItem(params: Parameters<typeof scrollWebDomToTranscriptItem>[0] extends infer P
        ? P extends Readonly<{ align: infer A; itemId: string }>
            ? Readonly<{ align: A; index: number; itemId: string }>
            : never
        : never): WebDomNavigationWriteResult {
        const targetWasMounted = this.mountedIndexes.has(params.index);
        const result = scrollWebDomToTranscriptItem({
            align: params.align,
            itemId: params.itemId,
            itemLayout: this.hasMeasuredLayout(params.index)
                ? { height: this.rowHeightPx, y: params.index * this.rowHeightPx }
                : null,
            metrics: this.metrics(),
            observation: this.observation,
        });

        if (!result.ok) {
            return {
                ok: false,
                reason: result.reason,
                targetWasMounted,
            };
        }
        return {
            ok: true,
            landedScrollTop: result.landedScrollTop,
            targetScrollTop: result.targetScrollTop,
            targetWasMounted,
        };
    }

    private metrics(): WebTranscriptScrollMetrics {
        const container = this.container;
        return {
            // Testkit boundary: RuntimeElement intentionally implements the HTMLElement members the driver reads.
            element: container as unknown as HTMLElement,
            get scrollTop() {
                return container.scrollTop;
            },
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };
    }

    private hasMeasuredLayout(index: number): boolean {
        return Number.isInteger(index) && index >= 0 && index < this.itemCount;
    }

    private itemIdForIndex(index: number): string {
        return `msg-${index}`;
    }

    private rectForIndex(index: number): RuntimeRect {
        const top = index * this.rowHeightPx - this.container.scrollTop;
        return {
            bottom: top + this.rowHeightPx,
            height: this.rowHeightPx,
            top,
        };
    }
}

export function createWebDomNavigationRuntimeModel(
    options: WebDomNavigationRuntimeModelOptions,
): WebDomNavigationRuntimeModel {
    return new WebDomNavigationRuntimeModel(options);
}
