import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { buildConnectedServiceAccountRowActions, CONNECTED_SERVICE_RECONNECT_ICON } from '../account/buildConnectedServiceAccountRowActions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { sync } from '@/sync/sync';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useConnectedServiceQuotaSnapshot } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot';
import { deleteConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import {
  connectedServiceProfileKey,
  pruneConnectedServiceProfilePreferencesForDeletedProfile,
  resolveConnectedServiceProfileLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveConnectedServiceCredentialHealthStatus } from '@/sync/domains/connectedServices/resolveConnectedServiceCredentialHealthStatus';
import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceIdSchema,
  isConnectedServiceCredentialHealthStatusUsable,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { AccountBlock } from '../account/AccountBlock';
import {
  isConnectedServiceCredentialReferencedByGroupError,
  refreshConnectedServiceProfileAfterSupersededMutation,
  resolveConnectedServiceSettingsErrorMessage,
} from '../errors/connectedServiceSettingsErrors';
import { resolveConnectedServiceDisplayName } from '../model/resolveConnectedServiceDisplayName';
import {
  formatConnectedServiceProfileGroupReferenceLabels,
  resolveConnectedServiceProfileGroupReferenceLabels,
} from '../model/resolveConnectedServiceProfileGroupReferences';
import { resolveConnectedServiceProfileIdentityDisplay } from '../model/resolveConnectedServiceIdentityDisplay';
import { promptConnectedServiceTokenValue } from '../promptConnectedServiceTokenValue';
import { storeConnectedServiceCredentialWithIdentityConfirmation } from '../storeConnectedServiceCredentialWithIdentityConfirmation';
import { runConnectedServiceCredentialStoredEffects } from '../runConnectedServiceCredentialStoredEffects';
import { Icon } from '@/components/ui/icons/Icon';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

function statusSubtitle(status: ConnectedServiceCredentialHealthStatusV1): string {
  if (status === 'connected') return t('connectedServices.detail.profiles.connected');
  if (status === 'refreshing') return t('connectedServices.detail.profiles.refreshing');
  if (status === 'refresh_failed_retryable') return t('connectedServices.detail.profiles.refreshFailedRetryable');
  return t('connectedServices.detail.profiles.needsReauth');
}

function formatLastRefreshed(fetchedAtMs: number | null | undefined): string | null {
  if (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs)) return null;
  try {
    return new Date(fetchedAtMs).toLocaleString();
  } catch {
    return String(fetchedAtMs);
  }
}

/**
 * "Connection" + "Last refreshed" rows. Reads the SHARED
 * quota snapshot hook (deduped by the shared store, so this does not double-fetch
 * the snapshot the {@link AccountBlock} above already mounts) to surface the
 * last-refreshed timestamp. Only rendered for connected accounts where a quota
 * snapshot is meaningful.
 */
const ConnectionSection = React.memo(function ConnectionSection(props: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  providerEmail?: string | null;
  connectedVia: string;
  testID: string;
}>) {
  const { snapshot } = useConnectedServiceQuotaSnapshot({
    serviceId: props.serviceId,
    profileId: props.profileId,
  });
  const lastRefreshed = formatLastRefreshed(snapshot?.fetchedAt ?? null);

  return (
    <ItemGroup title={t('connectedServices.profile.connectionGroupTitle')}>
      <Item
        title={t('connectedServices.profile.profileId')}
        subtitle={props.profileId}
        showChevron={false}
      />
      {props.providerEmail ? (
        <Item
          title={t('connectedServices.profile.email')}
          subtitle={props.providerEmail}
          showChevron={false}
        />
      ) : null}
      <Item
        title={t('connectedServices.profile.connectedVia')}
        subtitle={props.connectedVia}
        showChevron={false}
      />
      {lastRefreshed ? (
        <Item
          title={t('connectedServices.profile.lastRefreshed')}
          subtitle={lastRefreshed}
          showChevron={false}
        />
      ) : null}
    </ItemGroup>
  );
});

export const ConnectedServiceProfileDetailView = React.memo(function ConnectedServiceProfileDetailView() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const profile = useProfile();
  const settings = useSettings();
  const applySettings = useApplySettings();

  const connectedServicesEnabled = useFeatureEnabled('connectedServices');
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');

  const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const profileId = asStringParam((params as Record<string, unknown>).profileId).trim();

  if (!connectedServicesEnabled) {
    return (
      <ItemList>
        <ItemGroup title={t('settings.connectedAccounts')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>{t('settings.connectedAccountsDisabled')}</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  if (!serviceId || !profileId) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.oauthPaste.invalidConfig')}</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  const serviceLabel = resolveConnectedServiceDisplayName(serviceId, t);
  const entry = getConnectedServiceRegistryEntry(serviceId);
  const svc = profile.connectedServicesV2.find((s) => s.serviceId === serviceId) ?? null;
  const profileRecord = (svc?.profiles ?? []).find((p) => p.profileId === profileId) ?? null;

  if (!svc || !profileRecord) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.detail.alerts.unknownProfileTitle')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>
              {t('connectedServices.detail.alerts.unknownProfileBody', { profileId, service: serviceLabel })}
            </Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  // Fail-closed normalization drives actions/labels only; AccountBlock receives the
  // RAW status so its fail-open usage gate stays live (UI-1).
  const rawStatus: unknown = profileRecord.status;
  const status = resolveConnectedServiceCredentialHealthStatus(rawStatus);
  const kind = profileRecord.kind === 'token' ? 'token' : profileRecord.kind === 'oauth' ? 'oauth' : null;
  const providerEmail = typeof profileRecord.providerEmail === 'string' ? profileRecord.providerEmail : '';
  const providerAccountId = typeof profileRecord.providerAccountId === 'string' ? profileRecord.providerAccountId : '';

  const label = resolveConnectedServiceProfileLabel({
    labelsByKey: settings.connectedServicesProfileLabelByKey,
    serviceId,
    profileId,
  });
  const identityDisplay = resolveConnectedServiceProfileIdentityDisplay({
    profileId,
    label,
    providerEmail,
  });
  const title = identityDisplay.primaryLabel;
  const profileConfirmationLabel = identityDisplay.diagnosticLabel;

  const isDefault = (settings.connectedServicesDefaultProfileByServiceId[serviceId] ?? '') === profileId;
  const isUsable = isConnectedServiceCredentialHealthStatusUsable(status);

  const poolLabels = accountGroupsEnabled
    ? resolveConnectedServiceProfileGroupReferenceLabels({ profileId, projectedGroups: svc.groups })
    : [];

  const ensureCredentials = () => {
    if (!auth.credentials) {
      throw new Error('Not authenticated');
    }
    return auth.credentials;
  };

  const handleDisconnect = async () => {
    const groupReferenceLabels = accountGroupsEnabled
      ? resolveConnectedServiceProfileGroupReferenceLabels({
        profileId,
        projectedGroups: svc.groups,
      })
      : [];
    const cleanupGroupReferences = groupReferenceLabels.length > 0;
    const ok = await Modal.confirm(
      t('modals.disconnect'),
      cleanupGroupReferences
        ? t('connectedServices.detail.disconnectGroupCleanupConfirmBody', {
          service: serviceLabel,
          profileId: profileConfirmationLabel,
          groups: formatConnectedServiceProfileGroupReferenceLabels(groupReferenceLabels),
        })
        : t('connectedServices.detail.disconnectConfirmBody', { service: serviceLabel, profileId: profileConfirmationLabel }),
      { confirmText: t('modals.disconnect'), cancelText: t('common.cancel') },
    );
    if (!ok) return;
    const disconnect = async (cleanup: boolean) => {
      const credentials = ensureCredentials();
      const expectedCredentialRevision = profile.connectedServiceCredentialRevisionsV1.find((candidate) => (
        candidate.serviceId === serviceId && candidate.profileId === profileId
      ))?.credentialRevision;
      await deleteConnectedServiceCredentialForAccount(credentials, {
        serviceId,
        profileId,
        expectedCredentialRevision,
        ...(cleanup ? { cleanupGroupReferences: true } : {}),
      });
      applySettings(pruneConnectedServiceProfilePreferencesForDeletedProfile({
        serviceId,
        profileId,
        connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
        connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
      }));
      await sync.refreshProfile();
      router.back();
    };
    try {
      await disconnect(cleanupGroupReferences);
    } catch (error: unknown) {
      if (!cleanupGroupReferences && isConnectedServiceCredentialReferencedByGroupError(error)) {
        const retry = await Modal.confirm(
          t('connectedServices.detail.errors.disconnectGroupCleanupRetryTitle'),
          t('connectedServices.detail.errors.disconnectGroupCleanupRetryBody', { service: serviceLabel, profileId: profileConfirmationLabel }),
          {
            confirmText: t('connectedServices.detail.errors.disconnectGroupCleanupRetryConfirm'),
            cancelText: t('common.cancel'),
          },
        );
        if (retry) {
          try {
            await disconnect(true);
            return;
          } catch (retryError: unknown) {
            await refreshConnectedServiceProfileAfterSupersededMutation(retryError, () => sync.refreshProfile());
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(retryError));
            return;
          }
        }
        return;
      }
      await refreshConnectedServiceProfileAfterSupersededMutation(error, () => sync.refreshProfile());
      await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(error));
    }
  };

  const handleSetDefault = () => {
    const nextMap = { ...settings.connectedServicesDefaultProfileByServiceId };
    if (isDefault) delete nextMap[serviceId];
    else nextMap[serviceId] = profileId;
    applySettings({ connectedServicesDefaultProfileByServiceId: nextMap });
  };

  const handleReplaceToken = async () => {
    if (kind !== 'token') return;
    const tokenValue = await promptConnectedServiceTokenValue(entry?.tokenKind ?? null);
    if (!tokenValue) return;
    const credentials = ensureCredentials();
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId,
      profileId,
      kind: 'token',
      token: {
        token: tokenValue,
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const stored = await storeConnectedServiceCredentialWithIdentityConfirmation(credentials, {
      serviceId,
      profileId,
      record,
    }, { onStored: runConnectedServiceCredentialStoredEffects });
    if (!stored) return;
    await Modal.alert(
      t('connectedServices.oauthPaste.alerts.connectedTitle'),
      t('connectedServices.oauthPaste.alerts.connectedBody', { serviceId: serviceLabel, profileId }),
    );
  };

  const handleEditLabel = async () => {
    const key = connectedServiceProfileKey({ serviceId, profileId });
    const currentLabelRaw =
      resolveConnectedServiceProfileLabel({
        labelsByKey: settings.connectedServicesProfileLabelByKey,
        serviceId,
        profileId,
      }) ?? settings.connectedServicesProfileLabelByKey[key];
    const currentLabel = typeof currentLabelRaw === 'string' ? currentLabelRaw : '';
    const next = await Modal.prompt(
      t('connectedServices.detail.prompts.profileLabelTitle'),
      t('connectedServices.detail.prompts.profileLabelBody'),
      {
        placeholder: t('connectedServices.detail.prompts.profileLabelPlaceholder'),
        defaultValue: currentLabel,
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      },
    );
    if (typeof next !== 'string') return;
    const trimmed = next.trim();

    const nextMap = { ...settings.connectedServicesProfileLabelByKey };
    if (trimmed) nextMap[key] = trimmed;
    else delete nextMap[key];

    applySettings({ connectedServicesProfileLabelByKey: nextMap });
  };

  const handleReconnect = () => {
    router.push({ pathname: '/settings/connected-services/oauth', params: { serviceId, profileId } });
  };

  const handleAddToPool = () => {
    // Route straight to the provider's Pools segment (not the default Accounts tab)
    // and carry the profile through so the pools surface lands where the account can
    // actually be added, instead of dropping the user on a generic provider page.
    router.push({
      pathname: '/settings/connected-services/[serviceId]',
      params: { serviceId, segment: 'pools', profileId },
    });
  };

  // Header kebab actions reuse the canonical mutation flows (replace token,
  // reconnect). Usable retryable profiles stay in the account block; only
  // reconnect-required profiles fall through to the re-auth section below.
  const headerActions = buildConnectedServiceAccountRowActions({
    kind,
    status,
    onReplaceToken: () => void handleReplaceToken(),
    onReconnect: handleReconnect,
  });

  return (
    <ItemList>
      {isUsable ? (
        <ItemGroup>
          <AccountBlock
            testID="connected-service-profile-account"
            serviceId={serviceId}
            profileId={profileId}
            title={title}
            identityLabel={identityDisplay.secondaryLabel}
            status={rawStatus}
            isDefault={isDefault}
            onToggleDefault={handleSetDefault}
            poolLabels={poolLabels}
            actions={headerActions}
          />
        </ItemGroup>
      ) : (
        <ItemGroup title={`${serviceLabel} • ${title}`}>
          <Item
            title={t('connectedServices.profile.status')}
            subtitle={status === 'needs_reauth' ? undefined : statusSubtitle(status)}
            rightElement={
              <StatusPill
                testID="connected-service-profile:status-pill"
                variant={status === 'needs_reauth' ? 'danger' : 'warning'}
                label={statusSubtitle(status)}
              />
            }
            showChevron={false}
          />
          {providerEmail ? (
            <Item
              title={t('connectedServices.profile.email')}
              subtitle={providerEmail}
              showChevron={false}
            />
          ) : null}
          <Item
            title={t('connectedServices.profile.profileId')}
            subtitle={profileId}
            showChevron={false}
          />
          {providerAccountId ? (
            <Item
              title={t('connectedServices.profile.accountId')}
              subtitle={providerAccountId}
              showChevron={false}
            />
          ) : null}
        </ItemGroup>
      )}

      {accountGroupsEnabled ? (
        <ItemGroup title={t('connectedServices.profile.poolsGroupTitle')}>
          {poolLabels.length > 0 ? (
            poolLabels.map((poolLabel, index) => (
              <Item
                key={`${poolLabel}:${index}`}
                testID={`connected-service-profile-pool:${index}`}
                title={poolLabel}
                icon={<Icon name="stack-simple" size={20} color={theme.colors.text.secondary} />}
                showChevron={false}
              />
            ))
          ) : (
            <EmptyState
              testID="connected-service-profile-pools:empty"
              titleTestID="connected-service-profile-pools:empty:title"
              icon={<Icon name="stack-simple" size={29} color={theme.colors.text.secondary} />}
              title={t('connectedServices.profile.pools.emptyTitle')}
              subtitle={t('connectedServices.profile.pools.emptySubtitle')}
            />
          )}
          <Item
            testID="connected-service-profile-action:add-to-pool"
            title={t('connectedServices.profile.addToPool')}
            subtitle={t('connectedServices.profile.addToPoolSubtitle')}
            icon={<Icon name="plus-circle" size={20} color={theme.colors.accent.blue} />}
            onPress={handleAddToPool}
          />
        </ItemGroup>
      ) : null}

      <ItemGroup title={t('connectedServices.profile.settingsGroupTitle')}>
        <Item
          testID="connected-service-profile-action:set-default"
          title={t('connectedServices.profile.setDefaultRowTitle')}
          subtitle={isDefault
            ? t('connectedServices.profile.defaultSubtitle')
            : t('connectedServices.profile.setDefaultSubtitle')}
          rightElement={
            <Switch
              testID="connected-service-profile:default-switch"
              value={isDefault}
              onValueChange={handleSetDefault}
              accessibilityLabel={t(isDefault
                ? 'connectedServices.detail.actions.unsetDefault'
                : 'connectedServices.detail.actions.setDefault')}
            />
          }
          showChevron={false}
        />
        <Item
          testID="connected-service-profile-action:edit-label"
          title={t('connectedServices.detail.actions.editLabel')}
          subtitle={t('connectedServices.detail.setProfileLabelSubtitle')}
          icon={<Icon name="pencil" size={20} color={theme.colors.accent.blue} />}
          onPress={() => void handleEditLabel()}
        />
      </ItemGroup>

      {isUsable ? (
        <ConnectionSection
          serviceId={serviceId}
          profileId={profileId}
          providerEmail={providerEmail}
          connectedVia={kind === 'token'
            ? t('connectedServices.profile.connectedViaToken')
            : t('connectedServices.profile.connectedViaOauth')}
          testID="connected-service-profile"
        />
      ) : kind === 'oauth' && status === 'needs_reauth' ? (
        <ItemGroup title={t('connectedServices.profile.connectionGroupTitle')}>
          <Item
            testID="connected-services-profile-action:reconnect"
            title={t('connectedServices.detail.actions.reconnect')}
            subtitle={t('connectedServices.profile.reconnectSubtitle')}
            icon={<Icon name={CONNECTED_SERVICE_RECONNECT_ICON} size={20} color={theme.colors.accent.blue} />}
            onPress={handleReconnect}
          />
        </ItemGroup>
      ) : null}

      <ItemGroup title={t('connectedServices.profile.removeGroupTitle')}>
        <Item
          testID="connected-service-profile-action:disconnect"
          title={t('modals.disconnect')}
          subtitle={t('connectedServices.profile.disconnectSubtitle')}
          icon={<Icon name="trash" size={20} color={theme.colors.state.danger.foreground} />}
          onPress={() => void handleDisconnect()}
        />
      </ItemGroup>
    </ItemList>
  );
});
