import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { DaemonTerminalSessionMutationOutbox } from './daemonTerminalSessionMutationOutbox';
import {
    resolveSessionMutationJournalPaths,
    type SessionMutationJournalPaths,
} from './sessionMutationPersistence';

const DAEMON_TERMINAL_QUEUE_SUFFIX = '.daemon-terminal.json';
const DAEMON_TERMINAL_DEAD_LETTER_SUFFIX = '.daemon-terminal.dead-letter.json';
const LOSSLESS_SESSION_ID = /^[a-zA-Z0-9_.-]+$/;

export type DaemonTerminalJournalHandleRequest = Readonly<{
    custody: 'daemon-terminal';
    sessionId: string;
    paths: SessionMutationJournalPaths;
    discovered: readonly ('queue' | 'dead-letter')[];
}>;

export type DaemonTerminalJournalDiscoveryRejectionReason =
    | 'runtime-custody'
    | 'temporary'
    | 'unrelated'
    | 'malformed-daemon-terminal-name'
    | 'lossy-session-id'
    | 'traversal-like'
    | 'not-regular-file';

export type DaemonTerminalJournalDiscoveryRejection = Readonly<{
    fileName: string;
    reason: DaemonTerminalJournalDiscoveryRejectionReason;
}>;

export type DaemonTerminalJournalDiscoveryResult = Readonly<{
    requests: readonly DaemonTerminalJournalHandleRequest[];
    rejected: readonly DaemonTerminalJournalDiscoveryRejection[];
}>;

type ParsedDaemonTerminalFileName = Readonly<{
    sessionId: string;
    kind: 'queue' | 'dead-letter';
}>;

function isTemporaryFileName(fileName: string): boolean {
    return fileName.startsWith('.tmp-')
        || fileName.endsWith('.tmp')
        || fileName.includes('.tmp-');
}

function isTraversalLikeSessionId(sessionId: string): boolean {
    const normalized = sessionId.toLowerCase();
    return sessionId === '.'
        || sessionId === '..'
        || sessionId.includes('\\')
        || sessionId.includes('/')
        || normalized.includes('%2e')
        || normalized.includes('%2f')
        || normalized.includes('%5c');
}

function parseDaemonTerminalFileName(fileName: string):
    | Readonly<{ ok: true; value: ParsedDaemonTerminalFileName }>
    | Readonly<{ ok: false; reason: DaemonTerminalJournalDiscoveryRejectionReason }> {
    if (isTemporaryFileName(fileName)) return { ok: false, reason: 'temporary' };

    let kind: ParsedDaemonTerminalFileName['kind'] | null = null;
    let suffix = '';
    if (fileName.endsWith(DAEMON_TERMINAL_DEAD_LETTER_SUFFIX)) {
        kind = 'dead-letter';
        suffix = DAEMON_TERMINAL_DEAD_LETTER_SUFFIX;
    } else if (fileName.endsWith(DAEMON_TERMINAL_QUEUE_SUFFIX)) {
        kind = 'queue';
        suffix = DAEMON_TERMINAL_QUEUE_SUFFIX;
    }

    if (kind !== null && fileName.startsWith('session-')) {
        const sessionId = fileName.slice('session-'.length, -suffix.length);
        if (sessionId.length === 0) return { ok: false, reason: 'malformed-daemon-terminal-name' };
        if (isTraversalLikeSessionId(sessionId)) return { ok: false, reason: 'traversal-like' };
        if (!LOSSLESS_SESSION_ID.test(sessionId)) return { ok: false, reason: 'lossy-session-id' };
        return { ok: true, value: { sessionId, kind } };
    }

    if (fileName.includes('.daemon-terminal')) {
        return { ok: false, reason: 'malformed-daemon-terminal-name' };
    }
    if (/^session-.+(?:\.dead-letter)?\.json$/.test(fileName)) {
        return { ok: false, reason: 'runtime-custody' };
    }
    return { ok: false, reason: 'unrelated' };
}

export async function discoverDaemonTerminalSessionMutationJournals(params: Readonly<{
    activeServerDir: string;
}>): Promise<DaemonTerminalJournalDiscoveryResult> {
    const mutationDir = join(params.activeServerDir, 'session-mutations');
    let entries: Dirent<string>[];
    try {
        entries = await readdir(mutationDir, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return { requests: [], rejected: [] };
        }
        throw error;
    }

    const discoveredBySession = new Map<string, Set<'queue' | 'dead-letter'>>();
    const rejected: DaemonTerminalJournalDiscoveryRejection[] = [];
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        const parsed = parseDaemonTerminalFileName(entry.name);
        if (!parsed.ok) {
            rejected.push({ fileName: entry.name, reason: parsed.reason });
            continue;
        }
        if (!entry.isFile()) {
            rejected.push({ fileName: entry.name, reason: 'not-regular-file' });
            continue;
        }
        const paths = resolveSessionMutationJournalPaths({
            activeServerDir: params.activeServerDir,
            sessionId: parsed.value.sessionId,
            custody: 'daemon-terminal',
        });
        const expectedPath = parsed.value.kind === 'queue' ? paths.queuePath : paths.deadLetterPath;
        if (expectedPath !== join(mutationDir, entry.name)) {
            rejected.push({ fileName: entry.name, reason: 'lossy-session-id' });
            continue;
        }
        const discovered = discoveredBySession.get(parsed.value.sessionId) ?? new Set();
        discovered.add(parsed.value.kind);
        discoveredBySession.set(parsed.value.sessionId, discovered);
    }

    const requests = [...discoveredBySession.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([sessionId, discovered]): DaemonTerminalJournalHandleRequest => ({
            custody: 'daemon-terminal',
            sessionId,
            paths: resolveSessionMutationJournalPaths({
                activeServerDir: params.activeServerDir,
                sessionId,
                custody: 'daemon-terminal',
            }),
            discovered: (['queue', 'dead-letter'] as const).filter((kind) => discovered.has(kind)),
        }));

    return { requests, rejected };
}

export async function recoverDaemonTerminalSessionMutationJournals(params: Readonly<{
    activeServerDir: string;
    openHandle: (
        request: DaemonTerminalJournalHandleRequest,
    ) => DaemonTerminalSessionMutationOutbox | Promise<DaemonTerminalSessionMutationOutbox>;
}>): Promise<Readonly<{
    handles: readonly Readonly<{
        request: DaemonTerminalJournalHandleRequest;
        handle: DaemonTerminalSessionMutationOutbox;
    }>[];
    rejected: readonly DaemonTerminalJournalDiscoveryRejection[];
}>> {
    const discovery = await discoverDaemonTerminalSessionMutationJournals({
        activeServerDir: params.activeServerDir,
    });
    const handles: Array<Readonly<{
        request: DaemonTerminalJournalHandleRequest;
        handle: DaemonTerminalSessionMutationOutbox;
    }>> = [];
    try {
        for (const request of discovery.requests) {
            const handle = await params.openHandle(request);
            handles.push({ request, handle });
            await handle.flush('startup');
        }
        return { handles, rejected: discovery.rejected };
    } catch (error) {
        await Promise.allSettled(handles.map(({ handle }) => handle.close()));
        throw error;
    }
}
