import { dirname } from 'node:path';

import type { ExactSessionTurnEndMutationV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';

import {
    createSessionMutationJournal,
    type SessionMutationSocket,
} from './createSessionMutationOutbox';
import {
    parseDaemonTerminalQueuedSessionMutation,
    resolveSessionMutationJournalPaths,
    type SessionMutationJournalPaths,
} from './sessionMutationPersistence';

export type DaemonTerminalSessionMutationOutbox = Readonly<{
    enqueueExactTurnEnd(mutation: ExactSessionTurnEndMutationV1): Promise<void>;
    flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
    close(): Promise<void>;
}>;

type DaemonTerminalSessionMutationJournalParams = Readonly<{
    token: string;
    sessionId: string;
    paths: SessionMutationJournalPaths;
    getSocket: () => SessionMutationSocket;
    requestReconnect: (reason: string) => void;
}>;

export function createDaemonTerminalSessionMutationJournal(
    params: DaemonTerminalSessionMutationJournalParams,
): DaemonTerminalSessionMutationOutbox {
    const activeServerDir = dirname(dirname(params.paths.queuePath));
    const expectedPaths = resolveSessionMutationJournalPaths({
        activeServerDir,
        sessionId: params.sessionId,
        custody: 'daemon-terminal',
    });
    if (
        params.paths.queuePath !== expectedPaths.queuePath
        || params.paths.deadLetterPath !== expectedPaths.deadLetterPath
    ) {
        throw new Error('Daemon terminal journal paths must be the exact daemon-terminal journal pair');
    }
    const journal = createSessionMutationJournal({
        ...params,
        custody: 'daemon-terminal',
        admission: parseDaemonTerminalQueuedSessionMutation,
    });
    return {
        enqueueExactTurnEnd: async (mutation) => {
            const result = await journal.enqueueSessionTurnDurably(mutation);
            if (!result.persisted) {
                throw new Error('Daemon terminal exact-turn mutation was not durably persisted');
            }
        },
        flush: journal.flush,
        close: journal.close,
    };
}

export function createDaemonTerminalSessionMutationOutbox(params: Readonly<{
    token: string;
    sessionId: string;
    getSocket: () => SessionMutationSocket;
    requestReconnect: (reason: string) => void;
}>): DaemonTerminalSessionMutationOutbox {
    return createDaemonTerminalSessionMutationJournal({
        ...params,
        paths: resolveSessionMutationJournalPaths({
            activeServerDir: configuration.activeServerDir,
            sessionId: params.sessionId,
            custody: 'daemon-terminal',
        }),
    });
}
