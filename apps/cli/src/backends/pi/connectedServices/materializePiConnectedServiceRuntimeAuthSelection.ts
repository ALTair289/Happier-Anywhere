import { PI_BROKER_SELECTION_IDENTITY_ENV } from '@/backends/pi/brokerExtension';
import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';

export const materializePiConnectedServiceRuntimeAuthSelection: ConnectedServiceRuntimeAuthSelectionMaterializer = async (
  params,
) => ({
  ...params.baseSelection,
  ...(typeof params.input.tracked.spawnOptions?.environmentVariables?.[PI_BROKER_SELECTION_IDENTITY_ENV] === 'string'
    ? {
        brokerSelectionIdentity: params.input.tracked.spawnOptions.environmentVariables[PI_BROKER_SELECTION_IDENTITY_ENV],
      }
    : {}),
});
