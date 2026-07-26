import { beforeEach, describe, expect, it } from 'vitest';

import {
  isBrokerBridgeCurrentGroupTruthCompatible,
  markBrokerBridgeEffectiveSelectionUnavailable,
  resetBrokerBridgeEffectiveSelectionsForTests,
  updateBrokerBridgeEffectiveSelection,
} from './brokerBridgeEffectiveSelectionRegistry';

describe('isBrokerBridgeCurrentGroupTruthCompatible', () => {
  beforeEach(() => {
    resetBrokerBridgeEffectiveSelectionsForTests();
  });

  const currentTruth = {
    selectionIdentity: 'pi|connected|broker:1|openai-codex:batiplus:',
    serviceId: 'openai-codex' as const,
    groupId: 'codex-group',
    generation: 7,
    credentialRevision: 'csr_currentcurrentcurrentcurr',
  };

  it('accepts exact materialized startup truth before the request-time broker cache is populated', () => {
    expect(isBrokerBridgeCurrentGroupTruthCompatible(currentTruth)).toBe(true);
  });

  it('rejects a populated broker selection that conflicts with current truth', () => {
    updateBrokerBridgeEffectiveSelection({
      selectionIdentity: currentTruth.selectionIdentity,
      serviceId: currentTruth.serviceId,
      selection: {
        kind: 'group',
        serviceId: currentTruth.serviceId,
        groupId: currentTruth.groupId,
        activeProfileId: 'stale-profile',
        fallbackProfileId: 'batiplus',
        generation: currentTruth.generation - 1,
        credentialRevision: 'csr_stalestalestalestalestal',
        credentialFingerprint: 'sha256:deadbeef',
      },
    });

    expect(isBrokerBridgeCurrentGroupTruthCompatible(currentTruth)).toBe(false);
  });

  it('keeps exact populated broker truth compatible on a repeated registration', () => {
    updateBrokerBridgeEffectiveSelection({
      selectionIdentity: currentTruth.selectionIdentity,
      serviceId: currentTruth.serviceId,
      selection: {
        kind: 'group',
        serviceId: currentTruth.serviceId,
        groupId: currentTruth.groupId,
        activeProfileId: 'batiplus',
        fallbackProfileId: 'batiplus',
        generation: currentTruth.generation,
        credentialRevision: currentTruth.credentialRevision,
        credentialFingerprint: 'sha256:cafefeed',
      },
    });

    expect(isBrokerBridgeCurrentGroupTruthCompatible(currentTruth)).toBe(true);
  });

  it('does not let missing-cache startup semantics override an explicit unavailable group', () => {
    markBrokerBridgeEffectiveSelectionUnavailable({
      selectionIdentity: currentTruth.selectionIdentity,
      serviceId: currentTruth.serviceId,
      groupId: currentTruth.groupId,
      unavailableReason: 'active_profile_missing',
    });

    expect(isBrokerBridgeCurrentGroupTruthCompatible(currentTruth)).toBe(false);
  });
});
