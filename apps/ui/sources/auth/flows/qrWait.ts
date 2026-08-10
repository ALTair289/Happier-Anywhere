import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { QRAuthKeyPair } from './qrStart';
import { decryptBox } from '@/encryption/libsodium';
import { serverFetch } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import { delay } from '@/utils/timing/time';
import { pairingClaimFetch, type PairingClaimEndpointPath } from '@/sync/api/account/pairingClaimTransport';
import { normalizePairingClaimOriginV1 } from '@happier-dev/protocol';

export interface AuthCredentials {
    secret: Uint8Array;
    token: string;
}

export type AuthQRWaitOptions = Readonly<{
    serverUrl?: string;
}>;

export async function authQRWait(
    keypair: QRAuthKeyPair,
    onProgress?: (dots: number) => void,
    shouldCancel?: () => boolean,
    options: AuthQRWaitOptions = {},
): Promise<AuthCredentials | null> {
    let dots = 0;
    const explicitServerUrl = options.serverUrl === undefined
        ? null
        : normalizePairingClaimOriginV1(options.serverUrl);
    if (options.serverUrl !== undefined && !explicitServerUrl) return null;
    const fetchAuthRequest = (
        path: Extract<PairingClaimEndpointPath, '/v1/auth/account/request' | '/v2/auth/account/request'>,
        init: RequestInit,
    ) => explicitServerUrl
        ? pairingClaimFetch(explicitServerUrl, path, init)
        : serverFetch(path, init, { includeAuth: false });

    type Requested = { state: 'requested' };
    type AuthorizedV1 = { state: 'authorized'; token: string; response: string; serverIdentityId?: string | null };
    type AuthorizedV2 = { state: 'authorized'; tokenEncrypted: string; response: string; serverIdentityId?: string | null };
    type AuthPollResponse = Requested | AuthorizedV1 | AuthorizedV2;

    while (true) {
        if (shouldCancel && shouldCancel()) {
            return null;
        }

        if (!isRuntimeActive()) {
            await delay(1000);
            continue;
        }

        try {
            let response = await fetchAuthRequest('/v2/auth/account/request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    publicKey: encodeBase64(keypair.publicKey),
                }),
            });
            if (response.status === 404) {
                response = await fetchAuthRequest('/v1/auth/account/request', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        publicKey: encodeBase64(keypair.publicKey),
                    }),
                });
            }
            if (!response.ok) {
                throw new Error(`Failed to poll auth request: ${response.status}`);
            }
            const data = await response.json() as AuthPollResponse;
            if (shouldCancel?.()) return null;

            if (data.state === 'authorized') {
                const token =
                    'tokenEncrypted' in data
                        ? (() => {
                            const tokenEncrypted = decodeBase64(data.tokenEncrypted);
                            const decryptedTokenBytes = decryptBox(tokenEncrypted, keypair.secretKey);
                            if (!decryptedTokenBytes) {
                                return null;
                            }
                            return new TextDecoder().decode(decryptedTokenBytes);
                        })()
                        : data.token;
                if (!token) {
                    return null;
                }

                if (data.serverIdentityId) {
                    const identityServerUrl = explicitServerUrl ?? getActiveServerSnapshot().serverUrl;
                    setServerProfileIdentityForUrl(identityServerUrl, data.serverIdentityId);
                }

                const encryptedResponse = decodeBase64(data.response);
                
                const decrypted = decryptBox(encryptedResponse, keypair.secretKey);
                if (decrypted) {
                    return {
                        secret: decrypted,
                        token: token
                    };
                }
                return null;
            }
        } catch (error) {
            return null;
        }

        // Call progress callback if provided
        if (onProgress) {
            onProgress(dots);
        }
        dots++;

        // Wait 1 second before next check
        await delay(1000);
    }
}
