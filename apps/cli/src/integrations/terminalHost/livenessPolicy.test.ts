import { describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter, TerminalHostHandle } from './_types';
import {
  evaluateTerminalHostLivenessForRecovery,
  isTerminalHostConfirmedDeadForRelaunch,
} from './livenessPolicy';
import { ZellijActionTimeoutError } from '../zellij/actions';

const handle: TerminalHostHandle = {
  kind: 'zellij',
  sessionName: 'session-a',
  paneId: 'terminal_1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

function buildAdapter(evaluateLiveness: TerminalHostAdapter['evaluateLiveness']): TerminalHostAdapter {
  return {
    kind: 'zellij',
    createOrAttachHost: vi.fn(),
    injectUserPrompt: vi.fn(),
    interruptTurn: vi.fn(),
    evaluateLiveness,
    dispose: vi.fn(),
  };
}

describe('terminal host recovery liveness policy', () => {
  it('represents repeated probe timeouts as inconclusive, never confirmed dead', async () => {
    const adapter = buildAdapter(vi.fn(async () => {
      throw new ZellijActionTimeoutError('list-panes');
    }));

    const result = await evaluateTerminalHostLivenessForRecovery(adapter, handle);

    expect(result).toMatchObject({
      status: 'inconclusive',
      probeCount: 2,
      liveness: {
        paneAlive: false,
        probeInconclusive: true,
      },
    });
    expect(isTerminalHostConfirmedDeadForRelaunch(result)).toBe(false);
    expect(adapter.evaluateLiveness).toHaveBeenCalledTimes(2);
  });

  it('represents positive exited-pane evidence as confirmed dead', async () => {
    const adapter = buildAdapter(vi.fn(async () => ({
      paneAlive: false,
      paneDead: true,
      paneExitStatus: 1,
      observedAt: 1,
    })));

    const result = await evaluateTerminalHostLivenessForRecovery(adapter, handle);

    expect(result).toMatchObject({ status: 'dead', probeCount: 1 });
    expect(isTerminalHostConfirmedDeadForRelaunch(result)).toBe(true);
  });
});
