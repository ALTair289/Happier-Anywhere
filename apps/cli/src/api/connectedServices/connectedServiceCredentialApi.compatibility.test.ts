import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios');
vi.mock('../client/serverHttpBaseUrl', () => ({
  resolveServerHttpBaseUrl: () => 'https://server.example',
}));
vi.mock('../client/serverEndpointFailureLog', () => ({
  logServerEndpointFailure: vi.fn(),
}));

import { getConnectedServiceCredentialSealed } from './connectedServiceCredentialApi';

describe('connected-service credential exact 0.2.1 response boundary', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset();
  });

  it('accepts the released no-revision response only as legacy_unfenced', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'ciphertext' },
        metadata: { kind: 'token' },
      },
    });

    await expect(getConnectedServiceCredentialSealed({
      token: 'token',
      serviceId: 'github',
      profileId: 'work',
    })).resolves.toEqual({
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
      sealed: { format: 'account_scoped_v1', ciphertext: 'ciphertext' },
      metadata: { kind: 'token' },
    });
  });
});
