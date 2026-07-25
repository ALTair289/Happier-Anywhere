import {
    CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
    parseClientCompatibilityHttpHeadersV1,
} from '@happier-dev/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { evaluateSessionSyncCompatibility } from './decision';
import { resolveSessionSyncCompatibilityPolicy } from './policy';
import { recordSessionSyncCompatibilityDecision } from './telemetry';

export function createSessionSyncCompatibilityHttpPreHandler(
    readEnv: () => NodeJS.ProcessEnv = () => process.env,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
    return async (request, reply): Promise<void> => {
        const evaluation = evaluateSessionSyncCompatibility(
            parseClientCompatibilityHttpHeadersV1(request.headers),
            resolveSessionSyncCompatibilityPolicy(readEnv()),
        );
        recordSessionSyncCompatibilityDecision('http', evaluation);
        request.sessionSyncCompatibility = evaluation;
        if (!evaluation.accepted && evaluation.upgradeRequired !== null) {
            await reply.code(CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).send(evaluation.upgradeRequired);
        }
    };
}

export async function enforceSessionSyncCompatibilityForHttpRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    env: NodeJS.ProcessEnv,
): Promise<boolean> {
    const handler = createSessionSyncCompatibilityHttpPreHandler(() => env);
    await handler(request, reply);
    return !reply.sent;
}
