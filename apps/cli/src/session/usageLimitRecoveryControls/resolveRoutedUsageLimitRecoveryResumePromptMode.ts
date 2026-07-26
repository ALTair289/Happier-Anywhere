import {
  resolveSessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';

/**
 * Lazily-loaded lower precedence tiers for the routed resume-prompt-mode resolution.
 *
 * Plan tier order (Jun 10 usage-limit recovery unification plan, P1):
 *   1. explicit per-operation `resumePromptMode`
 *   2. existing recovery intent mode
 *   3. group policy
 *   4. account setting default
 *   5. standard default
 *
 * Group policy may require I/O, so it is loaded only when the explicit and
 * persisted-intent tiers are silent. Account settings are already available
 * locally but remain lower precedence than group policy.
 */
export type RoutedUsageLimitRecoveryResumePromptTierSources = Readonly<{
  accountSettings?: unknown;
  loadGroupPolicy?: () => Promise<unknown> | unknown;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  return value === 'standard' || value === 'off' || value === 'custom' ? value : null;
}

async function safeLoad(loader?: () => Promise<unknown> | unknown): Promise<unknown> {
  if (!loader) return null;
  try {
    return await loader() ?? null;
  } catch {
    return null;
  }
}

/**
 * Routed owner for resume-prompt-mode precedence: materializes the lazy group
 * policy only when needed, then delegates the canonical ordering to the
 * protocol resolver so there is exactly one precedence definition.
 */
export async function resolveRoutedUsageLimitRecoveryResumePromptMode(
  input: Readonly<{
    explicit?: unknown;
    existingIntent?: unknown;
  }> & RoutedUsageLimitRecoveryResumePromptTierSources,
): Promise<SessionUsageLimitRecoveryResumePromptModeV1> {
  const higherTierDecided =
    readMode(input.explicit) !== null
    || readMode(readRecord(input.existingIntent)?.resumePromptMode) !== null;
  const groupPolicy = higherTierDecided ? undefined : await safeLoad(input.loadGroupPolicy);

  return resolveSessionUsageLimitRecoveryResumePromptModeV1({
    explicit: input.explicit,
    existingIntent: input.existingIntent,
    groupPolicy,
    accountSettings: input.accountSettings,
  });
}
