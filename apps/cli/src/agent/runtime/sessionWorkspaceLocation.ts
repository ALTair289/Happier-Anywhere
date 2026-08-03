import { buildSessionWorkspaceLocationV1, type SessionWorkspaceLocationV1 } from '@happier-dev/protocol';

export const SESSION_MACHINE_WORKSPACE_PATH_ENV = 'HAPPIER_SESSION_MACHINE_WORKSPACE_PATH' as const;

export function buildSessionWorkspaceLocationFromEnvironment(params: Readonly<{
    machineId: string;
    agentPath: string;
    env?: NodeJS.ProcessEnv;
}>): SessionWorkspaceLocationV1 {
    const env = params.env ?? process.env;
    const rawMachinePath = env[SESSION_MACHINE_WORKSPACE_PATH_ENV];
    delete env[SESSION_MACHINE_WORKSPACE_PATH_ENV];
    const machinePath = typeof rawMachinePath === 'string' && rawMachinePath.trim().length > 0
        ? rawMachinePath
        : params.agentPath;

    return buildSessionWorkspaceLocationV1({
        machineId: params.machineId,
        agentPath: params.agentPath,
        machinePath,
    });
}
