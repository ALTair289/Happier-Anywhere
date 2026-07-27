import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readTerminalAttachmentInfo as readDefaultTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

export const HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY = 'HAPPIER_CLAUDE_ENDPOINT_STATE';

export type AttachmentBoundClaudeEndpointState = Readonly<{
  v: 2;
  attachmentId: string;
  hookServerPort: number;
  hookPluginDir: string | null;
  hookSettingsPath: string;
  hookSettingsOverlayPath?: string;
  statuslineSecretFilePath?: string;
  mcpUrl: string;
  mcpPort: number;
}>;

function descriptorDirectory(happyHomeDir: string): string {
  return join(happyHomeDir, 'providers', 'claude', 'endpoint-recovery');
}

function sessionDescriptorDirectory(happyHomeDir: string, sessionId: string): string {
  return join(descriptorDirectory(happyHomeDir), encodeURIComponent(sessionId));
}

function descriptorPath(happyHomeDir: string, sessionId: string, attachmentId: string): string {
  return join(sessionDescriptorDirectory(happyHomeDir, sessionId), `${encodeURIComponent(attachmentId)}.json`);
}

export function parseAttachmentBoundClaudeEndpointState(value: unknown): AttachmentBoundClaudeEndpointState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AttachmentBoundClaudeEndpointState>;
  if (candidate.v !== 2) return null;
  if (typeof candidate.attachmentId !== 'string' || candidate.attachmentId.trim().length === 0) return null;
  if (!Number.isInteger(candidate.hookServerPort) || (candidate.hookServerPort ?? 0) <= 0) return null;
  if (typeof candidate.hookSettingsPath !== 'string' || candidate.hookSettingsPath.trim().length === 0) return null;
  if (typeof candidate.mcpUrl !== 'string' || candidate.mcpUrl.trim().length === 0) return null;
  if (!Number.isInteger(candidate.mcpPort) || (candidate.mcpPort ?? 0) <= 0) return null;
  if (candidate.hookPluginDir !== null && typeof candidate.hookPluginDir !== 'string') return null;
  if (candidate.hookSettingsOverlayPath !== undefined && typeof candidate.hookSettingsOverlayPath !== 'string') return null;
  if (candidate.statuslineSecretFilePath !== undefined && typeof candidate.statuslineSecretFilePath !== 'string') return null;
  return candidate as AttachmentBoundClaudeEndpointState;
}

export async function writeClaudeEndpointDescriptor(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  endpointState: AttachmentBoundClaudeEndpointState;
}>): Promise<void> {
  const directory = sessionDescriptorDirectory(params.happyHomeDir, params.sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const path = descriptorPath(params.happyHomeDir, params.sessionId, params.endpointState.attachmentId);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(params.endpointState), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600).catch(() => {});
}

export async function readClaudeEndpointDescriptor(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  attachmentId: string;
}>): Promise<AttachmentBoundClaudeEndpointState | null> {
  try {
    const raw = await readFile(descriptorPath(params.happyHomeDir, params.sessionId, params.attachmentId), 'utf8');
    const state = parseAttachmentBoundClaudeEndpointState(JSON.parse(raw));
    return state?.attachmentId === params.attachmentId ? state : null;
  } catch {
    return null;
  }
}

export async function hasClaudeEndpointDescriptorForSession(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  attachmentId?: string;
}>): Promise<boolean> {
  if (params.attachmentId) {
    return await readClaudeEndpointDescriptor({
      happyHomeDir: params.happyHomeDir,
      sessionId: params.sessionId,
      attachmentId: params.attachmentId,
    }) !== null;
  }
  try {
    return (await readdir(sessionDescriptorDirectory(params.happyHomeDir, params.sessionId)))
      .some((entry) => entry.endsWith('.json'));
  } catch {
    return false;
  }
}

export async function removeClaudeEndpointDescriptor(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedAttachmentId: string;
}>): Promise<boolean> {
  const path = descriptorPath(params.happyHomeDir, params.sessionId, params.expectedAttachmentId);
  try {
    const state = parseAttachmentBoundClaudeEndpointState(JSON.parse(await readFile(path, 'utf8')));
    if (!state || state.attachmentId !== params.expectedAttachmentId) return false;
    await unlink(path);
    await rmdir(sessionDescriptorDirectory(params.happyHomeDir, params.sessionId)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export type ClaudeEndpointArtifactCleanupResult =
  | Readonly<{ status: 'cleaned' }>
  | Readonly<{
      status: 'retained';
      reason: 'attachment_still_current' | 'successor_attachment_present' | 'attachment_read_failed' | 'descriptor_mismatch';
    }>;

async function removeEndpointArtifactPath(path: string, recursive = false): Promise<void> {
  try {
    if (recursive) {
      await rm(path, { recursive: true, force: false });
    } else {
      await unlink(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
}

async function cleanupEndpointArtifactsStrict(state: AttachmentBoundClaudeEndpointState): Promise<void> {
  const settingsPaths = new Set([
    state.hookSettingsPath,
    state.hookSettingsOverlayPath ?? state.hookSettingsPath.replace(/\.json$/, '.overlay.json'),
    state.statuslineSecretFilePath ?? state.hookSettingsPath.replace(/\.json$/, '.statusline-secret'),
  ]);
  for (const path of settingsPaths) await removeEndpointArtifactPath(path);
  if (state.hookPluginDir) await removeEndpointArtifactPath(state.hookPluginDir, true);
}

/**
 * Deletes Claude hook/control artifacts only after the exact attachment they belong to is retired.
 * Attachment identity is the fence: read failures and any successor attachment retain artifacts.
 */
export async function cleanupRetiredClaudeEndpointArtifacts(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  retiredAttachmentId: string;
  endpointState: AttachmentBoundClaudeEndpointState;
  readTerminalAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
  }>) => Promise<TerminalAttachmentInfo | null>;
  cleanupHookSettingsFile?: (path: string) => void;
  cleanupHookPluginDir?: (path: string | null | undefined, options?: Readonly<{ force?: boolean }>) => void;
}>): Promise<ClaudeEndpointArtifactCleanupResult> {
  if (params.endpointState.v !== 2 || params.endpointState.attachmentId !== params.retiredAttachmentId) {
    return { status: 'retained', reason: 'descriptor_mismatch' };
  }

  let current: TerminalAttachmentInfo | null;
  try {
    current = await (params.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo)({
      happyHomeDir: params.happyHomeDir,
      sessionId: params.sessionId,
    });
  } catch {
    return { status: 'retained', reason: 'attachment_read_failed' };
  }

  if (current) {
    if (current.version === 2 && current.attachmentId === params.retiredAttachmentId) {
      return { status: 'retained', reason: 'attachment_still_current' };
    }
    return { status: 'retained', reason: 'successor_attachment_present' };
  }

  if (params.cleanupHookSettingsFile || params.cleanupHookPluginDir) {
    params.cleanupHookSettingsFile?.(params.endpointState.hookSettingsPath);
    params.cleanupHookPluginDir?.(params.endpointState.hookPluginDir, { force: true });
  } else {
    await cleanupEndpointArtifactsStrict(params.endpointState);
  }
  return { status: 'cleaned' };
}

export type ClaudeTerminalAttachmentRetirementResult =
  | Readonly<{ status: 'not_applicable' }>
  | ClaudeEndpointArtifactCleanupResult;

export async function retireClaudeEndpointArtifactsForTerminalAttachment(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  retiredAttachmentId: string;
}>): Promise<ClaudeTerminalAttachmentRetirementResult> {
  const endpointState = await readClaudeEndpointDescriptor({
    ...params,
    attachmentId: params.retiredAttachmentId,
  });
  if (!endpointState || endpointState.attachmentId !== params.retiredAttachmentId) {
    return { status: 'not_applicable' };
  }
  const cleanup = await cleanupRetiredClaudeEndpointArtifacts({
    ...params,
    endpointState,
  });
  if (cleanup.status !== 'cleaned') return cleanup;
  const removed = await removeClaudeEndpointDescriptor({
    ...params,
    expectedAttachmentId: params.retiredAttachmentId,
  });
  return removed ? cleanup : { status: 'retained', reason: 'descriptor_mismatch' };
}
