import {
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  OPENAI_CODEX_DEVICE_TOKEN_URL,
  OPENAI_CODEX_DEVICE_USER_CODE_URL,
  OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  OPENAI_CODEX_OAUTH_CLIENT_ID,
} from '@happier-dev/agents';

import {
  exchangeCodexAuthorizationGrant,
  type CodexAuthTokens,
} from './oauthExchange';

export { OPENAI_CODEX_DEVICE_REDIRECT_URI, OPENAI_CODEX_DEVICE_VERIFICATION_URL };

const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

async function exchangeDeviceApprovalForTokens(params: Readonly<{
  fetcher: typeof fetch;
  now: number;
  authorizationCode: string;
  codeVerifier: string;
}>): Promise<CodexAuthTokens> {
  return await exchangeCodexAuthorizationGrant({
    fetcher: params.fetcher,
    now: params.now,
    code: params.authorizationCode,
    verifier: params.codeVerifier,
    redirectUri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
  });
}

export async function authenticateCodexDevice(params: Readonly<{
  fetcher?: typeof fetch;
  now: number;
  sleep?: (ms: number) => Promise<void>;
  onUserCode?: (params: { verificationUrl: string; userCode: string }) => void;
}>): Promise<CodexAuthTokens> {
  const fetcher = params.fetcher ?? fetch;
  const sleep = params.sleep ?? (async (ms) => await new Promise((r) => setTimeout(r, ms)));

  const usercodeRes = await fetcher(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: OPENAI_CODEX_OAUTH_CLIENT_ID }),
  });
  if (!usercodeRes.ok) {
    throw new Error(`Failed to initiate device authorization: ${usercodeRes.status}`);
  }
  const usercodeJson = (await usercodeRes.json()) as any;
  const deviceAuthId = assertNonEmptyString(usercodeJson?.device_auth_id, 'device_auth_id');
  const userCode = assertNonEmptyString(usercodeJson?.user_code, 'user_code');
  const intervalSeconds = Math.max(Number.parseInt(String(usercodeJson?.interval ?? '5'), 10) || 5, 1);
  const intervalMs = intervalSeconds * 1000;

  params.onUserCode?.({ verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL, userCode });

  while (true) {
    const pollRes = await fetcher(OPENAI_CODEX_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });

    if (pollRes.ok) {
      const pollJson = (await pollRes.json()) as any;
      const authorizationCode = assertNonEmptyString(pollJson?.authorization_code, 'authorization_code');
      const codeVerifier = assertNonEmptyString(pollJson?.code_verifier, 'code_verifier');
      return await exchangeDeviceApprovalForTokens({
        fetcher,
        now: params.now,
        authorizationCode,
        codeVerifier,
      });
    }

    if (pollRes.status !== 403 && pollRes.status !== 404) {
      throw new Error(`Device authorization failed: ${pollRes.status}`);
    }

    await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS);
  }
}
