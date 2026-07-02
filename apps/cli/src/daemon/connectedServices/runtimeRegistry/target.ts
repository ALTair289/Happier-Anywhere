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
  connectedServicesBindingsRaw?: unknown;
  connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string> | null;
  materializationKey?: string | null;
  connectedServiceMaterializationIdentityV1?: unknown;
  sessionDirectory?: string | null;
  runtimeAccountIdentitySelections?: ReadonlyArray<RuntimeAccountIdentitySelectionInput> | null;
}>;

export type ConnectedServiceRuntimeTargetUpdate = Readonly<{
  pid: number;
  agentId?: CatalogAgentId | null;
  sessionId?: string | null;
  connectedServicesBindingsRaw?: unknown;
  connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string> | null;
  materializationKey?: string | null;
  connectedServiceMaterializationIdentityV1?: unknown;
  sessionDirectory?: string | null;
  runtimeAccountIdentitySelections?: ReadonlyArray<RuntimeAccountIdentitySelectionInput> | null;
}>;

export type ConnectedServiceRuntimeTarget = Readonly<{
  pid: number;
  agentId: CatalogAgentId | null;
  sessionId: string | null;
  connectedServicesBindingsRaw: ConnectedServicesRuntimeBindingsV1Like;
  connectedServiceSelectionsEnv: Readonly<Record<string, string>>;
  connectedServiceSelections: ReadonlyArray<ConnectedServiceChildSelection>;
  materializationKey: string | null;
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  sessionDirectory: string | null;
  runtimeAccountIdentitySelections: ReadonlyArray<RuntimeAccountIdentitySelectionInput>;
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
