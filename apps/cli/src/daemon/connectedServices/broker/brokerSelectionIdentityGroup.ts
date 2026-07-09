import type { ConnectedServiceResolvedSelection } from '../materialize/materializeConnectedServicesForSpawn';

/**
 * Group-identity suffix folded into the broker selection-identity MINT (OpenCode / Pi) so two DISTINCT
 * pools that currently share one active profile mint DISTINCT selection identities (R4-4).
 *
 * Why this is required: the daemon indexes live runtime targets and the broker effective-selection
 * cache by the minted selection-identity STRING. If the string omits the pool identity, two different
 * pools resolving to the same active profile collapse to one key — the runtime registry returns the
 * lowest-pid target (cross-pool clobber) and the effective-selection cache serves the wrong pool's
 * binding. The broker plugin re-presents exactly this baked env string at bridge time, so the ONLY
 * place a per-pool distinction can be introduced is the mint. Two pools never share a `groupId`, so it
 * disambiguates them.
 *
 * The pool `generation` is deliberately NOT folded in (F3): the identity is only ever compared for
 * equality (runtime-registry target keying via getByBrokerSelectionIdentity, and the broker
 * effective-selection cache key) — no consumer parses it out, and generation reaches every reader as a
 * separate numeric payload field. A generation-only bump (membership/config change that leaves the
 * active profile unchanged) keeps the same active profile+account in the base identity, so baking
 * generation in would mint a NEW identity for a live target whose broker binding never changed —
 * churning the registry into a spurious re-registration. When a switch DOES change the active profile,
 * the base identity already changes (profile + account), so generation adds nothing there either.
 *
 * Profile-only (non-group) and legacy/absent selections return an empty suffix so their identities are
 * byte-for-byte unchanged.
 */
export function brokerSelectionIdentityGroupSuffix(
  selection: ConnectedServiceResolvedSelection | undefined,
): string {
  if (!selection || selection.kind !== 'group') return '';
  return `:group:${selection.groupId}`;
}
