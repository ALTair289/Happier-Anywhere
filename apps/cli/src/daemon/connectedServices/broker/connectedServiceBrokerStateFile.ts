import { readFile } from 'node:fs/promises';

/**
 * Canonical host-side validation for Remote's minimal atomic broker descriptor.
 *
 * The generated provider children retain their self-contained parser, but every first-party
 * TypeScript readiness/reattachment owner must use this one validator so currentness cannot drift
 * between OpenCode, Pi, and managed-child activation-proof recovery.
 */
export async function isConnectedServiceBrokerStateFileUsable(
  path: string | undefined,
): Promise<boolean> {
  if (typeof path !== 'string' || path.trim().length === 0) return false;
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content === null) return false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.httpPort === 'number'
      && Number.isInteger(parsed.httpPort)
      && parsed.httpPort > 0
      && parsed.httpPort <= 65_535
      && typeof parsed.connectedServiceBrokerRefreshToken === 'string'
      && parsed.connectedServiceBrokerRefreshToken.trim().length > 0;
  } catch {
    return false;
  }
}
