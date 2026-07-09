import type {
  ConnectedServiceId,
  ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type {
  RuntimeAccountIdentitySelectionInput,
} from '../quotas/identity/runtimeAccountIdentityTypes';
import type {
  ConnectedServiceChildSelection,
} from '../connectedServiceChildEnvironment';

export type ConnectedServiceRuntimeAccessTokenRefreshCapability =
  Readonly<{ mode: 'daemon_callback' }>;

export type ConnectedServiceRuntimeBoundProfile = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

export type ConnectedServiceRuntimeBindingIdentity = ConnectedServiceRuntimeBoundProfile & Readonly<{
  groupId: string | null;
  generation: number | null;
}>;

export type ConnectedServicesRuntimeBindingsV1Like = Readonly<{
  v?: unknown;
  bindingsByServiceId?: Record<string, unknown>;
}>;

export type ConnectedServiceRuntimeTargetInput = Readonly<{
  pid: number;
  agentId?: CatalogAgentId | null;
  sessionId?: string | null;
  /**
   * Stable broker selection identity for provider brokers whose managed server is SHARED across
   * sessions (OpenCode/Pi). Unlike `sessionId`, it survives the shared-server lifetime and is the
   * genuine identity a broker plugin presents to the daemon bridge (R3-6). Absent for per-session
   * providers (e.g. the Claude SDK, which authenticates by session id).
   */
  brokerSelectionIdentity?: string | null;
  connectedServicesBindingsRaw?: unknown;
  connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string> | null;
  materializationKey?: string | null;
  connectedServiceMaterializationIdentityV1?: unknown;
  sessionDirectory?: string | null;
  runtimeAccountIdentitySelections?: ReadonlyArray<RuntimeAccountIdentitySelectionInput> | null;
  accessTokenRefresh?: ConnectedServiceRuntimeAccessTokenRefreshCapability | null;
}>;

export type ConnectedServiceRuntimeTargetUpdate = Readonly<{
  pid: number;
  agentId?: CatalogAgentId | null;
  sessionId?: string | null;
  brokerSelectionIdentity?: string | null;
  connectedServicesBindingsRaw?: unknown;
  connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string> | null;
  materializationKey?: string | null;
  connectedServiceMaterializationIdentityV1?: unknown;
  sessionDirectory?: string | null;
  runtimeAccountIdentitySelections?: ReadonlyArray<RuntimeAccountIdentitySelectionInput> | null;
  accessTokenRefresh?: ConnectedServiceRuntimeAccessTokenRefreshCapability | null;
}>;

export type ConnectedServiceRuntimeTarget = Readonly<{
  pid: number;
  agentId: CatalogAgentId | null;
  sessionId: string | null;
  brokerSelectionIdentity: string | null;
  connectedServicesBindingsRaw: ConnectedServicesRuntimeBindingsV1Like;
  connectedServiceSelectionsEnv: Readonly<Record<string, string>>;
  connectedServiceSelections: ReadonlyArray<ConnectedServiceChildSelection>;
  materializationKey: string | null;
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  sessionDirectory: string | null;
  runtimeAccountIdentitySelections: ReadonlyArray<RuntimeAccountIdentitySelectionInput>;
  accessTokenRefresh: ConnectedServiceRuntimeAccessTokenRefreshCapability | null;
  boundProfiles: ReadonlyArray<ConnectedServiceRuntimeBoundProfile>;
  activeBindings: ReadonlyArray<ConnectedServiceRuntimeBindingIdentity>;
  runtimeIdentityKey: string;
  revision: number;
}>;

export type ConnectedServiceRuntimeRefreshTarget = ConnectedServiceRuntimeTarget & Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  bindings: ReadonlyArray<ConnectedServiceRuntimeBoundProfile>;
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceChildSelection>;
}>;

export type ConnectedServiceRuntimeQuotaTarget = ConnectedServiceRuntimeTarget & Readonly<{
  bindings: ConnectedServicesRuntimeBindingsV1Like;
  connectedServiceSelectionsEnv?: Readonly<Record<string, string>>;
  runtimeAccountIdentitySelections?: ReadonlyArray<RuntimeAccountIdentitySelectionInput>;
}>;
