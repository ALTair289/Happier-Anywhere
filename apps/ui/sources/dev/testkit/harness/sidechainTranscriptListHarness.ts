export type SidechainTranscriptRendererAxis = Readonly<{
    expectedDataOrder: 'oldest-first' | 'newest-first';
    expectedHostType: 'FlashList' | 'LegendList';
    id: string;
    platformOS: 'web' | 'ios';
    rendererKind: 'flashList' | 'legendList';
    transcriptLegendListSpikeSurface: 'flashList' | 'off';
}>;

export const SIDECHAIN_TRANSCRIPT_RENDERER_AXES: readonly SidechainTranscriptRendererAxis[] = [
    {
        expectedDataOrder: 'oldest-first',
        expectedHostType: 'LegendList',
        id: 'web/legend',
        platformOS: 'web',
        rendererKind: 'legendList',
        transcriptLegendListSpikeSurface: 'off',
    },
    {
        expectedDataOrder: 'oldest-first',
        expectedHostType: 'LegendList',
        id: 'native/legend',
        platformOS: 'ios',
        rendererKind: 'legendList',
        transcriptLegendListSpikeSurface: 'off',
    },
    {
        expectedDataOrder: 'oldest-first',
        expectedHostType: 'FlashList',
        id: 'web/flashlist',
        platformOS: 'web',
        rendererKind: 'flashList',
        transcriptLegendListSpikeSurface: 'flashList',
    },
    {
        expectedDataOrder: 'newest-first',
        expectedHostType: 'FlashList',
        id: 'native/flashlist',
        platformOS: 'ios',
        rendererKind: 'flashList',
        transcriptLegendListSpikeSurface: 'flashList',
    },
];

export function findSidechainTranscriptRenderer(
    // Renderer props are a third-party boundary shape and intentionally remain open in this test harness.
    screen: Readonly<{ findByType(type: string): { props: Record<string, any> } }>,
    axis: SidechainTranscriptRendererAxis,
) {
    return screen.findByType(axis.expectedHostType);
}
