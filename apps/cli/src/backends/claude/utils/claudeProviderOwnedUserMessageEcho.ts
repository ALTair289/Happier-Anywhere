import type { ProviderOwnedUserMessageEchoClassifier } from '@/api/session/providerOwnedUserMessageEcho';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { Update, UserMessage } from '@/api/types';

import { extractClaudeJsonlMessageKeyFromLocalId } from './claudeJsonlMessageKey';

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const isClaudeProviderOwnedUserMessageEcho: ProviderOwnedUserMessageEchoClassifier = (
  message: UserMessage,
  update: Update,
): boolean => {
  if (update.body?.t !== 'new-message') return false;

  const bodyLocalId = readTrimmedString(update.body.message.localId);
  const messageLocalId = readTrimmedString(message.localId);
  const localId = messageLocalId || bodyLocalId;
  if (!extractClaudeJsonlMessageKeyFromLocalId(localId)) return false;

  return true;
};

export function installClaudeProviderOwnedUserMessageEchoClassifier(
  session: Pick<SessionClientPort, 'setProviderOwnedUserMessageEchoClassifier'>,
): void {
  session.setProviderOwnedUserMessageEchoClassifier?.(isClaudeProviderOwnedUserMessageEcho);
}
