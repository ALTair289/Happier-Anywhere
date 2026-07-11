import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
    SessionMessageRoleSchema,
    SessionStoredMessageContentSchema,
    SessionTurnMutationV1Schema,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';

import type {
    QueuedSessionMutation,
    SessionEndMutationV1,
    SessionTurnMutationV1,
    TranscriptMessageAppendMutationV1,
} from './sessionMutationTypes';
import { resolveTranscriptMessageAppendMutationId } from './sessionMutationTypes';
import { isAuthoritativeSessionMutation, isAuthoritativeSessionMutationKind } from './sessionMutationDurabilityPolicy';

type SessionMutationOutboxFileV1 = Readonly<{
    v: 1;
    mutations: readonly QueuedSessionMutation[];
}>;

export type SessionMutationDeadLetterEntry = Readonly<{
    v: 1;
    kind: QueuedSessionMutation['kind'] | 'outbox_file' | 'unknown';
    sessionId: string;
    mutationId?: string;
    reason: string;
    attempts?: number;
    createdAt?: number;
    deadLetteredAt: number;
    dependencyMutationId?: string;
    diagnostic?: Record<string, unknown>;
    payloadSummary?: Record<string, unknown>;
    queuedMutation?: QueuedSessionMutation;
    recoveryAttemptedAt?: number;
}>;

type SessionMutationDeadLetterFileV1 = Readonly<{
    v: 1;
    entries: readonly SessionMutationDeadLetterEntry[];
}>;

export type QueuedMutationParseResult =
    | Readonly<{ ok: true; mutation: QueuedSessionMutation }>
    | Readonly<{ ok: false; deadLetter: SessionMutationDeadLetterEntry }>;

function sanitizeSessionIdForFileName(sessionId: string): string {
    const sanitized = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return sanitized || 'unknown-session';
}

export function resolveSessionMutationOutboxPath(sessionId: string): string {
    return join(
        configuration.activeServerDir,
        'session-mutations',
        `session-${sanitizeSessionIdForFileName(sessionId)}.json`,
    );
}

export function resolveSessionMutationDeadLetterPath(sessionId: string): string {
    return join(
        configuration.activeServerDir,
        'session-mutations',
        `session-${sanitizeSessionIdForFileName(sessionId)}.dead-letter.json`,
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarizePayload(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    const summary: Record<string, unknown> = {
        keys: Object.keys(value).sort(),
    };
    for (const key of ['sessionId', 'mutationId', 'action', 'source', 'localId', 'turnId', 'provider', 'providerTurnId'] as const) {
        if (typeof value[key] === 'string') summary[key] = value[key];
    }
    return summary;
}

function summarizeZodIssues(error: { issues: readonly { code: string; path: readonly PropertyKey[] }[] }): Record<string, unknown> {
    return {
        issues: error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path.map(String).join('.'),
        })),
    };
}

function createDeadLetterEntry(params: Readonly<{
    sessionId: string;
    kind: SessionMutationDeadLetterEntry['kind'];
    reason: string;
    mutationId?: string;
    attempts?: number;
    createdAt?: number;
    dependencyMutationId?: string;
    diagnostic?: Record<string, unknown>;
    payload?: unknown;
    queuedMutation?: QueuedSessionMutation;
    recoveryAttemptedAt?: number;
}>): SessionMutationDeadLetterEntry {
    return {
        v: 1,
        kind: params.kind,
        sessionId: params.sessionId,
        ...(params.mutationId ? { mutationId: params.mutationId } : {}),
        reason: params.reason,
        ...(typeof params.attempts === 'number' ? { attempts: params.attempts } : {}),
        ...(typeof params.createdAt === 'number' ? { createdAt: params.createdAt } : {}),
        deadLetteredAt: Date.now(),
        ...(params.dependencyMutationId ? { dependencyMutationId: params.dependencyMutationId } : {}),
        ...(params.diagnostic ? { diagnostic: params.diagnostic } : {}),
        ...(params.payload !== undefined ? { payloadSummary: summarizePayload(params.payload) } : {}),
        ...(params.queuedMutation ? { queuedMutation: params.queuedMutation } : {}),
        ...(typeof params.recoveryAttemptedAt === 'number' ? { recoveryAttemptedAt: params.recoveryAttemptedAt } : {}),
    };
}

function parseSessionTurnPayload(value: unknown): Readonly<{
    payload: SessionTurnMutationV1 | null;
    diagnostic?: Record<string, unknown>;
}> {
    const parsed = SessionTurnMutationV1Schema.safeParse(value);
    if (parsed.success) return { payload: parsed.data };
    return {
        payload: null,
        diagnostic: summarizeZodIssues(parsed.error),
    };
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
    return Object.keys(value).every((key) => allowedKeys.has(key));
}

function parseSessionEndPayload(value: unknown): SessionEndMutationV1 | null {
    if (!isRecord(value)) return null;
    const allowedKeys = new Set(['v', 'source', 'sessionId', 'mutationId', 'observedAt', 'exit']);
    if (
        !hasOnlyKeys(value, allowedKeys)
        || value.v !== 1
        || value.source !== 'session_end'
        || typeof value.sessionId !== 'string'
        || typeof value.mutationId !== 'string'
        || typeof value.observedAt !== 'number'
        || !Number.isFinite(value.observedAt)
        || value.observedAt < 0
    ) {
        return null;
    }
    return value as unknown as SessionEndMutationV1;
}

function parseTranscriptMessageAppendPayload(value: unknown): TranscriptMessageAppendMutationV1 | null {
    if (!isRecord(value)) return null;
    const allowedKeys = new Set([
        'v',
        'source',
        'sessionId',
        'mutationId',
        'localId',
        'sidechainId',
        'messageRole',
        'content',
        'createdAt',
        'updatedAt',
        'sessionEventType',
    ]);
    if (
        !hasOnlyKeys(value, allowedKeys)
        || value.v !== 1
        || value.source !== 'transcript_message_append'
        || typeof value.sessionId !== 'string'
        || typeof value.mutationId !== 'string'
        || typeof value.localId !== 'string'
        || value.localId.trim().length === 0
        || typeof value.createdAt !== 'number'
        || !Number.isFinite(value.createdAt)
        || value.createdAt < 0
        || typeof value.updatedAt !== 'number'
        || !Number.isFinite(value.updatedAt)
        || value.updatedAt < 0
        || (value.sidechainId !== undefined && value.sidechainId !== null && typeof value.sidechainId !== 'string')
        || (value.sessionEventType !== undefined && value.sessionEventType !== 'ready')
    ) {
        return null;
    }
    if (value.messageRole !== undefined && !SessionMessageRoleSchema.safeParse(value.messageRole).success) {
        return null;
    }
    if (typeof value.content !== 'string' && !SessionStoredMessageContentSchema.safeParse(value.content).success) {
        return null;
    }
    if (value.mutationId !== resolveTranscriptMessageAppendMutationId({
        sessionId: value.sessionId,
        localId: value.localId,
    })) {
        return null;
    }
    return value as unknown as TranscriptMessageAppendMutationV1;
}

export function parseQueuedSessionMutation(value: unknown, sessionId: string): QueuedMutationParseResult {
    if (!isRecord(value)) {
        return {
            ok: false,
            deadLetter: createDeadLetterEntry({
                sessionId,
                kind: 'unknown',
                reason: 'invalid_queued_mutation_record',
                payload: value,
            }),
        };
    }
    const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? Math.trunc(value.createdAt) : Date.now();
    const attempts = typeof value.attempts === 'number' && Number.isFinite(value.attempts) ? Math.max(0, Math.trunc(value.attempts)) : 0;
    const nextAttemptAt = typeof value.nextAttemptAt === 'number' && Number.isFinite(value.nextAttemptAt) ? Math.max(0, Math.trunc(value.nextAttemptAt)) : 0;
    const intentOrder = typeof value.intentOrder === 'number'
        && Number.isSafeInteger(value.intentOrder)
        && value.intentOrder > 0
        ? value.intentOrder
        : null;
    const mutationId = typeof value.mutationId === 'string' ? value.mutationId : undefined;
    if (value.kind === 'session_turn') {
        const parsedPayload = parseSessionTurnPayload(value.payload);
        if (!parsedPayload.payload) {
            return {
                ok: false,
                deadLetter: createDeadLetterEntry({
                    sessionId,
                    kind: 'session_turn',
                    reason: 'invalid_session_turn_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    diagnostic: parsedPayload.diagnostic,
                    payload: value.payload,
                }),
            };
        }
        return {
            ok: true,
            mutation: {
                kind: 'session_turn',
                mutationId: parsedPayload.payload.mutationId,
                payload: parsedPayload.payload,
                createdAt,
                attempts,
                nextAttemptAt,
            },
        };
    }
    if (value.kind === 'session_end') {
        const payload = parseSessionEndPayload(value.payload);
        if (!payload) {
            return {
                ok: false,
                deadLetter: createDeadLetterEntry({
                    sessionId,
                    kind: 'session_end',
                    reason: 'invalid_session_end_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                }),
            };
        }
        return {
            ok: true,
            mutation: {
                kind: 'session_end',
                mutationId: payload.mutationId,
                payload,
                createdAt,
                attempts,
                nextAttemptAt,
            },
        };
    }
    if (value.kind === 'transcript_message_append') {
        const payload = parseTranscriptMessageAppendPayload(value.payload);
        if (!payload || mutationId !== payload.mutationId) {
            return {
                ok: false,
                deadLetter: createDeadLetterEntry({
                    sessionId,
                    kind: 'transcript_message_append',
                    reason: 'invalid_transcript_message_append_payload',
                    mutationId,
                    attempts,
                    createdAt,
                    payload: value.payload,
                }),
            };
        }
        return {
            ok: true,
            mutation: {
                kind: 'transcript_message_append',
                mutationId: payload.mutationId,
                payload,
                ...(intentOrder !== null ? { intentOrder } : {}),
                createdAt,
                attempts,
                nextAttemptAt,
            },
        };
    }
    return {
        ok: false,
        deadLetter: createDeadLetterEntry({
            sessionId,
            kind: 'unknown',
            reason: 'unknown_queued_mutation_kind',
            mutationId,
            attempts,
            createdAt,
            payload: value,
        }),
    };
}

export async function loadSessionMutationOutbox(sessionId: string): Promise<QueuedSessionMutation[]> {
    const filePath = resolveSessionMutationOutboxPath(sessionId);
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
        if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.mutations)) {
            await appendSessionMutationDeadLetters(sessionId, [
                createDeadLetterEntry({
                    sessionId,
                    kind: 'outbox_file',
                    reason: 'invalid_outbox_file',
                    payload: parsed,
                }),
            ]);
            return [];
        }
        const mutations: QueuedSessionMutation[] = [];
        const deadLetters: SessionMutationDeadLetterEntry[] = [];
        for (const rawMutation of parsed.mutations) {
            const parsedMutation = parseQueuedSessionMutation(rawMutation, sessionId);
            if (parsedMutation.ok) {
                mutations.push(parsedMutation.mutation);
            } else {
                deadLetters.push(parsedMutation.deadLetter);
            }
        }
        if (deadLetters.length > 0) {
            await appendSessionMutationDeadLetters(sessionId, deadLetters);
        }
        return mutations;
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code !== 'ENOENT') {
            await appendSessionMutationDeadLetters(sessionId, [
                createDeadLetterEntry({
                    sessionId,
                    kind: 'outbox_file',
                    reason: 'invalid_outbox_json',
                    diagnostic: {
                        errorName: error instanceof Error ? error.name : 'unknown',
                    },
                }),
            ]);
        }
        return [];
    }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
        await writeFile(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
        if (process.platform !== 'win32') {
            await chmod(tmpPath, 0o600).catch(() => {});
        }
        try {
            await rename(tmpPath, filePath);
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') throw error;
            await unlink(filePath).catch((unlinkError) => {
                const unlinkErr = unlinkError as NodeJS.ErrnoException;
                if (unlinkErr?.code !== 'ENOENT') throw unlinkError;
            });
            await rename(tmpPath, filePath);
        }
        if (process.platform !== 'win32') {
            await chmod(filePath, 0o600).catch(() => {});
        }
    } catch (error) {
        await unlink(tmpPath).catch(() => {});
        throw error;
    }
}

async function loadDeadLetterFile(filePath: string): Promise<SessionMutationDeadLetterEntry[]> {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
        if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.entries)) return [];
        return parsed.entries.filter((entry): entry is SessionMutationDeadLetterEntry => isRecord(entry) && entry.v === 1);
    } catch {
        return [];
    }
}

export async function appendSessionMutationDeadLetters(
    sessionId: string,
    entries: readonly SessionMutationDeadLetterEntry[],
): Promise<void> {
    if (entries.length === 0) return;
    const filePath = resolveSessionMutationDeadLetterPath(sessionId);
    const existing = await loadDeadLetterFile(filePath);
    await writeJsonAtomic(filePath, {
        v: 1,
        entries: [...existing, ...entries],
    } satisfies SessionMutationDeadLetterFileV1);
}

function readRecoverableQueuedMutation(
    entry: SessionMutationDeadLetterEntry,
    sessionId: string,
): QueuedSessionMutation | null {
    if (!isAuthoritativeSessionMutationKind(entry.kind as QueuedSessionMutation['kind'])) return null;
    if (typeof entry.recoveryAttemptedAt === 'number') return null;
    const record = entry as unknown as Record<string, unknown>;
    const rawQueuedMutation = record.queuedMutation ?? record.mutation ?? (
        record.payload
            ? {
                kind: entry.kind,
                mutationId: entry.mutationId,
                payload: record.payload,
                createdAt: entry.createdAt,
                attempts: entry.attempts,
                nextAttemptAt: 0,
            }
            : readQueuedMutationFromPayloadSummary(entry, sessionId)
    );
    if (!rawQueuedMutation) return null;
    const parsed = parseQueuedSessionMutation(rawQueuedMutation, sessionId);
    if (!parsed.ok || !isAuthoritativeSessionMutation(parsed.mutation)) return null;
    return {
        ...parsed.mutation,
        nextAttemptAt: 0,
    } as QueuedSessionMutation;
}

function readQueuedMutationFromPayloadSummary(
    entry: SessionMutationDeadLetterEntry,
    sessionId: string,
): QueuedSessionMutation | null {
    const summary = isRecord(entry.payloadSummary) ? entry.payloadSummary : null;
    if (!summary) return null;
    const recoveredSessionId = typeof summary.sessionId === 'string' && summary.sessionId.trim().length > 0
        ? summary.sessionId
        : sessionId;
    const mutationId = typeof entry.mutationId === 'string' && entry.mutationId.trim().length > 0
        ? entry.mutationId
        : typeof summary.mutationId === 'string' && summary.mutationId.trim().length > 0
            ? summary.mutationId
            : null;
    if (!mutationId) return null;
    const createdAt = typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
        ? entry.createdAt
        : entry.deadLetteredAt;
    const attempts = typeof entry.attempts === 'number' && Number.isFinite(entry.attempts)
        ? Math.max(0, Math.trunc(entry.attempts))
        : 0;

    if (entry.kind === 'session_turn') {
        if (typeof summary.action !== 'string' || summary.action.trim().length === 0) return null;
        const turnId = typeof summary.turnId === 'string' && summary.turnId.trim().length > 0
            ? summary.turnId
            : null;
        const action = turnId || summary.action === 'end_session'
            ? summary.action
            : summary.action === 'complete' || summary.action === 'fail' || summary.action === 'cancel'
                ? 'end_session'
                : null;
        if (!action) return null;
        return {
            kind: 'session_turn',
            mutationId,
            payload: {
                v: 1,
                sessionId: recoveredSessionId,
                mutationId,
                action,
                ...(turnId ? { turnId } : {}),
                ...(typeof summary.provider === 'string' && summary.provider.trim().length > 0 ? { provider: summary.provider } : {}),
                ...(typeof summary.providerTurnId === 'string' && summary.providerTurnId.trim().length > 0 ? { providerTurnId: summary.providerTurnId } : {}),
                observedAt: createdAt,
            },
            createdAt,
            attempts,
            nextAttemptAt: 0,
        } as QueuedSessionMutation;
    }

    if (entry.kind === 'session_end') {
        return {
            kind: 'session_end',
            mutationId,
            payload: {
                v: 1,
                sessionId: recoveredSessionId,
                mutationId,
                source: 'session_end',
                observedAt: createdAt,
            },
            createdAt,
            attempts,
            nextAttemptAt: 0,
        } as QueuedSessionMutation;
    }

    return null;
}

export async function recoverAuthoritativeSessionMutationDeadLetters(
    sessionId: string,
    limit = 100,
): Promise<QueuedSessionMutation[]> {
    const filePath = resolveSessionMutationDeadLetterPath(sessionId);
    const existing = await loadDeadLetterFile(filePath);
    if (existing.length === 0) return [];

    const recovered: QueuedSessionMutation[] = [];
    let didMark = false;
    const now = Date.now();
    const updated = existing.map((entry) => {
        if (recovered.length >= limit) return entry;
        const queuedMutation = readRecoverableQueuedMutation(entry, sessionId);
        if (!queuedMutation) return entry;
        recovered.push(queuedMutation);
        didMark = true;
        return {
            ...entry,
            recoveryAttemptedAt: now,
        } satisfies SessionMutationDeadLetterEntry;
    });

    if (didMark) {
        await writeJsonAtomic(filePath, {
            v: 1,
            entries: updated,
        } satisfies SessionMutationDeadLetterFileV1);
    }
    return recovered;
}

export function createSessionMutationDeadLetterEntry(params: Readonly<{
    sessionId: string;
    mutation: QueuedSessionMutation;
    reason: string;
    dependencyMutationId?: string;
    diagnostic?: Record<string, unknown>;
}>): SessionMutationDeadLetterEntry {
    return createDeadLetterEntry({
        sessionId: params.sessionId,
        kind: params.mutation.kind,
        reason: params.reason,
        mutationId: params.mutation.mutationId,
        attempts: params.mutation.attempts,
        createdAt: params.mutation.createdAt,
        dependencyMutationId: params.dependencyMutationId,
        diagnostic: params.diagnostic,
        payload: params.mutation.payload,
        ...(isAuthoritativeSessionMutation(params.mutation) ? { queuedMutation: params.mutation } : {}),
    });
}

export async function saveSessionMutationOutbox(sessionId: string, mutations: readonly QueuedSessionMutation[]): Promise<void> {
    const filePath = resolveSessionMutationOutboxPath(sessionId);
    if (mutations.length === 0) {
        await unlink(filePath).catch((error) => {
            const err = error as NodeJS.ErrnoException;
            if (err?.code !== 'ENOENT') throw error;
        });
        return;
    }
    await writeJsonAtomic(filePath, { v: 1, mutations } satisfies SessionMutationOutboxFileV1);
}
