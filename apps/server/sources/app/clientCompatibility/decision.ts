import {
    CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
    classifySessionSyncProtocolCompatibility,
    type ClientCompatibilityDeclarationParseResult,
    type ClientCompatibilityDeclarationV1,
    type ClientKind,
    type ClientUpgradeRequiredV1,
} from '@happier-dev/protocol';

import type { SessionSyncCompatibilityPolicy } from './policy';
import { isAppVersionAtLeastMinimum } from './versionDecision';

export type SessionSyncCompatibilityOutcome =
    | 'accepted'
    | 'observe-missing'
    | 'observe-malformed'
    | 'observe-protocol-too-old'
    | 'observe-app-version-too-old'
    | 'observe-client-kind-mismatch'
    | 'observe-policy-invalid'
    | 'reject-missing'
    | 'reject-malformed'
    | 'reject-protocol-too-old'
    | 'reject-app-version-too-old'
    | 'reject-client-kind-mismatch'
    | 'reject-policy-invalid';

export interface SessionSyncCompatibilityEvaluationConstraints {
    readonly allowedClientKinds?: readonly ClientKind[];
}

export interface SessionSyncCompatibilityEvaluation {
    readonly accepted: boolean;
    readonly outcome: SessionSyncCompatibilityOutcome;
    readonly declaration: ClientCompatibilityDeclarationV1 | null;
    readonly upgradeRequired: ClientUpgradeRequiredV1 | null;
}

function buildUpgradeRequired(
    declaration: ClientCompatibilityDeclarationV1 | null,
    policy: SessionSyncCompatibilityPolicy,
): ClientUpgradeRequiredV1 {
    const clientKind = declaration?.clientKind ?? null;
    return {
        error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
        requirement: {
            v: 1,
            minimumSessionSyncProtocolVersion: policy.requirements.minimumSessionSyncProtocolVersion,
            clientKind,
            minimumAppVersion: clientKind === null
                ? null
                : policy.requirements.minimumVersionsByClientKind?.[clientKind] ?? null,
            updateUrl: clientKind === null
                ? null
                : policy.requirements.upgradeUrlsByClientKind?.[clientKind] ?? null,
        },
    };
}

function isAppVersionSupported(
    declaration: ClientCompatibilityDeclarationV1,
    policy: SessionSyncCompatibilityPolicy,
): boolean {
    const minimum = policy.requirements.minimumVersionsByClientKind?.[declaration.clientKind];
    if (minimum === undefined) return true;
    return isAppVersionAtLeastMinimum(declaration.appVersion, minimum);
}

export function evaluateSessionSyncCompatibility(
    parseResult: ClientCompatibilityDeclarationParseResult,
    policy: SessionSyncCompatibilityPolicy,
    constraints: SessionSyncCompatibilityEvaluationConstraints = {},
): SessionSyncCompatibilityEvaluation {
    const required = policy.requestedEnforcement === 'required';
    if (!policy.valid) {
        return {
            accepted: !required,
            outcome: required ? 'reject-policy-invalid' : 'observe-policy-invalid',
            declaration: parseResult.status === 'valid' ? parseResult.declaration : null,
            upgradeRequired: required
                ? buildUpgradeRequired(parseResult.status === 'valid' ? parseResult.declaration : null, policy)
                : null,
        };
    }
    if (parseResult.status === 'missing') {
        return {
            accepted: !required,
            outcome: required ? 'reject-missing' : 'observe-missing',
            declaration: null,
            upgradeRequired: required ? buildUpgradeRequired(null, policy) : null,
        };
    }
    if (parseResult.status === 'malformed') {
        return {
            accepted: !required,
            outcome: required ? 'reject-malformed' : 'observe-malformed',
            declaration: null,
            upgradeRequired: required ? buildUpgradeRequired(null, policy) : null,
        };
    }

    if (
        constraints.allowedClientKinds !== undefined
        && !constraints.allowedClientKinds.includes(parseResult.declaration.clientKind)
    ) {
        return {
            accepted: !required,
            outcome: required ? 'reject-client-kind-mismatch' : 'observe-client-kind-mismatch',
            declaration: parseResult.declaration,
            upgradeRequired: required ? buildUpgradeRequired(null, policy) : null,
        };
    }

    if (
        (parseResult.declaration.clientKind === 'daemon' || parseResult.declaration.clientKind === 'session-runner')
        && policy.requirements.minimumVersionsByClientKind?.[parseResult.declaration.clientKind] === undefined
        && required
    ) {
        return {
            accepted: false,
            outcome: 'reject-policy-invalid',
            declaration: parseResult.declaration,
            upgradeRequired: buildUpgradeRequired(parseResult.declaration, policy),
        };
    }

    const protocolDecision = classifySessionSyncProtocolCompatibility(
        parseResult.declaration.sessionSyncProtocolVersion,
        policy.requirements.minimumSessionSyncProtocolVersion,
    );
    if (protocolDecision === 'older' || protocolDecision === 'malformed' || protocolDecision === 'missing') {
        return {
            accepted: !required,
            outcome: required ? 'reject-protocol-too-old' : 'observe-protocol-too-old',
            declaration: parseResult.declaration,
            upgradeRequired: required ? buildUpgradeRequired(parseResult.declaration, policy) : null,
        };
    }
    if (!isAppVersionSupported(parseResult.declaration, policy)) {
        return {
            accepted: !required,
            outcome: required ? 'reject-app-version-too-old' : 'observe-app-version-too-old',
            declaration: parseResult.declaration,
            upgradeRequired: required ? buildUpgradeRequired(parseResult.declaration, policy) : null,
        };
    }

    return {
        accepted: true,
        outcome: 'accepted',
        declaration: parseResult.declaration,
        upgradeRequired: null,
    };
}
