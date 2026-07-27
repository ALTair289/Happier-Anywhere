import type { SyncTuning } from '@/sync/runtime/syncTuning';

import { flashListRenderer } from './flashListRenderer';
import { legendListRenderer } from './legendListRenderer';
import type {
    TranscriptListRendererBinding,
    TranscriptListRendererSelection,
} from './types';

export function resolveTranscriptListRendererSelection(params: Readonly<{
    platformOS: string;
    transcriptLegendListSpikeSurface: SyncTuning['transcriptLegendListSpikeSurface'];
}>): TranscriptListRendererSelection {
    const renderer =
        params.transcriptLegendListSpikeSurface === 'flashList'
            ? flashListRenderer
            : legendListRenderer;
    const positioningOwner = renderer.kind === 'flashList' ? 'app' : 'renderer';

    return {
        ownerPolicy: {
            continuousFollow: positioningOwner,
            initialBottomPosition: positioningOwner,
            localHeightChangeRestore: positioningOwner,
            prependRestore: positioningOwner,
            usesNativeFlashListBottomMaintenance:
                renderer.kind === 'flashList' && params.platformOS !== 'web',
        },
        renderer,
    };
}

export function resolveTranscriptListRendererBinding(params: Readonly<{
    frame: TranscriptListRendererBinding['frame'];
    selection: TranscriptListRendererSelection;
}>): TranscriptListRendererBinding {
    return {
        frame: params.frame,
        ownerPolicy: params.selection.ownerPolicy,
        renderer: params.selection.renderer,
    };
}
