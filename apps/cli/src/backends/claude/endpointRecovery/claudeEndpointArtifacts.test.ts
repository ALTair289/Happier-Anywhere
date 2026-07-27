import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TerminalAttachmentId } from '@/integrations/terminalHost/_types';

import {
  type AttachmentBoundClaudeEndpointState,
  cleanupRetiredClaudeEndpointArtifacts,
  readClaudeEndpointDescriptor,
  removeClaudeEndpointDescriptor,
  writeClaudeEndpointDescriptor,
} from './claudeEndpointArtifacts';

const endpointState: AttachmentBoundClaudeEndpointState = {
  v: 2,
  attachmentId: 'attachment-endpoint-1',
  hookServerPort: 31001,
  hookPluginDir: '/tmp/happier/plugin-1',
  hookSettingsPath: '/tmp/happier/settings-1.json',
  hookSettingsOverlayPath: '/tmp/happier/settings-1.overlay.json',
  statuslineSecretFilePath: '/tmp/happier/settings-1.statusline-secret',
  mcpUrl: 'http://127.0.0.1:31002',
  mcpPort: 31002,
};
const endpointAttachmentId = endpointState.attachmentId as TerminalAttachmentId;

describe('cleanupRetiredClaudeEndpointArtifacts', () => {
  it('retains artifacts while the exact attachment remains canonical', async () => {
    const cleanupSettings = vi.fn();
    const cleanupPlugin = vi.fn();

    await expect(cleanupRetiredClaudeEndpointArtifacts({
      happyHomeDir: '/tmp/happier',
      sessionId: 'session-1',
      retiredAttachmentId: endpointState.attachmentId,
      endpointState,
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        sessionId: 'session-1',
        attachmentId: endpointAttachmentId,
        handle: {
          attachmentId: endpointAttachmentId,
          kind: 'tmux',
          sessionName: 'session-host',
          paneId: 'pane-1',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
        terminal: { mode: 'tmux', tmux: { target: 'session-host:pane-1' } },
        updatedAt: 1,
      }),
      cleanupHookSettingsFile: cleanupSettings,
      cleanupHookPluginDir: cleanupPlugin,
    })).resolves.toEqual({ status: 'retained', reason: 'attachment_still_current' });

    expect(cleanupSettings).not.toHaveBeenCalled();
    expect(cleanupPlugin).not.toHaveBeenCalled();
  });

  it('cleans every descriptor artifact only after exact attachment retirement is observable', async () => {
    const cleanupSettings = vi.fn();
    const cleanupPlugin = vi.fn();

    await expect(cleanupRetiredClaudeEndpointArtifacts({
      happyHomeDir: '/tmp/happier',
      sessionId: 'session-1',
      retiredAttachmentId: endpointState.attachmentId,
      endpointState,
      readTerminalAttachmentInfo: async () => null,
      cleanupHookSettingsFile: cleanupSettings,
      cleanupHookPluginDir: cleanupPlugin,
    })).resolves.toEqual({ status: 'cleaned' });

    expect(cleanupSettings).toHaveBeenCalledWith(endpointState.hookSettingsPath);
    expect(cleanupPlugin).toHaveBeenCalledWith(endpointState.hookPluginDir, { force: true });
  });

  it('fails closed when a successor attachment is already canonical', async () => {
    const cleanupSettings = vi.fn();
    const cleanupPlugin = vi.fn();

    await expect(cleanupRetiredClaudeEndpointArtifacts({
      happyHomeDir: '/tmp/happier',
      sessionId: 'session-1',
      retiredAttachmentId: endpointState.attachmentId,
      endpointState,
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        sessionId: 'session-1',
        attachmentId: 'attachment-successor' as TerminalAttachmentId,
        handle: {
          attachmentId: 'attachment-successor' as TerminalAttachmentId,
          kind: 'tmux',
          sessionName: 'successor-host',
          paneId: 'pane-2',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
        terminal: { mode: 'tmux', tmux: { target: 'successor-host:pane-2' } },
        updatedAt: 2,
      }),
      cleanupHookSettingsFile: cleanupSettings,
      cleanupHookPluginDir: cleanupPlugin,
    })).resolves.toEqual({ status: 'retained', reason: 'successor_attachment_present' });

    expect(cleanupSettings).not.toHaveBeenCalled();
    expect(cleanupPlugin).not.toHaveBeenCalled();
  });
});

describe('Claude endpoint descriptor ownership', () => {
  it('persists endpoint control state under the provider owner for the exact attachment lifetime', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-endpoint-'));
    try {
      await writeClaudeEndpointDescriptor({
        happyHomeDir,
        sessionId: 'session/with separator',
        endpointState,
      });

      await expect(readClaudeEndpointDescriptor({
        happyHomeDir,
        sessionId: 'session/with separator',
        attachmentId: endpointState.attachmentId,
      })).resolves.toEqual(endpointState);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('removes a descriptor only for the exact retired attachment', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-endpoint-'));
    try {
      await writeClaudeEndpointDescriptor({ happyHomeDir, sessionId: 'session-1', endpointState });

      await expect(removeClaudeEndpointDescriptor({
        happyHomeDir,
        sessionId: 'session-1',
        expectedAttachmentId: 'different-attachment',
      })).resolves.toBe(false);
      await expect(readClaudeEndpointDescriptor({
        happyHomeDir,
        sessionId: 'session-1',
        attachmentId: endpointState.attachmentId,
      })).resolves.toEqual(endpointState);

      await expect(removeClaudeEndpointDescriptor({
        happyHomeDir,
        sessionId: 'session-1',
        expectedAttachmentId: endpointState.attachmentId,
      })).resolves.toBe(true);
      await expect(readClaudeEndpointDescriptor({
        happyHomeDir,
        sessionId: 'session-1',
        attachmentId: endpointState.attachmentId,
      })).resolves.toBeNull();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('cannot remove a successor descriptor because each immutable attachment owns a distinct file', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-endpoint-'));
    const successor = { ...endpointState, attachmentId: 'attachment-successor' };
    try {
      await writeClaudeEndpointDescriptor({ happyHomeDir, sessionId: 'session-1', endpointState });
      await writeClaudeEndpointDescriptor({ happyHomeDir, sessionId: 'session-1', endpointState: successor });

      await expect(removeClaudeEndpointDescriptor({
        happyHomeDir,
        sessionId: 'session-1',
        expectedAttachmentId: endpointState.attachmentId,
      })).resolves.toBe(true);
      await expect(readClaudeEndpointDescriptor({
        happyHomeDir,
        sessionId: 'session-1',
        attachmentId: successor.attachmentId,
      })).resolves.toEqual(successor);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
