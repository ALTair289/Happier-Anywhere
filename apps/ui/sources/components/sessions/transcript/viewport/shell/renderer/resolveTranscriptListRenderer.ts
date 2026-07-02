import { loadSyncTuning, type SyncTuning } from '@/sync/runtime/syncTuning';

import { flashListRenderer } from './flashListRenderer';
import { resolveTranscriptRendererSurface } from './transcriptRendererSurface';
import type { TranscriptListRenderer } from './types';
import type { TranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

export function resolveTranscriptListRenderer(params: Readonly<{
    frame: TranscriptListShellFrame;
    transcriptLegendListSpikeSurface?: SyncTuning['transcriptLegendListSpikeSurface'];
}>): TranscriptListRenderer {
    const requestedSurface =
        params.transcriptLegendListSpikeSurface ?? loadSyncTuning().transcriptLegendListSpikeSurface;
    const frameSurface = resolveTranscriptRendererSurface(params.frame);

    if (requestedSurface === 'off') return flashListRenderer;
    if (requestedSurface === frameSurface) return flashListRenderer;
    return flashListRenderer;
}
