import { describe, expect, it } from 'vitest';

import { readRememberedEngineSelection, upsertRememberedEngineSelection } from './rememberedEngineSelections';

describe('rememberedEngineSelections opaque identifiers', () => {
    const target = { kind: 'builtInAgent', agentId: 'cursor' } as const;

    it('preserves exact nonblank model and mode identifiers', () => {
        const stored = upsertRememberedEngineSelection({
            selectionsByScope: {},
            serverId: null,
            backendTarget: target,
            selection: { modelId: ' model-a ', acpSessionModeId: ' plan ' },
            updatedAt: 1,
        });

        expect(readRememberedEngineSelection({
            enabled: true,
            selectionsByScope: stored,
            serverId: null,
            backendTarget: target,
        })).toMatchObject({ modelId: ' model-a ', acpSessionModeId: ' plan ' });
    });
});
