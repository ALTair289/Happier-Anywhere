/**
 * Focused session ripgrep operation.
 * Kept separate from the broad session operations barrel so lazy autocomplete file-search
 * code can load only the RPC surface it needs.
 */

import { apiSocket } from '../api/session/apiSocket';
import { assertRpcResponseWithSuccess } from '../runtime/assertRpcResponseWithSuccess';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
import {
    canUseSessionRpc,
    readMachineControlTargetForSession,
    resolveMachinePathFromSessionBase,
    shouldFallbackToSessionRpc,
} from './sessionMachineTarget';

interface SessionRipgrepRequest {
    args: string[];
    cwd?: string;
}

export interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

const INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR = 'Session RPC unavailable for inactive session';

/**
 * Run ripgrep in the session.
 */
export async function sessionRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string,
): Promise<SessionRipgrepResponse> {
    try {
        const machineTarget = readMachineControlTargetForSession(sessionId);
        if (machineTarget) {
            try {
                const request: SessionRipgrepRequest = {
                    args,
                    cwd: resolveMachinePathFromSessionBase({
                        basePath: machineTarget.basePath,
                        agentBasePath: machineTarget.agentBasePath,
                        requestPath: cwd,
                    }),
                };
                const response = await apiSocket.machineRPC<SessionRipgrepResponse, SessionRipgrepRequest>(
                    machineTarget.machineId,
                    'ripgrep',
                    request,
                );
                return assertRpcResponseWithSuccess<SessionRipgrepResponse>(response);
            } catch (error) {
                if (!shouldFallbackToSessionRpc(sessionId, error)) {
                    throw error;
                }
            }
        }

        if (!canUseSessionRpc(sessionId)) {
            return {
                success: false,
                error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
            };
        }

        const request: SessionRipgrepRequest = { args, cwd };
        const response = await sessionRpcWithPreferredSessionScope<SessionRipgrepResponse, SessionRipgrepRequest>({
            sessionId,
            method: 'ripgrep',
            payload: request,
        });
        return assertRpcResponseWithSuccess<SessionRipgrepResponse>(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
