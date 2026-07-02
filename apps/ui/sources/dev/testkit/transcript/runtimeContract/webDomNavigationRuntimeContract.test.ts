import { describe, expect, it } from 'vitest';

import { TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import { deriveWebTranscriptNavigationAnchorRows } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';

import { createWebDomNavigationRuntimeModel } from './webDomNavigationRuntimeModel';

describe('web DOM navigation runtime contract — virtualized restore and jump', () => {
    it('restores a virtualized anchor from measured layout and records the DOM self-write', () => {
        const model = createWebDomNavigationRuntimeModel({
            clientHeightPx: 600,
            itemCount: 500,
            mountedIndexes: [8, 9, 10],
            rowHeightPx: 80,
            scrollTopPx: 800,
        });

        const result = model.restoreIndex({
            itemId: 'msg-320',
            index: 320,
            itemOffsetPx: 72,
        });

        expect(result).toEqual({
            ok: true,
            landedScrollTop: 25528,
            targetScrollTop: 25528,
            targetWasMounted: false,
        });
        expect(model.observeItem(320)).toEqual({
            bottom: 152,
            center: 112,
            top: 72,
        });
        expect(model.observeSelfWrite()).toEqual({
            observedScrollHeight: 40000,
            observedScrollTop: 25528,
            echoIsGenuineUserMovement: false,
        });
    });

    it('centers a virtualized jump-to-seq target from measured layout and records the DOM self-write', () => {
        const model = createWebDomNavigationRuntimeModel({
            clientHeightPx: 600,
            itemCount: 500,
            mountedIndexes: [20, 21, 22],
            rowHeightPx: 80,
            scrollTopPx: 1600,
        });

        const result = model.jumpToSeq({
            itemId: 'msg-450',
            index: 450,
        });

        expect(result).toEqual({
            ok: true,
            landedScrollTop: 35740,
            targetScrollTop: 35740,
            targetWasMounted: false,
        });
        expect(model.observeItem(450)).toEqual({
            bottom: 340,
            center: 300,
            top: 260,
        });
        expect(model.observeSelfWrite()).toEqual({
            observedScrollHeight: 40000,
            observedScrollTop: 35740,
            echoIsGenuineUserMovement: false,
        });
    });

    it('renders production message-anchor test ids that navigation visibility can match', () => {
        const model = createWebDomNavigationRuntimeModel({
            clientHeightPx: 600,
            itemCount: 30,
            mountedIndexes: [7],
            rowHeightPx: 80,
            scrollTopPx: 0,
        });

        const testIds = model.observeMountedTestIds();

        expect(testIds).toEqual([
            `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}msg-7`,
        ]);
        expect(deriveWebTranscriptNavigationAnchorRows({
            anchors: [{
                id: 'session-1:user-turn:7',
                kind: 'user-turn',
                sourceIndex: 7,
                messageIds: ['msg-7'],
            }],
            rows: [{
                testId: testIds[0] ?? null,
                topPx: 0,
                bottomPx: 80,
            }],
        })).toEqual([{
            anchorId: 'session-1:user-turn:7',
            topPx: 0,
            bottomPx: 80,
        }]);
    });

    it('does not synthesize a fallback when neither DOM nor measured layout can locate the target', () => {
        const model = createWebDomNavigationRuntimeModel({
            clientHeightPx: 600,
            itemCount: 40,
            mountedIndexes: [1, 2, 3],
            rowHeightPx: 80,
            scrollTopPx: 80,
        });

        const result = model.jumpToSeq({
            itemId: 'msg-999',
            index: 999,
        });

        expect(result).toEqual({
            ok: false,
            reason: 'not_found',
            targetWasMounted: false,
        });
        expect(model.observe().scrollTop).toBe(80);
        expect(model.observeSelfWrite()).toEqual({
            observedScrollHeight: 3200,
            observedScrollTop: 80,
            echoIsGenuineUserMovement: false,
        });
    });
});
