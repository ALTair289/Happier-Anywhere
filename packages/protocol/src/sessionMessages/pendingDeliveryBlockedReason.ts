import { z } from 'zod';

export const PENDING_DELIVERY_BLOCKED_REASONS = [
  'terminal_composer_draft',
  'provider_acceptance_timeout',
  'provider_unavailable_before_acceptance',
  'ambiguous_terminal_delivery',
  'terminal_host_unreachable',
  'runtime_disposed_before_delivery',
  'invalid_prompt_text',
  'manual_user_handled',
  'attempt_expired_before_write',
  'provider_rejected_before_acceptance',
  'payload_too_large',
  'unknown',
] as const;

export const PendingDeliveryBlockedReasonSchema = z.enum(PENDING_DELIVERY_BLOCKED_REASONS);

export type PendingDeliveryBlockedReason = z.infer<typeof PendingDeliveryBlockedReasonSchema>;

export function isPendingDeliveryBlockedReason(value: unknown): value is PendingDeliveryBlockedReason {
  return PendingDeliveryBlockedReasonSchema.safeParse(value).success;
}

export function normalizePendingDeliveryBlockedReason(value: unknown): PendingDeliveryBlockedReason | null {
  const parsed = PendingDeliveryBlockedReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
