/**
 * Single reason→surfacing policy for connected-service account switches.
 *
 * Read symmetrically by BOTH user-visible surfaces so they can never drift apart:
 *   - the transcript committer (`commitConnectedServiceAccountSwitchSessionEvent`), and
 *   - the notification dispatcher (`dispatchConnectedServiceAccountSwitchNotification`).
 *
 * "Background" == genuinely-internal maintenance that must stay SILENT:
 *   - `same_provider_account_exhausted`: cross-session sibling fanout. A protective switch
 *     propagated to OTHER sessions because one session exhausted a shared account — not a
 *     user-relevant event for the sibling session, so it is never transcribed or notified.
 *
 * NOTE: `soft_threshold` (preemptive soft-swap) is intentionally NOT background. The user
 * wants to SEE preemptive swaps happen; a successful one surfaces exactly like a hard-limit
 * `usage_limit` swap — the transcript switch event plus the preventive activity notification
 * (`buildActivityNotificationContent` soft_threshold copy). This is the one policy owner:
 * flip a reason's membership here to reverse its visibility across both surfaces.
 */
export function isBackgroundConnectedServiceSwitchReason(reason: string | null | undefined): boolean {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  return normalized === 'same_provider_account_exhausted';
}
