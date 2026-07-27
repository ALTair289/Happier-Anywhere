import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import type { SpawnSessionOptions } from '@/sync/domains/session/spawn/spawnSessionPayload';
import { createUiSessionSpawnUserAttemptId } from '@/sync/domains/session/spawn/spawnSessionNonce';
import {
    completeMachineSpawnAttemptCustody,
    machineSpawnNewSessionUntilResolved,
    type MachineSpawnNewSessionUntilResolvedResult,
} from '@/sync/ops/machines';

export type MachineDetailSpawnAttempt = Readonly<{
    userAttemptId: string;
    firstTurnLocalId: string;
    attachmentMessageLocalId: string;
}>;

export function createMachineDetailSpawnAttempt(): MachineDetailSpawnAttempt {
    const userAttemptId = createUiSessionSpawnUserAttemptId();
    return {
        userAttemptId,
        firstTurnLocalId: `machine-detail-spawn-first-turn:${userAttemptId}`,
        attachmentMessageLocalId: `machine-detail-spawn-attachments:${userAttemptId}`,
    };
}

export async function runMachineDetailSpawnAttempt(params: Readonly<{
    options: SpawnSessionOptions;
    attempt: MachineDetailSpawnAttempt;
}>): Promise<MachineSpawnNewSessionUntilResolvedResult> {
    const result = await machineSpawnNewSessionUntilResolved({
        ...params.options,
        userAttemptId: params.attempt.userAttemptId,
        firstTurnLocalId: params.attempt.firstTurnLocalId,
        attachmentMessageLocalId: params.attempt.attachmentMessageLocalId,
    });
    if (result.type !== 'success') return result;

    const custody = result.spawnAttemptCustody;
    if (
        custody?.status !== 'completed'
        || custody.userAttemptId !== params.attempt.userAttemptId
        || custody.firstTurnLocalId !== params.attempt.firstTurnLocalId
        || custody.attachmentMessageLocalId !== params.attempt.attachmentMessageLocalId
    ) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'The completed session launch did not match this machine-detail launch attempt.',
        };
    }

    const completed = await completeMachineSpawnAttemptCustody({
        machineId: params.options.machineId,
        serverId: params.options.serverId,
        custody,
    });
    if (!completed) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'The session started, but its launch recovery state could not be completed. Please retry.',
            spawnAttemptCustody: custody,
        };
    }
    return result;
}
