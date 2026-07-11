import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { withCodexAppServerControlClient } from '@/backends/codex/appServer/control/withCodexAppServerControlClient';
import { readCodexAppServerSessionControls } from '@/backends/codex/appServer/sessionControlsMetadata';
import { readCodexEnvironmentAuthState } from '@/backends/codex/cli/auth/readCodexEnvironmentAuthState';
import { resolveConnectedServiceGroupHomeDir, resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { configuration } from '@/configuration';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

function resolveCodexConnectedServicesHome(params: Readonly<{
    connectedServices?: ConnectedServiceBindingsV1 | null;
}>): string | null {
    const binding = params.connectedServices?.bindingsByServiceId['openai-codex'] ?? null;
    if (!binding || binding.source !== 'connected') return null;

    const homeDir = binding.selection === 'group'
        ? resolveConnectedServiceGroupHomeDir({
            activeServerDir: configuration.activeServerDir,
            serviceId: 'openai-codex',
            groupId: binding.groupId,
            agentId: 'codex',
        })
        : resolveConnectedServiceHomeDir({
            activeServerDir: configuration.activeServerDir,
            serviceId: 'openai-codex',
            profileId: binding.profileId,
            agentId: 'codex',
        });
    const codexHome = join(homeDir, 'codex-home');
    const exists = existsSync(codexHome);
    if (!exists) {
        // The selected account's home is not materialized yet; the probe intentionally
        // falls back to ambient auth, but that must be observable — a silent fallback
        // makes "model list ignores the selected account" undiagnosable.
        logger.debug('[codexPreflightProbe] connected-services codex home missing; probing with ambient auth', {
            selection: binding.selection,
            codexHome,
        });
    }
    return exists ? codexHome : null;
}

async function readControls(params: Readonly<{
    cwd: string;
    timeoutMs: number;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
}>): Promise<Awaited<ReturnType<typeof readCodexAppServerSessionControls>> | null> {
    const connectedServicesCodexHome = resolveCodexConnectedServicesHome({
        connectedServices: params.connectedServices ?? null,
    });
    const processEnv = {
        ...process.env,
        ...(connectedServicesCodexHome
            ? {
                CODEX_HOME: connectedServicesCodexHome,
                CODEX_SQLITE_HOME: connectedServicesCodexHome,
            }
            : {}),
        // Ensure slow `model/list` does not silently downgrade the UI to static models (which have no model options).
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: String(Math.max(250, Math.min(60_000, Math.trunc(params.timeoutMs)))),
    };
    const authMethod = readCodexEnvironmentAuthState(processEnv).method;
    const result = await withCodexAppServerControlClient({
        processEnv,
        cwd: params.cwd,
        accountSettings: params.accountSettings ?? null,
        timeoutMs: params.timeoutMs,
        run: async (client) =>
            readCodexAppServerSessionControls({
                client,
                authMethod,
            }),
    });
    return result.ok ? result.value : null;
}

export const codexPreflightSessionControlsProbeAdapter: PreflightSessionControlsProbeAdapter = {
    failureCacheStrategy: 'retry',
    probeModelsRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            accountSettings: params.accountSettings ?? null,
            connectedServices: params.connectedServices ?? null,
        });
        return controls ? controls.availableModels : null;
    },
    probeModesRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            accountSettings: params.accountSettings ?? null,
            connectedServices: params.connectedServices ?? null,
        });
        return controls ? controls.availableModes : null;
    },
    probeConfigOptionsRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            accountSettings: params.accountSettings ?? null,
            connectedServices: params.connectedServices ?? null,
        });
        return controls ? controls.configOptions : null;
    },
};
