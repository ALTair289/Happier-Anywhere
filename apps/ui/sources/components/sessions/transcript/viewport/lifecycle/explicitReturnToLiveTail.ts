import type { TranscriptViewportLifecycleEffect } from './lifecycle';

type ExplicitReturnViewportChangeEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'viewport-change' }
>;

export type ExplicitReturnToLiveTailViewportEffect = Readonly<{
    distanceFromLiveTailPx: number;
    isPinned: true;
    sessionId: string;
    type: 'apply-explicit-return-to-live-tail-viewport';
}>;

export function resolveExplicitReturnToLiveTailViewportEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): readonly ExplicitReturnToLiveTailViewportEffect[] {
    const viewportEffects: ExplicitReturnToLiveTailViewportEffect[] = [];
    for (const effect of params.effects) {
        if (
            effect.sessionId !== params.sessionId ||
            effect.type !== 'viewport-change' ||
            effect.source !== 'explicit-return'
        ) {
            continue;
        }
        const viewportChangeEffect: ExplicitReturnViewportChangeEffect = effect;
        viewportEffects.push({
            distanceFromLiveTailPx: viewportChangeEffect.distanceFromLiveTailPx,
            isPinned: true,
            sessionId: viewportChangeEffect.sessionId,
            type: 'apply-explicit-return-to-live-tail-viewport',
        });
    }
    return viewportEffects;
}
