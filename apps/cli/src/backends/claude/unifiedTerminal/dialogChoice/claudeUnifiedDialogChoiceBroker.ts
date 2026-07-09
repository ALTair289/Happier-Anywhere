import { randomUUID } from 'node:crypto';

import { AgentStateRequestStore, type AgentStateOutstandingRequest } from '@/agent/permissions/agentStateRequestStore';
import {
  createPermissionRequestCoordinator,
  type PermissionRequestCoordinator,
  type PermissionRequestCoordinatorContext,
  type PermissionRequestCoordinatorStore,
} from '@/agent/permissions/permissionRequestCoordinator';
import {
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
  isClaudeUnifiedTerminalDialogChoiceAgentStateRequest,
} from '@happier-dev/agents';

import type { Session } from '../../session';
import type { PermissionRpcPayload } from '../../utils/permissionRpc';
import type { PermissionRpcConsumerOutcome } from '../../utils/permissionRpcRouter';
import type {
  ClaudeUnifiedDialogId,
  ClaudeUnifiedVisibleDialog,
} from '../tuiControls/dialogRegistry';

export const CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION = 'How should Claude continue?' as const;

const REQUEST_TOOL_NAME = 'AskUserQuestion';
const REQUEST_ID_PREFIX = 'claude_dialog_choice_';

export type ClaudeUnifiedDialogChoiceDecision = Readonly<{
  dialogId: ClaudeUnifiedDialogId;
  choice: string;
}>;

type PendingChoice = Readonly<{
  requestId: string;
  dialogId: ClaudeUnifiedDialogId;
  promise: Promise<ClaudeUnifiedDialogChoiceDecision>;
}>;

type DialogChoiceRequestParams = Readonly<{
  dialog: ClaudeUnifiedVisibleDialog;
  signal?: AbortSignal | undefined;
}>;

type RequestOption = Readonly<{ choice: string; label: string; description: string }>;

function requestOptions(dialog: ClaudeUnifiedVisibleDialog): readonly RequestOption[] {
  if (dialog.kind === 'recognized') {
    return dialog.options.map(({ choice, label, description }) => ({ choice, label, description }));
  }
  return [{
    choice: 'open_terminal',
    label: 'Open terminal',
    description: 'Claude is showing a dialog that Happier cannot answer safely. Open the terminal to continue.',
  }];
}

function createDialogChoiceToolInput(dialog: ClaudeUnifiedVisibleDialog): unknown {
  const options = requestOptions(dialog);
  return {
    happierDialog: dialog.kind === 'recognized'
      ? { kind: dialog.kind, dialogId: dialog.dialogId }
      : { kind: dialog.kind, dialogId: dialog.dialogId, notice: dialog.notice },
    questions: [
      {
        header: dialog.kind === 'recognized' ? dialog.header : 'Claude dialog',
        question: dialog.kind === 'recognized'
          ? dialog.question
          : 'Claude is showing a dialog. Open the terminal to continue.',
        answerKey: CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION,
        multiSelect: false,
        options: options.map(({ choice, label, description }) => ({ choice, label, description })),
      },
    ],
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readDialogId(toolInput: unknown): ClaudeUnifiedDialogId | null {
  const input = readObject(toolInput);
  const metadata = readObject(input?.happierDialog);
  const dialogId = metadata?.dialogId;
  return dialogId === 'switch_model'
    || dialogId === 'usage_limit'
    || dialogId === 'resume_choice'
    || dialogId === 'safeguard_pause'
    || dialogId === 'effort_change'
    || dialogId === 'unrecognized_confirmation'
    ? dialogId
    : null;
}

function readOptionsFromToolInput(toolInput: unknown): readonly RequestOption[] {
  const input = readObject(toolInput);
  const question = Array.isArray(input?.questions) ? readObject(input.questions[0]) : null;
  const rawOptions = Array.isArray(question?.options) ? question.options : [];
  return rawOptions.flatMap((rawOption, index) => {
    const option = readObject(rawOption);
    if (typeof option?.label !== 'string') return [];
    return [{
      choice: typeof option.choice === 'string' ? option.choice : String(index + 1),
      label: option.label,
      description: typeof option.description === 'string' ? option.description : '',
    }];
  });
}

function decodeDialogChoice(
  payload: PermissionRpcPayload,
  dialogId: ClaudeUnifiedDialogId,
  options: readonly RequestOption[],
): ClaudeUnifiedDialogChoiceDecision | null {
  if (payload.approved !== true) return null;
  const answers = readObject(payload.answers);
  if (!answers) return null;
  const raw = answers[CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]
    ?? Object.values(answers).find((value) => typeof value === 'string');
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim();
  const selected = options.find((option) => option.choice === normalized || option.label === normalized);
  if (!selected) return null;
  return { dialogId, choice: selected.choice };
}

function isDialogChoiceContext(
  context: PermissionRequestCoordinatorContext | null,
): context is PermissionRequestCoordinatorContext {
  return context?.source === CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE;
}

export class ClaudeUnifiedDialogChoiceBroker {
  private readonly session: Session;
  private readonly requestStore: AgentStateRequestStore;
  private readonly permissionCoordinator: PermissionRequestCoordinator<ClaudeUnifiedDialogChoiceDecision>;
  private readonly createRequestId: () => string;
  private readonly nowMs: () => number;
  private pendingChoice: PendingChoice | null = null;
  private pendingOptions: readonly RequestOption[] = [];
  private activated = false;
  private disposed = false;

  constructor(session: Session, opts?: Readonly<{
    createRequestId?: (() => string) | undefined;
    nowMs?: (() => number) | undefined;
  }>) {
    this.session = session;
    this.createRequestId = opts?.createRequestId ?? (() => `${REQUEST_ID_PREFIX}${randomUUID()}`);
    this.nowMs = opts?.nowMs ?? Date.now;
    this.requestStore = new AgentStateRequestStore({
      session: session.client,
      logPrefix: '[claude-unified-dialog-choice]',
      pushSender: session.pushSender,
      getAccountSettings: () => session.accountSettings ?? null,
      getAccountSettingsSecretsReadKeys: () => session.accountSettingsSecretsReadKeys,
    });
    this.permissionCoordinator = createPermissionRequestCoordinator<ClaudeUnifiedDialogChoiceDecision>({
      store: this.createCoordinatorStore(),
    });
  }

  activate(): void {
    if (this.activated) return;
    this.activated = true;
    this.session.getOrCreatePermissionRpcRouter().registerConsumer({
      name: 'claude-unified-dialog-choice',
      tryHandlePermissionRpc: (payload) => this.tryHandlePermissionRpc(payload),
    });
  }

  hasPendingChoice(dialogId?: ClaudeUnifiedDialogId): boolean {
    return this.pendingChoice !== null
      && (dialogId === undefined || this.pendingChoice.dialogId === dialogId);
  }

  requestDialogChoice(params: DialogChoiceRequestParams): Promise<ClaudeUnifiedDialogChoiceDecision> {
    if (this.disposed) {
      return Promise.reject(new Error('claude_unified_dialog_choice_broker_disposed'));
    }
    if (this.pendingChoice?.dialogId === params.dialog.dialogId) return this.pendingChoice.promise;
    if (this.pendingChoice) {
      this.completeSourceOwnedCancellation(this.pendingChoice.requestId, 'claude_unified_dialog_changed');
    }

    const requestId = this.createRequestId();
    const toolInput = createDialogChoiceToolInput(params.dialog);
    this.pendingOptions = requestOptions(params.dialog);
    const promise = this.permissionCoordinator.requestDecision({
      requestId,
      toolName: REQUEST_TOOL_NAME,
      toolInput,
      createdAt: this.nowMs(),
      kind: 'user_action',
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
    }, {
      signal: params.signal,
    }).finally(() => {
      if (this.pendingChoice?.requestId === requestId) {
        this.pendingChoice = null;
        this.pendingOptions = [];
      }
    });

    this.pendingChoice = { requestId, dialogId: params.dialog.dialogId, promise };
    return promise;
  }

  cancelPendingChoice(reason: string): void {
    const requestId = this.pendingChoice?.requestId;
    if (!requestId) return;
    this.completeSourceOwnedCancellation(requestId, reason);
  }

  noteDialogResolvedInTerminal(reason: string): void {
    this.cancelPendingChoice(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAllSourceOwnedRequests('claude_unified_dialog_choice_broker_disposed');
    this.permissionCoordinator.dispose();
  }

  private createCoordinatorStore(): PermissionRequestCoordinatorStore {
    return {
      publishRequest: (params) => this.requestStore.publishRequest({
        ...params,
        updateState: (state) => ({
          ...state,
          capabilities: {
            ...(state.capabilities && typeof state.capabilities === 'object' ? state.capabilities : {}),
            askUserQuestionAnswersInPermission: true,
          },
        }),
      }),
      completeRequest: (params) => this.requestStore.completeRequest(params),
      cancelAllRequests: (params) => this.cancelAllSourceOwnedRequests(params.reason),
      hasOutstandingRequest: (requestId) => this.readSourceOwnedOutstandingRequest(requestId) !== null,
      readOutstandingRequest: (requestId) => this.readSourceOwnedOutstandingRequest(requestId),
    };
  }

  private readSourceOwnedOutstandingRequest(requestId: string): AgentStateOutstandingRequest | null {
    const outstanding = this.requestStore.readOutstandingRequest(requestId);
    if (!outstanding) return null;
    const rawRequest = this.session.client.getAgentStateSnapshot?.()?.requests?.[requestId] ?? null;
    return isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(rawRequest) ? outstanding : null;
  }

  private tryHandlePermissionRpc(payload: PermissionRpcPayload): PermissionRpcConsumerOutcome {
    const requestId = typeof payload?.id === 'string' ? payload.id : '';
    if (!requestId) return false;
    const context = this.permissionCoordinator.getResponseContext(requestId);
    if (!isDialogChoiceContext(context)) return false;

    if (payload.approved !== true) {
      const reason = typeof payload.reason === 'string' && payload.reason.length > 0
        ? payload.reason
        : 'claude_unified_dialog_choice_denied';
      this.completeSourceOwnedCancellation(requestId, reason);
      return true;
    }

    const dialogId = this.pendingChoice?.requestId === requestId
      ? this.pendingChoice.dialogId
      : readDialogId(context.toolInput);
    const options = this.pendingChoice?.requestId === requestId && this.pendingOptions.length > 0
      ? this.pendingOptions
      : readOptionsFromToolInput(context.toolInput);
    const decision = dialogId ? decodeDialogChoice(payload, dialogId, options) : null;
    if (!decision) throw new Error('invalid_claude_unified_dialog_choice_answer');

    return this.permissionCoordinator.completeResponse({
      context,
      completion: {
        result: decision,
        completedRequest: {
          status: 'approved',
          decision: 'allow',
          extraCompletedFields: {
            answers: payload.answers ?? {},
            dialogId: decision.dialogId,
            dialogChoice: decision.choice,
            ...(decision.dialogId === 'safeguard_pause' ? { safeguardChoice: decision.choice } : {}),
          },
        },
      },
    });
  }

  private completeSourceOwnedCancellation(requestId: string, reason: string): void {
    const outstanding = this.readSourceOwnedOutstandingRequest(requestId);
    this.permissionCoordinator.cancelRequest(requestId, reason);
    this.requestStore.completeRequest({
      requestId,
      status: 'canceled',
      decision: 'abort',
      reason,
      fallback: outstanding
        ? {
          toolName: outstanding.toolName,
          toolInput: outstanding.toolInput,
          createdAt: outstanding.createdAt,
          kind: outstanding.kind,
          source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
        }
        : null,
    });
    if (this.pendingChoice?.requestId === requestId) {
      this.pendingChoice = null;
      this.pendingOptions = [];
    }
  }

  private cancelAllSourceOwnedRequests(reason: string): void {
    const requests = this.session.client.getAgentStateSnapshot?.()?.requests ?? {};
    for (const [requestId, request] of Object.entries(requests)) {
      if (!isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(request)) continue;
      this.completeSourceOwnedCancellation(requestId, reason);
    }
  }
}
