import React from 'react';

import { t } from '@/text';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { createConnectedServicesAuthActionChip } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProfile } from '@/sync/store/hooks';
import type { ConnectedServiceId } from '@happier-dev/agents';
import {
  ConnectedServicesDefaultAuthByAgentIdV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServicesDefaultAuthByAgentIdV1,
} from '@happier-dev/protocol';

import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import {
  resolveConnectedServicesAuthLabel,
  resolveConnectedServicesAuthWarningTranslationKey,
} from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import {
  CONNECTED_SERVICES_BINDINGS_KEY,
  type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import {
  buildConnectedServiceProfileOptionsByServiceId,
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
  resolveAgentSupportedConnectedServiceIds,
  type NewSessionConnectedServicesAgentCore,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import type { ConnectedServicesAuthWarningCode } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';

export type NewSessionConnectedServicesResult = Readonly<{
  connectedServicesBindingsPayload: ConnectedServiceBindingsV1 | null;
  connectedServicesAuthChip: AgentInputExtraActionChip | null;
}>;

const EMPTY_DEFAULT_AUTH_SETTINGS: ConnectedServicesDefaultAuthByAgentIdV1 = {
  v: 1,
  bindingsByAgentId: {},
};

function resolveDefaultAuthWarningLabel(warningCode: ConnectedServicesAuthWarningCode | undefined): string | undefined {
  const key = resolveConnectedServicesAuthWarningTranslationKey(warningCode);
  return key ? t(key) : undefined;
}

function parseConnectedServicesDefaultAuthSettings(value: unknown): ConnectedServicesDefaultAuthByAgentIdV1 {
  try {
    return ConnectedServicesDefaultAuthByAgentIdV1Schema.parse(value ?? EMPTY_DEFAULT_AUTH_SETTINGS);
  } catch {
    return EMPTY_DEFAULT_AUTH_SETTINGS;
  }
}

function buildConnectedServiceProfileSettingsPath(params: Readonly<{
  kind: 'oauth' | 'token';
  serviceId: string;
  profileId: string;
}>): string {
  const searchParams = new URLSearchParams({
    serviceId: params.serviceId,
    profileId: params.profileId,
  });
  const route = params.kind === 'token'
    ? '/settings/connected-services/profile'
    : '/settings/connected-services/oauth';
  return `${route}?${searchParams.toString()}`;
}

export function useNewSessionConnectedServices(params: Readonly<{
  agentCore: NewSessionConnectedServicesAgentCore;
  agentOptionState: Record<string, unknown> | null;
  settings: {
    connectedServicesProfileLabelByKey: Record<string, string | undefined>;
    connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
    connectedServicesDefaultAuthByAgentIdV1?: unknown;
  };
  targetServerId: string | null;
  router: {
    push: (path: string | {
      pathname: string;
      params?: Record<string, string>;
    }) => void;
  };
  setAgentOptionStateForCurrentAgent: (key: string, value: unknown) => void;
}>): NewSessionConnectedServicesResult {
  const { agentCore, agentOptionState, settings, targetServerId, router, setAgentOptionStateForCurrentAgent } = params;
  const accountProfile = useProfile();
  const connectedServicesFeatureEnabled = useFeatureEnabled('connectedServices', {
    scopeKind: 'spawn',
    serverId: targetServerId,
  });
  const accountGroupsFeatureEnabled = useFeatureEnabled('connectedServices.accountGroups', {
    scopeKind: 'spawn',
    serverId: targetServerId,
  });
  const accountGroupSwitchingEnabled = Boolean(agentCore.connectedServices?.sessionAuthSwitch);

  const supportedConnectedServiceIds = React.useMemo<ReadonlyArray<ConnectedServiceId>>(() => {
    return resolveAgentSupportedConnectedServiceIds({
      connectedServicesFeatureEnabled,
      agentCore,
    });
  }, [agentCore, connectedServicesFeatureEnabled]);

  const connectedServiceProfileOptionsByServiceId = React.useMemo(() => {
    return buildConnectedServiceProfileOptionsByServiceId({
      accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
      agentCore,
      supportedConnectedServiceIds,
      labelsByKey: settings.connectedServicesProfileLabelByKey,
    });
  }, [accountProfile, agentCore, settings.connectedServicesProfileLabelByKey, supportedConnectedServiceIds]);

  const explicitConnectedServicesBindingsByServiceId = React.useMemo(() => {
    return parseConnectedServicesBindingsByServiceIdFromAgentOptionState({ agentOptionState });
  }, [agentOptionState]);
  const hasExplicitConnectedServicesBindings = React.useMemo(() => {
    return Boolean(
      agentOptionState
      && Object.prototype.hasOwnProperty.call(agentOptionState, CONNECTED_SERVICES_BINDINGS_KEY),
    );
  }, [agentOptionState]);
  const connectedServicesDefaultAuthSettings = React.useMemo(() => {
    return parseConnectedServicesDefaultAuthSettings(settings.connectedServicesDefaultAuthByAgentIdV1);
  }, [settings.connectedServicesDefaultAuthByAgentIdV1]);
  const connectedServicesBindingsByServiceId = React.useMemo(() => {
    if (hasExplicitConnectedServicesBindings) return explicitConnectedServicesBindingsByServiceId;
    const agentId = typeof agentCore?.id === 'string' ? agentCore.id.trim() : '';
    if (!agentId) return explicitConnectedServicesBindingsByServiceId;
    return connectedServicesDefaultAuthSettings.bindingsByAgentId[agentId]?.bindingsByServiceId
      ?? explicitConnectedServicesBindingsByServiceId;
  }, [
    agentCore,
    connectedServicesDefaultAuthSettings,
    explicitConnectedServicesBindingsByServiceId,
    hasExplicitConnectedServicesBindings,
  ]);
  const [optimisticBindingsByServiceId, setOptimisticBindingsByServiceId] = React.useState(connectedServicesBindingsByServiceId);

  React.useEffect(() => {
    setOptimisticBindingsByServiceId(connectedServicesBindingsByServiceId);
  }, [connectedServicesBindingsByServiceId]);

  const connectedServiceAccountGroupOptionsByServiceId = React.useMemo(() => {
    return buildConnectedServiceAccountGroupOptionsByServiceId({
      accountGroupsFeatureEnabled,
      accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
      supportedConnectedServiceIds,
    });
  }, [accountGroupsFeatureEnabled, accountProfile, supportedConnectedServiceIds]);

  const connectedServicesBindingsPayload = React.useMemo(() => {
    return buildConnectedServicesBindingsPayload({
      supportedConnectedServiceIds,
      connectedServiceProfileOptionsByServiceId,
      accountGroupsFeatureEnabled,
      accountGroupSwitchingEnabled,
      connectedServiceAccountGroupOptionsByServiceId,
      connectedServicesBindingsByServiceId: optimisticBindingsByServiceId,
      defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    });
  }, [
    accountGroupSwitchingEnabled,
    accountGroupsFeatureEnabled,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServiceProfileOptionsByServiceId,
    optimisticBindingsByServiceId,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
  ]);

  const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
    setOptimisticBindingsByServiceId((prev) => {
      const next = {
        ...prev,
        [serviceId]: binding,
      };
      setAgentOptionStateForCurrentAgent(CONNECTED_SERVICES_BINDINGS_KEY, next);
      return next;
    });
  }, [setAgentOptionStateForCurrentAgent]);

  const authLabel = React.useMemo(() => resolveConnectedServicesAuthLabel({
    supportedServiceIds: supportedConnectedServiceIds,
    bindingsByServiceId: optimisticBindingsByServiceId,
    profileOptionsByServiceId: connectedServiceProfileOptionsByServiceId,
    accountGroupOptionsByServiceId: connectedServiceAccountGroupOptionsByServiceId,
    accountGroupsEnabled: accountGroupsFeatureEnabled,
    defaultProfileIdByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    resolveServiceTitle: (serviceId) => resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t),
    nativeLabel: t('connectedServices.authChip.nativeLabel'),
    formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
  }), [
    accountGroupsFeatureEnabled,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServiceProfileOptionsByServiceId,
    optimisticBindingsByServiceId,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
  ]);

  const connectedServicesAuthPopoverContent = React.useCallback(({ requestClose, maxHeight }: AgentInputContentPopoverRenderArgs) => (
    <NewSessionConnectedServicesSelectionContent
      supportedServiceIds={supportedConnectedServiceIds}
      profileOptionsByServiceId={connectedServiceProfileOptionsByServiceId}
      accountGroupOptionsByServiceId={connectedServiceAccountGroupOptionsByServiceId}
      bindingsByServiceId={optimisticBindingsByServiceId}
      setBindingForService={setBindingForService}
      defaultProfileIdByServiceId={settings.connectedServicesDefaultProfileByServiceId}
      resolveOptionAvailability={({ serviceId, optionId }) => {
        const binding = optimisticBindingsByServiceId[serviceId];
        if (
          binding?.source === 'connected'
          && binding.selection === 'group'
          && optionId === `connected-service:${encodeURIComponent(serviceId)}:group:${encodeURIComponent(binding.groupId)}`
          && !accountGroupSwitchingEnabled
        ) {
          return {
            disabled: true,
            subtitle: t('connectedServices.authModal.groupUnsupportedSubtitle'),
          };
        }
        const state = authLabel.serviceStatesById[serviceId];
        if (
          state?.warningCode
          && optionId === `connected-service:${encodeURIComponent(serviceId)}:native`
        ) {
          return {
            subtitle: resolveDefaultAuthWarningLabel(state.warningCode),
          };
        }
        return {};
      }}
      onOpenSettings={(serviceId) => {
        router.push({
          pathname: '/settings/connected-services/[serviceId]',
          params: { serviceId },
        });
      }}
      onReconnectProfile={(serviceId, profileId) => {
        const profile = connectedServiceProfileOptionsByServiceId[serviceId]?.find((option) => option.profileId === profileId);
        router.push(buildConnectedServiceProfileSettingsPath({
          kind: profile?.kind === 'token' ? 'token' : 'oauth',
          serviceId,
          profileId,
        }));
      }}
      requestClose={requestClose}
      maxHeight={maxHeight}
    />
  ), [
    authLabel,
    accountGroupSwitchingEnabled,
    connectedServiceProfileOptionsByServiceId,
    connectedServiceAccountGroupOptionsByServiceId,
    optimisticBindingsByServiceId,
    router,
    setBindingForService,
    settings.connectedServicesDefaultProfileByServiceId,
    supportedConnectedServiceIds,
  ]);

  const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (supportedConnectedServiceIds.length === 0) return null;
        return createConnectedServicesAuthActionChip({
            label: authLabel.label,
            authSource: authLabel.connectedCount > 0 ? 'connected' : 'native',
            connectedCount: authLabel.connectedCount,
            popoverContent: connectedServicesAuthPopoverContent,
            maxHeightCap: 560,
            maxWidthCap: 560,
        });
    }, [
      authLabel,
      connectedServicesAuthPopoverContent,
      supportedConnectedServiceIds,
    ]);

  return { connectedServicesBindingsPayload, connectedServicesAuthChip };
}
