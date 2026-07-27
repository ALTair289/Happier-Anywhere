import { deriveSessionAuthoringSnapshot } from '@/sync/domains/sessionAuthoring/deriveSessionAuthoringSnapshot';
import {
    normalizeOptionalString,
} from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import type { NewSessionData } from '@/utils/sessions/tempDataStore';
import {
    readSessionConfigOptionOverridesState,
    readSessionModeOverrideState,
} from '@/sync/domains/sessionControl/readSessionControlMetadata';

import type { ExistingSessionAuthoringSnapshotSession } from './sessionAuthoringDraftAdapters';
import {
    buildNewSessionAuthoringDraft,
    buildNewSessionTempDataFromAuthoringDraft,
} from './sessionAuthoringDraftAdapters';

export function buildNewSessionTempDataFromSessionConfiguration(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    machineId: string | null;
    directoryOverride?: string | null;
}>): NewSessionData {
    const snapshot = deriveSessionAuthoringSnapshot({
        session: params.session,
    });
    const directoryOverride = normalizeOptionalString(params.directoryOverride);
    const draft = buildNewSessionAuthoringDraft({
        directory: directoryOverride ?? snapshot.directory,
        checkoutCreationDraft: null,
        prompt: '',
        displayText: '',
        agentId: snapshot.agentId,
        backendTarget: snapshot.backendTarget,
        transcriptStorage: snapshot.transcriptStorage,
        profileId: snapshot.profileId,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: snapshot.permissionMode,
        permissionModeUpdatedAt: snapshot.permissionModeUpdatedAt,
        modelId: snapshot.modelId,
        modelUpdatedAt: snapshot.modelUpdatedAt,
        mcpSelection: snapshot.mcpSelection,
        connectedServices: snapshot.connectedServices,
        terminal: snapshot.terminal,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        experimentalCodexAcp: null,
        codexBackendMode: snapshot.codexBackendMode,
        acpSessionModeId: (() => {
            const override = readSessionModeOverrideState(params.session.metadata);
            return override?.state === 'set' ? normalizeOptionalString(override.value) : null;
        })(),
        sessionConfigOptionOverrides: readSessionConfigOptionOverridesState(params.session.metadata),
        automation: null,
    });

    return {
        ...buildNewSessionTempDataFromAuthoringDraft({
            draft,
            machineId: params.machineId,
        }),
        replacePersistedDraftSelections: true,
    };
}
