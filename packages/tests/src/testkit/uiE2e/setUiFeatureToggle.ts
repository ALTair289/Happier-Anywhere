import type { Page } from '@playwright/test';

import type { UiE2eAccountSettingsScope } from './accountSettingsScopeKeySuffix';
import { gotoDomContentLoadedWithRetries } from './pageNavigation';
import { mutateUiE2eScopedAccountSettings } from './scopedAccountSettingsStorage';

export async function setUiFeatureToggle(params: Readonly<{
  page: Page;
  baseUrl: string;
  featureId: string;
  enabled: boolean;
  settingsScope?: UiE2eAccountSettingsScope;
}>): Promise<void> {
  await mutateUiE2eScopedAccountSettings({
    page: params.page,
    settingsScope: params.settingsScope,
    experiments: true,
    featureToggles: {
      [params.featureId]: params.enabled,
    },
  });

  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/`);
}
