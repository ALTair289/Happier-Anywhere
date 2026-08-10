import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';

import { mapCodexRolloutEventToActions } from '../localControl/rolloutMapper';
import { readCodexSessionMetaFromRollout } from '../localControl/rolloutDiscovery';
import { createCodexRolloutSemanticTracker } from '../rollout/createCodexRolloutSemanticTracker';
import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import type { CodexDirectTranscriptRolloutStream } from './codexDirectTranscriptProjection';

const CHILD_DISCOVERY_MAX_BYTES = 1024 * 1024;
const CHILD_DISCOVERY_MAX_ITEMS = 512;

function supportsExactEventUserMessageProjection(cliVersion: unknown): boolean {
  if (typeof cliVersion !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?$/.exec(cliVersion.trim());
  if (!match) return false;
  const version = match.slice(1, 4).map((part) => Number.parseInt(part, 10));
  const minimum = [0, 145, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index]! > minimum[index]!) return true;
    if (version[index]! < minimum[index]!) return false;
  }
  // A prerelease of the exact minimum sorts below the stable minimum.
  return !match[4]?.startsWith('-');
}

export async function materializeCodexDirectTranscriptRolloutStreams(params: Readonly<{
  files: readonly CodexRolloutFile[];
  threadId: string;
  sidechainId: string | null;
}>): Promise<readonly CodexDirectTranscriptRolloutStream[]> {
  return await Promise.all(params.files.map(async (file) => {
    const sessionMeta = await readCodexSessionMetaFromRollout(file.filePath);
    const cliVersion = sessionMeta?.cli_version ?? sessionMeta?.cliVersion;
    return {
      ...file,
      threadId: params.threadId,
      sidechainId: params.sidechainId,
      // Unknown/older transcripts deliberately keep the legacy response_item path.
      useEventUserMessageProjection: supportsExactEventUserMessageProjection(cliVersion),
    };
  }));
}

async function discoverSpawnedThreadIdsFromFilesBounded(files: readonly CodexRolloutFile[]): Promise<readonly string[]> {
  const discovered = new Set<string>();
  const semanticTracker = createCodexRolloutSemanticTracker();
  for (const file of files) {
    let offsetBytes = 0;
    let scannedBytes = 0;
    let scannedItems = 0;
    while (scannedBytes < CHILD_DISCOVERY_MAX_BYTES && scannedItems < CHILD_DISCOVERY_MAX_ITEMS) {
      const page = await readJsonlFileForward({
        filePath: file.filePath,
        offsetBytes,
        maxBytes: Math.min(128 * 1024, CHILD_DISCOVERY_MAX_BYTES - scannedBytes),
        maxItems: Math.min(64, CHILD_DISCOVERY_MAX_ITEMS - scannedItems),
      });
      for (const line of page.items) {
        const normalizedActions = mapCodexRolloutEventToActions(line.value, { debug: true })
          .flatMap((action) => semanticTracker.consume(action));
        for (const action of normalizedActions) {
          if (action.type === 'subagent-spawn') {
            discovered.add(action.threadId);
          }
        }
      }
      if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
      scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
      scannedItems += page.items.length;
      offsetBytes = page.nextOffsetBytes;
    }
  }
  return [...discovered];
}

export async function collectCodexDirectTranscriptRolloutStreams(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  initialRolloutFiles?: readonly CodexRolloutFile[];
}>): Promise<readonly CodexDirectTranscriptRolloutStream[]> {
  const queue = [{ threadId: params.remoteSessionId, sidechainId: null as string | null }];
  const seenThreadIds = new Set<string>();
  const streams: CodexDirectTranscriptRolloutStream[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seenThreadIds.has(current.threadId)) continue;
    seenThreadIds.add(current.threadId);

    const files = current.threadId === params.remoteSessionId && current.sidechainId === null && params.initialRolloutFiles
      ? [...params.initialRolloutFiles]
      : await collectCodexSessionRolloutFiles({
        codexHome: params.codexHome,
        remoteSessionId: current.threadId,
      });
    if (files.length === 0) continue;

    streams.push(...await materializeCodexDirectTranscriptRolloutStreams({
      files,
      threadId: current.threadId,
      sidechainId: current.sidechainId,
    }));

    const discoveredChildThreadIds = await discoverSpawnedThreadIdsFromFilesBounded(files);
    for (const threadId of discoveredChildThreadIds) {
      if (!seenThreadIds.has(threadId)) {
        queue.push({ threadId, sidechainId: threadId });
      }
    }
  }

  streams.sort((left, right) =>
    left.sortMs - right.sortMs
    || left.mtimeMs - right.mtimeMs
    || left.fileRelPath.localeCompare(right.fileRelPath),
  );
  return streams;
}
