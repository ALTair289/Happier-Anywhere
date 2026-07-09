import { describe, expect, it, vi } from 'vitest';

import { createPermissionHandlerSessionStub } from '../../utils/permissionHandler.testkit';
import { createFakeControlPort } from '../tuiControls/fakeControlPort';
import { parseClaudeScreenState } from '../tuiControls/screenState';
import {
  CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION,
  ClaudeUnifiedDialogChoiceBroker,
} from './claudeUnifiedDialogChoiceBroker';
import { createClaudeUnifiedDialogChoiceScreenProbe } from './claudeUnifiedDialogChoiceScreenProbe';

const EFFORT_DIALOG = [
  'Change effort level?',
  'Switching to high means the full history gets re-read before Claude can continue.',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const SAFEGUARD_DIALOG = [
  'Session paused',
  'Fable 5\'s safeguards flagged this message.',
  '❯ 1. Switch to Opus 4.8',
  '  2. Edit prompt and retry with Fable 5',
].join('\n');

const UNKNOWN_DIALOG = [
  'Reset conversation cache?',
  '❯ 1. Yes, reset it',
  '  2. No, go back',
].join('\n');

const IDLE = ['──────────────────────────────', '❯ ', '──────────────────────────────'].join('\n');

function createHarness(params: Readonly<{
  captures: readonly string[];
  ownsDialog?: (dialogId: string) => boolean;
}>) {
  const { session, client } = createPermissionHandlerSessionStub('dialog-choice-session');
  const broker = new ClaudeUnifiedDialogChoiceBroker(session, {
    createRequestId: () => 'claude_dialog_choice_1',
    nowMs: () => 123,
  });
  broker.activate();
  const port = createFakeControlPort({ captures: params.captures });
  const probe = createClaudeUnifiedDialogChoiceScreenProbe({
    broker,
    port,
    wait: async () => undefined,
    graceMs: 25,
    settleMs: 1,
    isDialogOwned: params.ownsDialog ?? (() => false),
  });
  return { broker, client, port, probe };
}

describe('createClaudeUnifiedDialogChoiceScreenProbe', () => {
  it('leaves a Happier-initiated effort dialog to its slash-controls owner', async () => {
    const { client, port, probe } = createHarness({
      captures: [EFFORT_DIALOG],
      ownsDialog: (dialogId) => dialogId === 'effort_change',
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'owned', dialogId: 'effort_change' });
    expect(client.getAgentStateSnapshot().requests).toEqual({});
    expect(port.sentLiteral).toEqual([]);
  });

  it('surfaces a TUI-initiated effort dialog after grace and injects the selected answer', async () => {
    const { client, port, probe } = createHarness({
      captures: [EFFORT_DIALOG, EFFORT_DIALOG, EFFORT_DIALOG, IDLE],
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'request_published', dialogId: 'effort_change' });
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_1).toMatchObject({
      tool: 'AskUserQuestion',
      kind: 'user_action',
      arguments: expect.objectContaining({
        happierDialog: { kind: 'recognized', dialogId: 'effort_change' },
      }),
    });

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_dialog_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]: 'confirm' },
    });

    await vi.waitFor(() => expect(port.sentLiteral).toEqual(['1']));
    expect(port.sentKeys).toEqual(['Enter']);
    expect(client.getAgentStateSnapshot().completedRequests.claude_dialog_choice_1).toMatchObject({
      status: 'approved',
      dialogId: 'effort_change',
      dialogChoice: 'confirm',
    });
  });

  it('keeps the safeguard chooser on the generalized broker path', async () => {
    const { client, port, probe } = createHarness({
      captures: [SAFEGUARD_DIALOG, SAFEGUARD_DIALOG, SAFEGUARD_DIALOG, IDLE],
    });

    await expect(probe.probe()).resolves.toEqual({ kind: 'request_published', dialogId: 'safeguard_pause' });
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_dialog_choice_1',
      approved: true,
      answers: { [CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]: 'Edit prompt and retry with Fable 5' },
    });

    await vi.waitFor(() => expect(port.sentLiteral).toEqual(['2']));
  });

  it('surfaces an unrecognized confirmation as a typed generic terminal notice without injecting bytes', async () => {
    const { client, port, probe } = createHarness({ captures: [UNKNOWN_DIALOG, UNKNOWN_DIALOG] });

    await expect(probe.probe()).resolves.toEqual({
      kind: 'request_published',
      dialogId: 'unrecognized_confirmation',
    });
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_1).toMatchObject({
      arguments: expect.objectContaining({
        happierDialog: {
          kind: 'unrecognized',
          dialogId: 'unrecognized_confirmation',
          notice: 'open_terminal',
        },
      }),
    });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('never leaves a visible parsed dialog after grace with neither an owner nor a published surface', async () => {
    for (const screen of [EFFORT_DIALOG, SAFEGUARD_DIALOG, UNKNOWN_DIALOG]) {
      const { broker, client, probe } = createHarness({ captures: [screen, screen] });
      const result = await probe.probe();
      expect(result.kind === 'owned' || broker.hasPendingChoice()).toBe(true);
      expect(Object.keys(client.getAgentStateSnapshot().requests)).toHaveLength(1);
      probe.dispose();
      broker.dispose();
    }
  });

  it('replaces a pending surface when the visible dialog changes', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-choice-session');
    let requestSequence = 0;
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, {
      createRequestId: () => `claude_dialog_choice_${++requestSequence}`,
      nowMs: () => 123,
    });
    broker.activate();
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG, SAFEGUARD_DIALOG] });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({
      broker,
      port,
      wait: async () => undefined,
      graceMs: 25,
      settleMs: 1,
      isDialogOwned: () => false,
    });

    await expect(probe.evaluateScreenState(parseClaudeScreenState(EFFORT_DIALOG))).resolves.toEqual({
      kind: 'request_published',
      dialogId: 'effort_change',
    });
    await expect(probe.evaluateScreenState(parseClaudeScreenState(SAFEGUARD_DIALOG))).resolves.toEqual({
      kind: 'request_published',
      dialogId: 'safeguard_pause',
    });

    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_1).toBeUndefined();
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_2).toMatchObject({
      arguments: expect.objectContaining({
        happierDialog: { kind: 'recognized', dialogId: 'safeguard_pause' },
      }),
    });
  });
});
