import { AGENTS_CORE } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import { createPiConnectedServiceRuntimeAuthAdapter } from '@/backends/pi/connectedServices/createPiConnectedServiceRuntimeAuthAdapter';
import { createPiConnectedServicesMaterializer } from '@/backends/pi/connectedServices/createPiConnectedServicesMaterializer';
import { piConnectedServiceStateSharingDescriptor } from '@/backends/pi/connectedServices/piConnectedServiceStateSharingDescriptor';
import { piUsageLimitRecoveryControlAdapter } from '@/backends/pi/connectedServices/piUsageLimitRecoveryControlAdapter';
import { resolvePiConnectedServiceCandidatePersistedSessionFile } from '@/backends/pi/connectedServices/resolvePiConnectedServiceCandidatePersistedSessionFile';
import { resolvePiConnectedServiceSwitchContinuity } from '@/backends/pi/connectedServices/resolvePiConnectedServiceSwitchContinuity';
import type { AgentCatalogEntry } from '../types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';

const piConnectedServiceCredentialLifecycleDescriptor: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'pi',
  serviceIds: AGENTS_CORE.pi.connectedServices.supportedServiceIds,
  spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  refreshedCredentialApplication: {
    mode: 'restart_required',
    noRestartRequiredServiceIds: ['openai-codex', 'claude-subscription'],
  },
  predictiveSoftSwitch: { mode: 'unsupported' },
  sameAccountFanoutStrategy: 'none',
  runtimeAuthApply: { directLiveHotAuth: 'unsupported' },
};

export const agent = {
  id: AGENTS_CORE.pi.id,
  cliSubcommand: AGENTS_CORE.pi.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/pi/cli/command')).handlePiCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/pi/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/pi/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/pi/cli/auth/piCliAuthSpec')).piCliAuthSpec,
  getConnectedServiceMaterializer: async () => createPiConnectedServicesMaterializer(),
  getConnectedServiceStateSharingDescriptor: async () => piConnectedServiceStateSharingDescriptor,
  getConnectedServiceRuntimeAuthAdapter: async () => createPiConnectedServiceRuntimeAuthAdapter(),
  getConnectedServiceCredentialLifecycleDescriptor: async () => piConnectedServiceCredentialLifecycleDescriptor,
  resolveConnectedServiceSwitchContinuity: async (params) => await resolvePiConnectedServiceSwitchContinuity(params),
  resolveConnectedServiceCandidatePersistedSessionFile: resolvePiConnectedServiceCandidatePersistedSessionFile,
  verifyResumeReachable: async (input) =>
    await (await import('@/backends/pi/connectedServices/verifyResumeReachablePi')).verifyResumeReachablePi(input),
  getSessionUsageLimitRecoveryControlAdapter: async () => piUsageLimitRecoveryControlAdapter,
  vendorResumeSupport: AGENTS_CORE.pi.resume.vendorResume,
  getPreflightSessionControlsProbeAdapter: async () =>
    (await import('@/backends/pi/preflight/piPreflightModelsProbeAdapter')).piPreflightModelsProbeAdapter,
  getAcpBackendFactory: async () => {
    const { createPiBackend } = await import('@/backends/pi/acp/backend');
    return (opts) => ({ backend: createPiBackend(opts as any) });
  },
  checklists,
} satisfies AgentCatalogEntry;
