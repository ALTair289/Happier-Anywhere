import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import {
    fetchSessionFolderAssignmentsForSessions as fetchOrganizationAssignmentsForSessions,
    moveSessionFolderAssignments as moveOrganizationSessionFolderAssignments,
    setSessionFolderAssignment as setOrganizationSessionFolderAssignment,
} from '@/sync/api/session/sessionOrganizationApi';
import { serverFetch } from '@/sync/http/client';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    MoveSessionFolderAssignmentsResponseSchema,
    QuerySessionFolderSessionsResponseSchema,
    SetSessionFolderAssignmentResponseSchema,
    type MoveSessionFolderAssignmentsResponse,
    type QuerySessionFolderSessionsResponse,
    type SessionFolderAssignment,
    type SetSessionFolderAssignmentResponse,
} from '@happier-dev/protocol/sessionFolders';
import type { SessionFolderAssignmentListResponse } from '@happier-dev/protocol';
import type { z } from 'zod';

export type SessionFolderAssignmentResponse = SessionFolderAssignment;

function buildServerScopedPath(serverUrl: string | null | undefined, path: string): string {
    const base = String(serverUrl ?? '').trim();
    if (!base) return path;
    return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeServerUrl(serverUrl: string | null | undefined): string {
    return String(serverUrl ?? '').trim().replace(/\/+$/, '');
}

async function readJsonBody(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function parseJsonBody<T>(raw: unknown, schema: z.ZodType<T>, fallbackMessage: string): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        throw new HappyError(fallbackMessage, false);
    }
    return parsed.data;
}

function readErrorMessage(raw: unknown, fallbackMessage: string): string {
    if (raw && typeof raw === 'object' && typeof (raw as { error?: unknown }).error === 'string') {
        return (raw as { error: string }).error;
    }
    return fallbackMessage;
}

async function parseJsonResponse<T>(response: Response, schema: z.ZodType<T>, fallbackMessage: string): Promise<T> {
    const raw = await readJsonBody(response);
    if (!response.ok) {
        throw new HappyError(readErrorMessage(raw, fallbackMessage), false);
    }
    return parseJsonBody(raw, schema, fallbackMessage);
}

function authHeaders(credentials: AuthCredentials): Record<string, string> {
    return {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
    };
}

async function fetchSessionFolderAssignmentRoute(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    path: string;
    init: RequestInit;
}>): Promise<Response> {
    const serverUrl = normalizeServerUrl(params.serverUrl);
    if (serverUrl) {
        return runtimeFetchWithServerReachability({
            serverUrl,
            token: params.credentials.token,
            url: buildServerScopedPath(serverUrl, params.path),
            init: params.init,
        });
    }
    return serverFetch(params.path, params.init, { includeAuth: false });
}

export async function fetchSessionFolderAssignmentsForSessions(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    sessionIds: readonly string[];
}>): Promise<SessionFolderAssignmentListResponse> {
    return fetchOrganizationAssignmentsForSessions(params);
}

export async function setSessionFolderAssignment(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    sessionId: string;
    folderId: string | null;
}>): Promise<SetSessionFolderAssignmentResponse> {
    return SetSessionFolderAssignmentResponseSchema.parse(await setOrganizationSessionFolderAssignment({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        sessionId: params.sessionId,
        request: { folderId: params.folderId },
    }));
}

export async function querySessionsByFolderScope(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    folderIds: readonly string[];
    includeArchived?: boolean;
    cursor?: string | null;
    limit?: number;
}>): Promise<QuerySessionFolderSessionsResponse> {
    const response = await fetchSessionFolderAssignmentRoute({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        path: '/v2/session-folder-assignments/query',
        init: {
            method: 'POST',
            headers: authHeaders(params.credentials),
            body: JSON.stringify({
                folderIds: params.folderIds,
                archived: params.includeArchived ?? false,
                cursor: params.cursor ?? null,
                limit: params.limit,
            }),
        },
    });
    return parseJsonResponse(response, QuerySessionFolderSessionsResponseSchema, 'Failed to query session folder scope');
}

export async function moveSessionFolderAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverUrl?: string;
    fromFolderIds: readonly string[];
    toFolderId: string | null;
}>): Promise<MoveSessionFolderAssignmentsResponse> {
    return MoveSessionFolderAssignmentsResponseSchema.parse(await moveOrganizationSessionFolderAssignments({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        request: {
            fromFolderIds: [...params.fromFolderIds],
            toFolderId: params.toFolderId,
        },
    }));
}
