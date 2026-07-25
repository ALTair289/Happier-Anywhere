import type { StructuredQuestionAnswersV1 } from '@happier-dev/protocol';

/**
 * Provider-neutral result returned by the canonical permission coordinator.
 *
 * Keep structured user answers and execution-policy amendments on this shared
 * boundary: both are produced by BasePermissionHandler and consumed by ACP
 * adapters without provider-specific recovery casts.
 */
export interface PermissionResult {
  decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
  execPolicyAmendment?: Readonly<{
    command: string[];
  }>;
  answers?: StructuredQuestionAnswersV1;
}
