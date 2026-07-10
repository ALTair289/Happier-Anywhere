import axios from 'axios';
import { AccountProfileResponseSchema, type AccountProfileResponse } from '@happier-dev/protocol';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  isAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

export async function fetchAccountProfile(opts: Readonly<{ token: string }>): Promise<AccountProfileResponse> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.get(`${serverUrl}/v1/account/profile`, {
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(
      response.status,
      `Authentication failed while fetching account profile (${response.status})`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw createHttpStatusError(response.status, `Failed to fetch account profile (${response.status})`);
  }

  return AccountProfileResponseSchema.parse(response.data);
}
