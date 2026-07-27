import type { ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';

export type CodexConnectedServiceAppliedIdentitySource =
  | 'app_server_runtime'
  | 'spawn_selection'
  | 'group_switch_selection'
  | 'applied_credential'
  | 'token_refresh'
  | 'live_account_read';

/**
 * One provider-observed identity fact. Consumers must use the tuple atomically:
 * combining any field with selection metadata or a child environment can
 * attribute quota/auth evidence to a different account generation.
 */
export type CodexConnectedServiceAppliedIdentity = Readonly<{
  serviceId: 'openai-codex';
  profileId: string;
  groupId: string | null;
  groupGeneration: number | null;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  activeAccountId: string | null;
  accountLabel: string | null;
  credentialFingerprint: string | null;
  observedAtMs: number;
  source: CodexConnectedServiceAppliedIdentitySource;
}>;
