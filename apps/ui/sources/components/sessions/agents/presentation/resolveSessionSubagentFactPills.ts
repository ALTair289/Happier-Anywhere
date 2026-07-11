import { t } from '@/text';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { resolveSessionSubagentKindLabelKey } from './resolveSessionSubagentKindLabelKey';

const SUBAGENT_INTENT_LABEL_KEYS = {
    review: 'session.subagents.intent.review',
    plan: 'session.subagents.intent.plan',
    delegate: 'session.subagents.intent.delegate',
} as const;

function resolveKindLabel(subagent: SessionSubagent): string {
    return t(resolveSessionSubagentKindLabelKey(subagent.kind));
}

function resolveIntentLabel(intent: string | null | undefined): string | null {
    const normalized = typeof intent === 'string' ? intent.trim() : '';
    if (!normalized) return null;
    if (normalized === 'review' || normalized === 'plan' || normalized === 'delegate') {
        return t(SUBAGENT_INTENT_LABEL_KEYS[normalized]);
    }
    return normalized;
}

function formatDurationMs(durationMs: number): string {
    if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
    const seconds = durationMs / 1_000;
    if (seconds < 60) return `${Number(seconds.toFixed(1))}s`;
    const wholeMinutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return remainingSeconds > 0 ? `${wholeMinutes}m ${remainingSeconds}s` : `${wholeMinutes}m`;
}

export function resolveSessionSubagentFactPills(subagent: SessionSubagent): readonly string[] {
    const intentLabel = resolveIntentLabel(subagent.runRef?.intent);
    const nativeType = subagent.nativeRef?.customType?.trim() || subagent.nativeRef?.type?.trim() || null;
    const nativeModel = subagent.nativeRef?.model?.trim() || null;
    const nativeAgentId = subagent.nativeRef?.agentId?.trim() || null;
    const nativeDuration = typeof subagent.nativeRef?.durationMs === 'number'
        ? formatDurationMs(subagent.nativeRef.durationMs)
        : null;

    return [
        t('session.subagents.panel.typeFact', { value: resolveKindLabel(subagent) }),
        subagent.display.providerLabel?.trim()
            ? t('session.subagents.panel.providerFact', { value: subagent.display.providerLabel.trim() })
            : subagent.runRef?.backendId?.trim()
                ? t('session.subagents.panel.backendFact', { value: subagent.runRef.backendId.trim() })
                : null,
        intentLabel
            ? t('session.subagents.panel.intentFact', { value: intentLabel })
            : null,
        nativeType
            ? t('session.subagents.panel.nativeTypeFact', { value: nativeType })
            : null,
        nativeModel
            ? t('session.subagents.panel.modelFact', { value: nativeModel })
            : null,
        nativeAgentId
            ? t('session.subagents.panel.agentIdFact', { value: nativeAgentId })
            : null,
        nativeDuration
            ? t('session.subagents.panel.durationFact', { value: nativeDuration })
            : null,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}
