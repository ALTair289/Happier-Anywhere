export class ClaudeUnifiedResumeIdentityMismatchError extends Error {
  readonly code = 'claude_unified_resume_identity_mismatch';

  constructor(
    readonly requestedProviderSessionId: string,
    readonly observedProviderSessionId: string,
    readonly observedSource: string | null,
  ) {
    super(
      'Claude resumed a different provider session than requested. '
      + 'Prompt delivery was blocked to protect conversation continuity.',
    );
    this.name = 'ClaudeUnifiedResumeIdentityMismatchError';
  }
}
