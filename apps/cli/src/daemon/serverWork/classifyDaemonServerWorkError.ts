import {
  classifyServerEndpointError,
  type ServerEndpointErrorClassification,
} from '@/api/client/classifyServerEndpointError';

import type { DaemonServerWorkErrorClassification } from './types';

export function classifyDaemonServerWorkError(
  error: unknown,
  options: Readonly<{ featureAbsentStatusCodes?: readonly number[] }> = {},
): DaemonServerWorkErrorClassification {
  return classifyServerEndpointError(error, options) as ServerEndpointErrorClassification as DaemonServerWorkErrorClassification;
}
