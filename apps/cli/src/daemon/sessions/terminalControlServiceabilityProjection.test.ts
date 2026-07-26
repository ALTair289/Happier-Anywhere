import { describe, expect, it } from 'vitest';

import {
  applyTerminalControlServiceabilityProjection,
  clearTerminalControlServiceabilityProjection,
  resolveRunnerTerminalControlServiceabilityEvidence,
  shouldPublishReportedTerminalControlServiceability,
} from './terminalControlServiceabilityProjection';

describe('applyTerminalControlServiceabilityProjection', () => {
  it('requests one daemon publication per reported non-plain attachment', () => {
    const terminal = {
      mode: 'tmux' as const,
      tmux: { target: 'nested-terminal:nested-pane' },
    };

    expect(shouldPublishReportedTerminalControlServiceability({
      terminal,
      attachmentId: 'attachment-1',
      publishedAttachmentId: undefined,
    })).toBe(true);
    expect(shouldPublishReportedTerminalControlServiceability({
      terminal,
      attachmentId: 'attachment-1',
      publishedAttachmentId: 'attachment-1',
    })).toBe(false);
    expect(shouldPublishReportedTerminalControlServiceability({
      terminal: { mode: 'plain' },
      attachmentId: 'attachment-2',
      publishedAttachmentId: undefined,
    })).toBe(false);
  });

  it('projects a present but unservable reattached runner as recoverable instead of hiding it behind the duplicate fence', () => {
    expect(resolveRunnerTerminalControlServiceabilityEvidence({
      probe: {
        state: 'runner_present',
        control: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' },
      },
      attachmentId: 'attachment-zombie-wrapper',
      observedAt: 150,
    })).toEqual({
      attachmentId: 'attachment-zombie-wrapper',
      state: 'recoverable_unservable',
      observedAt: 150,
      reason: 'rpc_method_unavailable',
    });
  });

  it('refuses a delayed observation from a replaced terminal attachment', () => {
    const afterReplacement = applyTerminalControlServiceabilityProjection({
      metadata: { terminal: { mode: 'tmux' } },
      evidence: {
        attachmentId: 'attachment-replacement',
        state: 'servable',
        observedAt: 200,
      },
    });

    const afterDelayedDisconnectedScan = applyTerminalControlServiceabilityProjection({
      metadata: afterReplacement,
      evidence: {
        attachmentId: 'attachment-original',
        state: 'recoverable_unservable',
        observedAt: 100,
        reason: 'runner_absent',
      },
    });

    expect(afterDelayedDisconnectedScan).toEqual(afterReplacement);
  });

  it('allows newer evidence for a replacement attachment to supersede the old projection', () => {
    const afterOriginal = applyTerminalControlServiceabilityProjection({
      metadata: { terminal: { mode: 'tmux' } },
      evidence: {
        attachmentId: 'attachment-original',
        state: 'recoverable_unservable',
        observedAt: 100,
        reason: 'runner_absent',
      },
    });

    expect(applyTerminalControlServiceabilityProjection({
      metadata: afterOriginal,
      evidence: {
        attachmentId: 'attachment-replacement',
        state: 'servable',
        observedAt: 200,
      },
    })).toMatchObject({
      terminal: {
        controlServiceabilityV1: {
          v: 1,
          attachmentId: 'attachment-replacement',
          state: 'servable',
          observedAt: 200,
        },
      },
    });
  });

  it('clears serviceability evidence only when it belongs to the retired attachment', () => {
    const metadata = {
      terminal: {
        mode: 'tmux',
        controlServiceabilityV1: {
          v: 1,
          attachmentId: 'attachment-retired',
          state: 'recoverable_unservable',
          observedAt: 100,
          reason: 'rpc_method_unavailable',
        },
      },
    };

    expect(clearTerminalControlServiceabilityProjection({
      metadata,
      retiredAttachmentId: 'attachment-retired',
      retiredAt: 150,
    })).toEqual({
      terminal: {
        mode: 'tmux',
        controlServiceabilityV1: {
          v: 1,
          attachmentId: 'attachment-retired',
          state: 'unknown',
          observedAt: 150,
          reason: 'attachment_retired',
          retired: true,
        },
      },
    });

    expect(clearTerminalControlServiceabilityProjection({
      metadata: {
        terminal: {
          ...metadata.terminal,
          controlServiceabilityV1: {
            ...metadata.terminal.controlServiceabilityV1,
            attachmentId: 'attachment-replacement',
            state: 'servable',
            observedAt: 200,
          },
        },
      },
      retiredAttachmentId: 'attachment-retired',
      retiredAt: 250,
    })).toMatchObject({
      terminal: {
        controlServiceabilityV1: {
          attachmentId: 'attachment-replacement',
          state: 'servable',
          observedAt: 200,
        },
      },
    });
  });

  it('keeps a retirement tombstone ahead of delayed evidence while allowing a replacement attachment', () => {
    const retired = clearTerminalControlServiceabilityProjection({
      metadata: {
        terminal: {
          mode: 'tmux',
          controlServiceabilityV1: {
            v: 1,
            attachmentId: 'attachment-retired',
            state: 'recoverable_unservable',
            observedAt: 100,
          },
        },
      },
      retiredAttachmentId: 'attachment-retired',
      retiredAt: 150,
    });
    expect(applyTerminalControlServiceabilityProjection({
      metadata: retired,
      evidence: {
        attachmentId: 'attachment-retired',
        state: 'recoverable_unservable',
        observedAt: 200,
      },
    })).toEqual(retired);
    expect(applyTerminalControlServiceabilityProjection({
      metadata: retired,
      evidence: {
        attachmentId: 'attachment-replacement',
        state: 'servable',
        observedAt: 150,
      },
    })).toMatchObject({
      terminal: {
        controlServiceabilityV1: {
          attachmentId: 'attachment-replacement',
          state: 'servable',
        },
      },
    });
  });

  it('creates a retirement tombstone when no projection exists yet', () => {
    const retired = clearTerminalControlServiceabilityProjection({
      metadata: { terminal: { mode: 'tmux' } },
      retiredAttachmentId: 'attachment-retired-before-publish',
      retiredAt: 150,
    });

    expect(retired).toMatchObject({
      terminal: {
        mode: 'tmux',
        controlServiceabilityV1: {
          attachmentId: 'attachment-retired-before-publish',
          state: 'unknown',
          observedAt: 150,
          reason: 'attachment_retired',
          retired: true,
        },
      },
    });
    expect(applyTerminalControlServiceabilityProjection({
      metadata: retired,
      evidence: {
        attachmentId: 'attachment-retired-before-publish',
        state: 'recoverable_unservable',
        observedAt: 200,
      },
    })).toEqual(retired);
  });

  it('preserves the retired attachment terminal mode when metadata had no terminal projection', () => {
    expect(clearTerminalControlServiceabilityProjection({
      metadata: { path: '/tmp/repo' },
      retiredAttachmentId: 'attachment-zellij',
      retiredAt: 150,
      terminalMode: 'zellij',
    })).toMatchObject({
      path: '/tmp/repo',
      terminal: {
        mode: 'zellij',
        controlServiceabilityV1: {
          attachmentId: 'attachment-zellij',
          state: 'unknown',
          retired: true,
        },
      },
    });
  });
});
