import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('sessionControl contract exports', () => {
  it('exports base and per-command envelope schemas', () => {
    expect(typeof (protocol as any).SessionControlEnvelopeBaseSchema).toBe('object');
    expect(typeof (protocol as any).AuthStatusEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionStatusEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionCreateEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionSendEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionWaitEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionStopEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionActionsListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionActionsDescribeEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionActionsExecuteEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStartEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunGetEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunSendEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStopEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunActionEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunWaitEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStreamStartEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStreamReadEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStreamCancelEnvelopeSchema).toBe('object');
  });

  it('validates a session_list envelope shape', () => {
    const schema = (protocol as any).SessionListEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_list',
      data: {
        sessions: [
          {
            id: 'sess_123',
            createdAt: 1,
            updatedAt: 2,
            active: false,
            activeAt: 0,
            encryption: { type: 'dataKey' },
          },
        ],
        hasNext: false,
        nextCursor: null,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('validates primary turn status and sanitized runtime issue fields on session summaries', () => {
    expect(typeof (protocol as any).TurnTerminalStatusV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).PrimaryTurnStatusV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).SessionRuntimeIssueV1Schema?.safeParse).toBe('function');
    expect((protocol as any).TurnTerminalStatusV1Schema.safeParse('failed').success).toBe(true);
    expect((protocol as any).PrimaryTurnStatusV1Schema.safeParse('in_progress').success).toBe(true);

    const runtimeIssue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'auth_error',
      source: 'auth_error',
      occurredAt: 123,
      provider: 'codex',
      providerTurnId: 'turn_1',
      sanitizedPreview: 'Authentication failed',
    };

    const issueParsed = (protocol as any).SessionRuntimeIssueV1Schema.safeParse(runtimeIssue);
    expect(issueParsed.success).toBe(true);

    const malformedIssueParsed = (protocol as any).SessionRuntimeIssueV1Schema.safeParse({
      ...runtimeIssue,
      status: 'completed',
    });
    expect(malformedIssueParsed.success).toBe(false);

    const summaryParsed = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      latestTurnStatus: 'failed',
      lastRuntimeIssue: runtimeIssue,
    });
    expect(summaryParsed.success).toBe(true);
  });

  it('declares minimal runtime activity projection fields on session summaries', () => {
    const summaryShape = (protocol as any).SessionSummarySchema.shape;
    expect(typeof summaryShape.runtimeActivityActiveCount?.safeParse).toBe('function');
    expect(typeof summaryShape.runtimeActivityObservedAt?.safeParse).toBe('function');
    expect(typeof summaryShape.runtimeActivityExpiresAt?.safeParse).toBe('function');
    expect(typeof summaryShape.runtimeActivitySourceClass?.safeParse).toBe('function');

    const summaryParsed = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_runtime_activity',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    expect(summaryParsed.success).toBe(true);
    expect(summaryParsed.data.runtimeActivityActiveCount).toBe(2);
    expect(summaryParsed.data.runtimeActivitySourceClass).toBe('provider_detached_task');
  });

  it('exports and validates session turn schemas', () => {
    expect(typeof (protocol as any).SessionTurnMutationV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).SessionTurnsProjectionV1Schema?.safeParse).toBe('function');

    const mutation = {
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_1',
      action: 'complete',
      turnId: 'turn_1',
      provider: 'codex',
      providerTurnId: 'provider_turn_1',
      observedAt: 123,
    };

    expect((protocol as any).SessionTurnMutationV1Schema.safeParse(mutation).success).toBe(true);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_begin_1',
      action: 'begin',
      turnId: 'turn_2',
      provider: 'codex',
      providerTurnId: 'provider_turn_2',
      observedAt: 124,
      transcriptAnchors: {
        startUserMessageSeq: 42,
        userMessageSeqs: [42],
        startSeqInclusive: 41,
        endSeqInclusive: null,
      },
    }).success).toBe(true);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_touch_1',
      action: 'touch_active',
      turnId: 'turn_2',
      provider: 'codex',
      providerTurnId: 'provider_turn_2',
      observedAt: 125,
    }).success).toBe(true);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...mutation,
      source: 'session_turn_lifecycle',
    }).success).toBe(false);
    expect((protocol as any).SessionTurnsProjectionV1Schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      latestTurnId: 'turn_1',
      updatedAt: 123,
      turns: [{
        turnId: 'turn_1',
        provider: 'codex',
        providerTurnId: 'provider_turn_1',
        status: 'completed',
        startedAt: 100,
        updatedAt: 123,
        terminalAt: 123,
        rollback: {
          state: 'eligible',
          updatedAt: 123,
        },
      }],
    }).success).toBe(true);

    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...mutation,
      providerTurnId: null,
    }).success).toBe(false);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...mutation,
      observedAt: Number.POSITIVE_INFINITY,
    }).success).toBe(false);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...mutation,
      mutationId: '',
    }).success).toBe(false);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...mutation,
      action: 'append_transcript_anchors',
    }).success).toBe(false);
    expect((protocol as any).SessionTurnLedgerMutationV1Schema).toBeUndefined();
  });

  it('enforces session turn indexed id bounds', () => {
    const maxIndexedId = 'x'.repeat(191);
    const oversizedIndexedId = 'x'.repeat(192);
    const baseMutation = {
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_1',
      action: 'attach_provider_turn_id',
      turnId: 'turn_1',
      providerTurnId: 'provider_turn_1',
      observedAt: 123,
    };

    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...baseMutation,
      sessionId: maxIndexedId,
      mutationId: maxIndexedId,
      turnId: maxIndexedId,
      providerTurnId: maxIndexedId,
    }).success).toBe(true);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...baseMutation,
      mutationId: oversizedIndexedId,
    }).success).toBe(false);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...baseMutation,
      turnId: oversizedIndexedId,
    }).success).toBe(false);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...baseMutation,
      sessionId: oversizedIndexedId,
    }).success).toBe(false);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...baseMutation,
      providerTurnId: oversizedIndexedId,
    }).success).toBe(false);
  });

  it('bounds session turn cancel reasons', () => {
    const parsed = (protocol as any).SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_1',
      action: 'cancel',
      turnId: 'turn_1',
      reason: 'x'.repeat(257),
      observedAt: 123,
    });

    expect(parsed.success).toBe(false);
  });

  it('passes through additive transcript anchor fields', () => {
    const parsed = (protocol as any).SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_1',
      action: 'append_transcript_anchors',
      turnId: 'turn_1',
      transcriptAnchors: {
        startUserMessageSeq: 1,
        providerContinuationToken: 'anchor-v2',
      },
      observedAt: 123,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data.transcriptAnchors.providerContinuationToken).toBe('anchor-v2');
  });

  it('bounds runtime issue preview text accepted by session turn payloads', () => {
    const oversizedPreview = 'x'.repeat(2_001);
    const parsed = (protocol as any).SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_1',
      action: 'fail',
      turnId: 'turn_1',
      issue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'provider_error',
        source: 'provider_session_error',
        occurredAt: 123,
        sanitizedPreview: oversizedPreview,
      },
      observedAt: 123,
    });

    expect(parsed.success).toBe(false);

    const legacyParsed = (protocol as any).SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_2',
      source: 'session_turn_lifecycle',
      action: 'fail',
      turnId: 'turn_1',
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'provider_error',
        source: 'provider_session_error',
        occurredAt: 123,
      },
      observedAt: 123,
    });
    expect(legacyParsed.success).toBe(false);

    const legacyRollbackParsed = (protocol as any).SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_3',
      source: 'session_turn_lifecycle',
      action: 'mark_rollback_eligible',
      turnId: 'turn_1',
      rollback: {
        state: 'eligible',
        reason: 'provider checkpoint',
        providerRollbackOrdinal: 1,
      },
      observedAt: 123,
    });
    expect(legacyRollbackParsed.success).toBe(false);
  });

  it('validates structured usage-limit runtime issue details without changing the coarse source', () => {
    const runtimeIssue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'usage_limit_reached',
      source: 'usage_limit',
      occurredAt: 123,
      provider: 'codex',
      usageLimit: {
        v: 1,
        resetAtMs: 456,
        retryAfterMs: 300_000,
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'primary',
        planType: 'pro',
        utilization: 100,
        overage: {
          status: 'rejected',
          resetAtMs: 456,
          disabledReason: null,
        },
        action: {
          kind: 'open_url',
          labelKey: 'provider_usage_settings',
          url: 'https://chatgpt.com/codex/settings/usage',
        },
        connectedService: {
          serviceId: 'openai-codex',
          profileId: 'work',
          groupId: 'codex-main',
          groupExhausted: true,
        },
      },
    };

    const parsed = (protocol as any).SessionRuntimeIssueV1Schema.safeParse(runtimeIssue);
    expect(parsed.success).toBe(true);
    expect(parsed.data.source).toBe('usage_limit');
    expect(parsed.data.usageLimit.connectedService.groupId).toBe('codex-main');

    const malformedParsed = (protocol as any).SessionRuntimeIssueV1Schema.safeParse({
      ...runtimeIssue,
      usageLimit: {
        ...runtimeIssue.usageLimit,
        quotaScope: 'profile',
      },
    });
    expect(malformedParsed.success).toBe(false);
  });

  it('exports and validates the metadata-backed usage-limit recovery intent schema', () => {
    expect((protocol as any).SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID).toBe('runtime.usageLimitRecovery');
    expect((protocol as any).SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY).toBe('sessionUsageLimitRecoveryV1');
    expect(typeof (protocol as any).SessionUsageLimitRecoveryV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).SessionUsageLimitWaitResumeEnableRequestV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).SessionUsageLimitWaitResumeCancelRequestV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).SessionUsageLimitCheckNowRequestV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).SessionUsageLimitOperationResponseV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).SessionUsageLimitRecoveryOperationResultV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).normalizeSessionUsageLimitRecoveryOperationResultV1).toBe('function');

    const intent = {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:s1:123',
      armedAtMs: 100,
      resetAtMs: 1_000,
      nextCheckAtMs: 1_050,
      attemptCount: 1,
      maxAttempts: 5,
      lastProbeError: null,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        profileId: 'work',
      },
    };

    expect((protocol as any).SessionUsageLimitRecoveryV1Schema.safeParse(intent).success).toBe(true);
    expect((protocol as any).SessionUsageLimitRecoveryV1Schema.safeParse({
      ...intent,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        profileId: null,
      },
    }).success).toBe(true);
    expect((protocol as any).SessionMetadataSchema.safeParse({
      sessionUsageLimitRecoveryV1: intent,
    }).success).toBe(true);
    expect((protocol as any).SessionUsageLimitRecoveryV1Schema.safeParse({
      ...intent,
      attemptCount: -1,
    }).success).toBe(false);
    expect((protocol as any).SessionUsageLimitWaitResumeEnableRequestV1Schema.safeParse({
      sessionId: 's1',
      issueFingerprint: 'usage-limit:s1:123',
      remember: true,
    }).success).toBe(true);
    expect((protocol as any).SessionUsageLimitOperationResponseV1Schema.safeParse({
      ok: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    }).success).toBe(true);
    expect((protocol as any).SessionUsageLimitRecoveryOperationResultV1Schema.safeParse({
      ok: true,
      status: 'ready',
      sessionId: 's1',
    }).success).toBe(true);
  });

  it('validates primary turn status and sanitized runtime issue fields on v2 session records', () => {
    const runtimeIssue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'permission_blocked',
      source: 'permission_blocked',
      occurredAt: 456,
      sessionSeq: 7,
      provider: 'claude',
    };

    const parsed = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      meaningfulActivityAt: 3,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      pendingRequestObservedAt: 789,
      latestReadyEventSeq: 8,
      latestReadyEventAt: 987,
      thinking: true,
      thinkingAt: 654,
      latestTurnStatus: 'failed',
      latestTurnStatusObservedAt: 456,
      lastRuntimeIssue: runtimeIssue,
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });

    expect(parsed.success).toBe(true);

    const invalidTurnStatusObservedAtParsed = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      latestTurnStatus: 'failed',
      latestTurnStatusObservedAt: -1,
    });
    expect(invalidTurnStatusObservedAtParsed.success).toBe(false);

    const invalidAttentionProjectionParsed = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      thinking: true,
      thinkingAt: -1,
    });
    expect(invalidAttentionProjectionParsed.success).toBe(false);

    const invalidRuntimeActivityParsed = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: -1,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    expect(invalidRuntimeActivityParsed.success).toBe(false);

    const invalidActivityParsed = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      meaningfulActivityAt: -1,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
    });
    expect(invalidActivityParsed.success).toBe(false);
  });

  it('validates a session_wait envelope shape', () => {
    const schema = (protocol as any).SessionWaitEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_wait',
      data: { sessionId: 'sess_123', idle: true, observedAt: 1 },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a session_run_stream_read envelope shape', () => {
    const schema = (protocol as any).SessionRunStreamReadEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_run_stream_read',
      data: {
        sessionId: 'sess_123',
        runId: 'run_1',
        streamId: 'stream_1',
        events: [{ t: 'delta', textDelta: 'hi' }],
        nextCursor: 1,
        done: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a session_actions_list envelope shape', () => {
    const schema = (protocol as any).SessionActionsListEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_actions_list',
      data: {
        actionSpecs: [
          {
            id: 'review.start',
            title: 'Review',
            description: null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui_button: true,
              ui_slash_command: true,
              voice_tool: true,
              voice_action_block: true,
              session_agent: true,
              mcp: false,
              cli: true,
            },
            inputHints: null,
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a session_actions_execute envelope shape', () => {
    const schema = (protocol as any).SessionActionsExecuteEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_actions_execute',
      data: {
        sessionId: 'sess_123',
        actionId: 'review.start',
        result: { started: true },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates v2 session list and session-by-id wire responses', () => {
    const listSchema = (protocol as any).V2SessionListResponseSchema;
    const listParsed = listSchema.safeParse({
      sessions: [
        {
          id: 'sess_1',
          seq: 10,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 3,
          archivedAt: null,
          encryptionMode: 'plain',
          metadata: 'm',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          lastViewedSessionSeq: 4,
          pendingPermissionRequestCount: 2,
          pendingUserActionRequestCount: 1,
          pendingCount: 0,
          pendingVersion: 1,
          dataEncryptionKey: 'a2V5',
          share: { accessLevel: 'edit', canApprovePermissions: true },
        },
      ],
      nextCursor: null,
      hasNext: false,
    });
    expect(listParsed.success).toBe(true);

    const invalidModeParsed = listSchema.safeParse({
      sessions: [
        {
          id: 'sess_bad',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          archivedAt: null,
          encryptionMode: 'nope',
          metadata: 'm',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          lastViewedSessionSeq: 4,
          pendingPermissionRequestCount: 0,
          pendingUserActionRequestCount: 0,
          dataEncryptionKey: null,
        },
      ],
      nextCursor: null,
      hasNext: false,
    });
    expect(invalidModeParsed.success).toBe(false);

    const byIdSchema = (protocol as any).V2SessionByIdResponseSchema;
    const byIdParsed = byIdSchema.safeParse({
      session: {
        id: 'sess_1',
        seq: 10,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 3,
        metadata: 'm',
        metadataVersion: 1,
        agentState: 'a',
        agentStateVersion: 0,
        pendingCount: 0,
        dataEncryptionKey: null,
        encryptionMode: 'e2ee',
      },
    });
    expect(byIdParsed.success).toBe(true);
  });

  it('validates v2 session message responses', () => {
    const schema = (protocol as any).V2SessionMessageResponseSchema;
    const parsed = schema.safeParse({
      didWrite: true,
      message: {
        id: 'msg_1',
        seq: 12,
        localId: null,
        createdAt: 1700000000000,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('extracts system-session metadata safely', () => {
    const parsed = (protocol as any).readSystemSessionMetadataFromMetadata({
      metadata: {
        systemSessionV1: {
          v: 1,
          key: 'voice_carrier',
          hidden: true,
        },
      },
    });
    expect(parsed).toEqual({
      v: 1,
      key: 'voice_carrier',
      hidden: true,
    });

    expect((protocol as any).isHiddenSystemSession({ metadata: null })).toBe(false);
    expect((protocol as any).isHiddenSystemSession({ metadata: { systemSessionV1: { v: 1, key: 'carrier' } } })).toBe(false);
    expect((protocol as any).isHiddenSystemSession({ metadata: { systemSessionV1: { v: 1, key: 'carrier', hidden: true } } })).toBe(true);
  });

  it('drops legacy connected-service quota refs from parsed session metadata while preserving provider-account usage refs', () => {
    const parsed = (protocol as any).SessionMetadataSchema.safeParse({
      connectedServiceQuotaRefsV1: {
        v: 1,
        refs: [{ v: 1, serviceId: 'openai-codex', profileId: 'work' }],
        updatedAtMs: 123,
      },
      providerAccountUsageRefsV1: {
        v: 1,
        recordIds: ['paug_v1_McZJ2eL8Y7kqW-CJ0J0vNuQ7cQmMMn9M2f2KqGm2jQ0'],
        updatedAtMs: 456,
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data.providerAccountUsageRefsV1).toEqual({
      v: 1,
      recordIds: ['paug_v1_McZJ2eL8Y7kqW-CJ0J0vNuQ7cQmMMn9M2f2KqGm2jQ0'],
      updatedAtMs: 456,
    });
    expect('connectedServiceQuotaRefsV1' in parsed.data).toBe(false);
  });

  it('encodes and decodes v2 session list cursors', () => {
    const encode = (protocol as any).encodeV2SessionListCursorV1;
    const decode = (protocol as any).decodeV2SessionListCursorV1;
    const encodeV2 = (protocol as any).encodeV2SessionListCursorV2;
    const decodeV2 = (protocol as any).decodeV2SessionListCursorV2;

    expect(encode('sess_123')).toBe('cursor_v1_sess_123');
    expect(decode('cursor_v1_sess_123')).toBe('sess_123');
    expect(decode('cursor_v1_')).toBe(null);
    expect(decode('nope')).toBe(null);

    const v2Cursor = encodeV2({ sessionId: 'sess_123', meaningfulActivityAt: 12345 });
    expect(decodeV2(v2Cursor)).toEqual({ sessionId: 'sess_123', meaningfulActivityAt: 12345 });
    expect(decodeV2('cursor_v2_bad-json')).toBe(null);
  });
});
