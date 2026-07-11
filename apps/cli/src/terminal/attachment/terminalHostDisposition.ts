import type { TerminalAttachmentId, TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import {
  readTerminalAttachmentInfo,
  removeTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from './terminalAttachmentInfo';

export type TerminalHostDispositionIntent =
  | Readonly<{
      kind: 'preserve_host';
      reason: 'planned_runner_refresh' | 'wrapper_exit' | 'controller_failure' | 'auth_switch_handoff';
      runtimePhase: 'transfer_pending' | 'blocked';
    }>
  | Readonly<{
      kind: 'destroy_owned_host';
      reason: 'explicit_user_stop' | 'positive_dead_recovery';
    }>;

export type TerminalHostDispositionResult =
  | Readonly<{ status: 'preserved'; attachmentId: TerminalAttachmentId }>
  | Readonly<{ status: 'destroyed'; attachmentId: TerminalAttachmentId }>
  | Readonly<{
      status: 'parked';
      reason: 'legacy_attachment' | 'attachment_mismatch' | 'missing_topology_proof' | 'disposition_in_progress' | 'destroy_failed';
    }>;

const activeDestroyClaims = new Set<string>();

export async function executeTerminalHostDisposition(input: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedAttachmentId: TerminalAttachmentId | string;
  intent: TerminalHostDispositionIntent;
  adapter?: TerminalHostAdapter;
  readAttachmentInfo?: (input: Readonly<{ happyHomeDir: string; sessionId: string }>) => Promise<TerminalAttachmentInfo | null>;
  removeAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedAttachmentId: TerminalAttachmentId | string;
    expectedTerminal: TerminalAttachmentInfo['terminal'];
  }>) => Promise<boolean>;
}>): Promise<TerminalHostDispositionResult> {
  const readAttachment = input.readAttachmentInfo ?? readTerminalAttachmentInfo;
  const removeAttachment = input.removeAttachmentInfo ?? removeTerminalAttachmentInfo;
  const attachmentInfo = await readAttachment({
    happyHomeDir: input.happyHomeDir,
    sessionId: input.sessionId,
  });
  if (!attachmentInfo || attachmentInfo.version === 1) {
    return { status: 'parked', reason: 'legacy_attachment' };
  }
  if (attachmentInfo.attachmentId !== input.expectedAttachmentId) {
    return { status: 'parked', reason: 'attachment_mismatch' };
  }
  if (input.intent.kind === 'preserve_host') {
    return { status: 'preserved', attachmentId: attachmentInfo.attachmentId };
  }

  const handle = attachmentInfo.handle;
  if (
    !input.adapter
    || input.adapter.kind !== handle.kind
    || handle.attachmentId !== attachmentInfo.attachmentId
    || (handle.attachMetadata.topology === 'shared' && !handle.paneId?.trim())
  ) {
    return { status: 'parked', reason: 'missing_topology_proof' };
  }

  const claimKey = `${input.happyHomeDir}\u0000${input.sessionId}\u0000${attachmentInfo.attachmentId}`;
  if (activeDestroyClaims.has(claimKey)) {
    return { status: 'parked', reason: 'disposition_in_progress' };
  }
  activeDestroyClaims.add(claimKey);
  try {
    const current = await readAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
    });
    if (current?.version !== 2 || current.attachmentId !== attachmentInfo.attachmentId) {
      return { status: 'parked', reason: 'attachment_mismatch' };
    }
    try {
      await input.adapter.dispose(current.handle);
    } catch {
      return { status: 'parked', reason: 'destroy_failed' };
    }
    await removeAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedAttachmentId: current.attachmentId,
      expectedTerminal: current.terminal,
    });
    return { status: 'destroyed', attachmentId: current.attachmentId };
  } finally {
    activeDestroyClaims.delete(claimKey);
  }
}
