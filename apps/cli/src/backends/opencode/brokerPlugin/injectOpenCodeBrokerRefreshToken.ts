import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '@/backends/opencode/server/openCodeManagedServerEnv';

import {
  OPEN_CODE_BROKER_PROVIDERS,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
} from './openCodeBrokerPluginEnv';
import {
  OPEN_CODE_BROKER_REFRESH_TOKEN_ENV,
  deriveOpenCodeBrokerRefreshToken,
} from './openCodeBrokerCapabilityToken';

/**
 * Inject the SCOPED broker-refresh capability token into the managed `opencode serve` child env for
 * connected brokered sessions ONLY (plan §5 item 3, F2 least privilege).
 *
 * The token is derived (HMAC) from the daemon master control token by Happier's trusted server-launch
 * code; ONLY the derived token is placed in the OpenCode env. The master control token is NEVER
 * injected (so a leaked broker token cannot reach the broad control surface). Native sessions (no
 * selection identity) and direct-API-key connected sessions (no brokered provider) are a strict no-op.
 *
 * Fail-closed: if the control token is unavailable the scoped token is simply not injected; the broker
 * then fails its `readScopedToken()` and the broker-loaded preflight reports it, rather than the broker
 * silently falling back to the master token.
 */
export function applyOpenCodeBrokerRefreshTokenEnv(
  env: NodeJS.ProcessEnv,
  readControlToken: () => string | null | undefined,
): void {
  if (typeof env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] !== 'string') return;
  const selections = parseOpenCodeBrokerSelections(env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  const hasBrokeredProvider = OPEN_CODE_BROKER_PROVIDERS.some((provider) => selections[provider]);
  if (!hasBrokeredProvider) return;

  const scoped = deriveOpenCodeBrokerRefreshToken(readControlToken());
  if (!scoped) return;
  env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV] = scoped;
}
