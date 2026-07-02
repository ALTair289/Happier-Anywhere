import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const chatListPath = path.resolve(__dirname, 'ChatList.tsx');

describe('ChatList bottom-follow write scheduler boundary', () => {
    it('routes automatic bottom-follow write authorities through the scheduler owner', () => {
        const source = fs.readFileSync(chatListPath, 'utf8');

        expect(source).toContain('planBottomFollowWriteSchedulerEvent');

        for (const callbackName of [
            'applyWebPassiveLiveTailCorrectionEffect',
            'applyNativeEntrySettleConfirmationEffects',
            'pinNativeLiveTailForHotTailHeight',
            'deferPinToBottomAfterScroll',
            'requestMeasuredNativeAutomaticLiveTailPin',
        ]) {
            const body = extractCallbackBody(source, callbackName);
            expect(body).toContain('authorizeImmediateBottomFollowWriteRef.current');
            expect(body).not.toMatch(/(pinNativeFlashListToBottomIfMeasured|pinToBottomRespectingNativeMountSettle|pinToBottom|applyWebBottomFollowAdjustment)\(/);
        }

        expect(source).not.toContain('applyContentGrowthLiveTailScheduledPinFireEffects');
    });
});

function extractCallbackBody(source: string, callbackName: string): string {
    const start = source.indexOf(`const ${callbackName} = React.useCallback`);
    expect(start, `missing callback ${callbackName}`).toBeGreaterThanOrEqual(0);
    const nextCallback = source.indexOf('\n    const ', start + 1);
    return source.slice(start, nextCallback === -1 ? undefined : nextCallback);
}
