import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import {
  persistMemberRuntimeStateWithPositiveEvidence,
  type ConnectedServiceAuthGroupPositiveEvidence,
} from '../accountGroups/memberRuntimeState';
import { normalizeConnectedServiceAuthGroupPolicy } from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import type { BoundProfile } from './refreshTypes';

export async function clearRegisteredGroupMemberRuntimeStateWithPositiveEvidence(input: Readonly<{
  api: ApiClient;
  runtimeRegistry: ConnectedServiceRuntimeRegistry;
  binding: BoundProfile;
  evidence: ConnectedServiceAuthGroupPositiveEvidence;
}>): Promise<void> {
  if (
    typeof input.api.getConnectedServiceAuthGroup !== 'function'
    || typeof input.api.updateConnectedServiceAuthGroupRuntimeState !== 'function'
  ) {
    return;
  }
  const candidates = new Map<string, Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    generation: number;
  }>>();
  for (const target of input.runtimeRegistry.listTargets()) {
    for (const active of target.activeBindings) {
      if (active.serviceId !== input.binding.serviceId) continue;
      if (active.profileId !== input.binding.profileId) continue;
      if (!active.groupId || active.generation === null) continue;
      candidates.set(`${active.serviceId}\0${active.groupId}\0${active.profileId}\0${active.generation}`, {
        serviceId: active.serviceId,
        groupId: active.groupId,
        profileId: active.profileId,
        generation: active.generation,
      });
    }
  }

  for (const candidate of candidates.values()) {
    await persistMemberRuntimeStateWithPositiveEvidence({
      api: input.api,
      serviceId: candidate.serviceId,
      groupId: candidate.groupId,
      profileId: candidate.profileId,
      generation: candidate.generation,
      evidence: input.evidence,
      normalizePolicy: normalizeConnectedServiceAuthGroupPolicy,
    }).catch(() => null);
  }
}
