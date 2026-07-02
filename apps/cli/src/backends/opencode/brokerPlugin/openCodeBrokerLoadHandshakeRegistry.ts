import { z } from 'zod';

import { OPEN_CODE_BROKER_PROVIDERS } from './openCodeBrokerPluginEnv';

/**
 * Daemon-side registry of broker load handshakes (F4).
 *
 * The broker plugin, on activation inside the OpenCode runtime, POSTs a "loaded" handshake to the
 * daemon (via the scoped-token bridge), keyed by the stable connected-service selection identity plus
 * the per-spawn load nonce. The
 * preflight (`verifyOpenCodeBrokerReadyForConnectedSession`) consults this registry — through the
 * daemon control client — to confirm the plugin ACTUALLY loaded before the first connected prompt,
 * rather than only that its file exists on disk.
 *
 * In-memory + daemon-process-local (mirrors the spawn-nonce correlation map): a fresh daemon means the
 * managed server is also re-keyed, and an earlier process cannot satisfy a later spawn because the
 * load nonce changes.
 */

const OpenCodeBrokerProviderSchema = z.enum(
  OPEN_CODE_BROKER_PROVIDERS as readonly [string, ...string[]],
);

export const OpenCodeBrokerLoadHandshakeRequestSchema = z.object({
  selectionIdentity: z.string().min(1),
  loadNonce: z.string().min(1),
  providers: z.array(OpenCodeBrokerProviderSchema).min(1),
  pluginVersion: z.string().min(1).optional(),
});

export type OpenCodeBrokerLoadHandshakeRequest = z.infer<typeof OpenCodeBrokerLoadHandshakeRequestSchema>;
export type OpenCodeBrokerLoadHandshakeKey = Readonly<{
  selectionIdentity: string;
  loadNonce: string;
}>;

/**
 * Freshness horizon for an observed handshake. A handshake older than this is ignored so a stale
 * registration from a long-dead server cannot satisfy a new session's preflight. Generous because the
 * managed server is long-lived; the goal is to reject clearly-stale entries, not to expire live ones.
 */
const HANDSHAKE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

type HandshakeRecord = Readonly<{ observedAtMs: number; providers: readonly string[] }>;

const handshakesByIdentityAndNonce = new Map<string, HandshakeRecord>();

function normalizeHandshakeKey(input: OpenCodeBrokerLoadHandshakeKey): string | null {
  const identity = input.selectionIdentity.trim();
  const nonce = input.loadNonce.trim();
  if (!identity || !nonce) return null;
  return `${identity}\0${nonce}`;
}

export function recordOpenCodeBrokerLoadHandshake(
  request: Readonly<{ selectionIdentity: string; loadNonce: string; providers: readonly string[]; pluginVersion?: string }>,
  nowMs: number = Date.now(),
): void {
  const key = normalizeHandshakeKey(request);
  if (!key) return;
  handshakesByIdentityAndNonce.set(key, {
    observedAtMs: nowMs,
    providers: [...request.providers],
  });
}

export function wasOpenCodeBrokerLoadHandshakeObserved(
  keyInput: OpenCodeBrokerLoadHandshakeKey,
  nowMs: number = Date.now(),
): boolean {
  const key = normalizeHandshakeKey(keyInput);
  if (!key) return false;
  const record = handshakesByIdentityAndNonce.get(key);
  if (!record) return false;
  return nowMs - record.observedAtMs <= HANDSHAKE_FRESHNESS_MS;
}

export function resetOpenCodeBrokerLoadHandshakesForTests(): void {
  handshakesByIdentityAndNonce.clear();
}
