import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { resolveMainTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

import { flashListRenderer } from './flashListRenderer';
import { legendListRenderer } from './legendListRenderer';
import type { TranscriptListShellRef } from './types';

type Row = Readonly<{ id: string }>;

const ROWS: readonly Row[] = [
    { id: 'row-0' },
    { id: 'row-1' },
    { id: 'row-2' },
    { id: 'row-3' },
];

let flashListHandle: Record<string, unknown> | null = null;
let legendState: Record<string, unknown> | null = null;

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((_props: Record<string, unknown>, ref: React.Ref<unknown>) => {
        if (typeof ref === 'function') ref(flashListHandle);
        else if (ref && typeof ref === 'object') {
            (ref as React.MutableRefObject<unknown>).current = flashListHandle;
        }
        return React.createElement('FlashList', null);
    }),
    LayoutCommitObserver: (props: Readonly<{ children: React.ReactNode }>) => (
        React.createElement(React.Fragment, null, props.children)
    ),
}));

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((_props: Record<string, unknown>, ref: React.Ref<unknown>) => {
        const instance = React.useMemo(() => ({
            getState: () => legendState ?? undefined,
            getScrollableNode: () => null,
            scrollToIndex: () => Promise.resolve(),
            scrollToOffset: () => Promise.resolve(),
            scrollToEnd: () => Promise.resolve(),
        }), []);
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') {
            (ref as React.MutableRefObject<unknown>).current = instance;
        }
        return React.createElement('LegendList', null);
    }),
}));

async function mountRenderer(
    renderer: typeof flashListRenderer | typeof legendListRenderer,
): Promise<React.RefObject<TranscriptListShellRef<Row> | null>> {
    const Renderer = renderer.Component;
    const listRef = React.createRef<TranscriptListShellRef<Row>>();
    await renderScreen(
        <Renderer
            ref={listRef}
            webDomObservation={createWebDomScrollObservation()}
            data={ROWS}
            dataKey="session-1"
            keyExtractor={(item: Row) => item.id}
            renderItem={({ item }: { item: Row }) => React.createElement('Row', { id: item.id })}
            frame={resolveMainTranscriptListShellFrame({ platformOS: 'web' })}
        />,
    );
    return listRef;
}

describe('renderer visible source index range', () => {
    it('reads the FlashList surface visible window through the renderer seam', async () => {
        flashListHandle = {
            computeVisibleIndices: () => ({ startIndex: 1, endIndex: 2 }),
        };

        const listRef = await mountRenderer(flashListRenderer);

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toEqual({ startIndex: 1, endIndex: 2 });
    });

    it('reports no measurement instead of row 0 when the FlashList surface cannot answer', async () => {
        flashListHandle = {
            computeVisibleIndices: () => {
                throw new Error('layout manager not initialized');
            },
        };

        const listRef = await mountRenderer(flashListRenderer);

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toBeNull();
    });

    it('reports no measurement when the FlashList surface exposes no visible window at all', async () => {
        flashListHandle = {};

        const listRef = await mountRenderer(flashListRenderer);

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toBeNull();
    });

    it('reads the Legend surface visible window through the same seam', async () => {
        legendState = { start: 1, end: 2 };

        const listRef = await mountRenderer(legendListRenderer);

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toEqual({ startIndex: 1, endIndex: 2 });
    });

    it('reports no measurement instead of row 0 when the Legend surface has no state yet', async () => {
        legendState = null;

        const listRef = await mountRenderer(legendListRenderer);

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toBeNull();
        // The legacy window read cannot express it: {0,0} is indistinguishable
        // from genuinely viewing the first row.
        expect(listRef.current?.computeVisibleIndices?.()).toEqual({ startIndex: 0, endIndex: 0 });
    });
});
