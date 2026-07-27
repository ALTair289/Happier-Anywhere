import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePiConnectedServiceSwitchContinuity } from './resolvePiConnectedServiceSwitchContinuity';

const MATERIALIZATION_IDENTITY = {
  v: 1 as const,
  id: 'csm_1',
  createdAtMs: 1,
};

describe('resolvePiConnectedServiceSwitchContinuity', () => {
  it('fails closed for restart_same_home when exact continuity lacks materialized-state reachability context', async () => {
    await expect(resolvePiConnectedServiceSwitchContinuity({
      sessionId: 'session-1',
      agentId: 'pi',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'same',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'same',
        groupId: null,
      },
      fromBindings: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', selection: 'profile', profileId: 'same' },
        },
      },
      toBindings: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', selection: 'profile', profileId: 'same' },
        },
      },
      connectedServiceMaterializationIdentityV1: MATERIALIZATION_IDENTITY,
      vendorResumeId: 'pi-session-1',
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
      diagnostics: {
        // Sanitized, secret-free presence summary of the missing required resume inputs. Identity
        // and vendor resume id are present here; the materialized root/env/cwd are absent.
        materializationIdentityId: null,
        targetMaterializedRoot: null,
        vendorResumeId: null,
        cwd: null,
        candidatePersistedSessionFile: null,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        reachabilityMissReason:
          'pi_resume_continuity_missing:target_materialized_root,target_materialized_env,cwd',
      },
    });
  });

  it('omits raw secrets from the sanitized missing-field diagnostics when no continuity context exists', async () => {
    // No materialization identity and no vendor resume id: fail-closed with presence-only booleans
    // and no raw home paths / resume ids / cwd echoed back.
    const result = await resolvePiConnectedServiceSwitchContinuity({
      sessionId: 'session-1',
      agentId: 'pi',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'openai',
        profileId: 'old',
        groupId: 'team',
      },
      nextBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'openai',
        profileId: 'new',
        groupId: 'team',
      },
      fromBindings: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', selection: 'group', profileId: 'old', groupId: 'team' },
        },
      },
      toBindings: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', selection: 'group', profileId: 'new', groupId: 'team' },
        },
      },
      cwd: '/tmp/secret-project',
      targetMaterializedRoot: '/tmp/secret-home',
    });

    expect(result).toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
      diagnostics: {
        materializationIdentityId: null,
        targetMaterializedRoot: null,
        vendorResumeId: null,
        cwd: null,
        candidatePersistedSessionFile: null,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        reachabilityMissReason:
          'pi_resume_continuity_missing:materialization_identity,target_materialized_env,vendor_resume_id',
      },
    });
    // Defense in depth: the raw secret-bearing values must never appear in the diagnostics.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('/tmp/secret-home');
    expect(serialized).not.toContain('/tmp/secret-project');
  });

  it('returns restart_same_home when exact continuity has a reachable PI session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-continuity-'));
    try {
      const sessionPath = join(
        root,
        'pi-agent-dir',
        'sessions',
        '--tmp-project--',
        '2026-05-27T00-00-00-000Z_pi-session-1.jsonl',
      );
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(sessionPath, '{}\n');

      await expect(resolvePiConnectedServiceSwitchContinuity({
        sessionId: 'session-1',
        agentId: 'pi',
        serviceId: 'openai',
        previousBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'openai',
          profileId: 'old',
          groupId: 'team',
        },
        nextBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'openai',
          profileId: 'new',
          groupId: 'team',
        },
        fromBindings: {
          v: 1,
          bindingsByServiceId: {
            openai: { source: 'connected', selection: 'group', profileId: 'old', groupId: 'team' },
          },
        },
        toBindings: {
          v: 1,
          bindingsByServiceId: {
            openai: { source: 'connected', selection: 'group', profileId: 'new', groupId: 'team' },
          },
        },
        connectedServiceMaterializationIdentityV1: MATERIALIZATION_IDENTITY,
        vendorResumeId: 'pi-session-1',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        cwd: '/tmp/project',
      })).resolves.toEqual({ mode: 'restart_same_home' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns daemon-safe diagnostics when exact continuity cannot find the PI session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-continuity-missing-'));
    try {
      const candidate = join(root, 'source', 'missing-session.jsonl');

      await expect(resolvePiConnectedServiceSwitchContinuity({
        sessionId: 'session-1',
        agentId: 'pi',
        serviceId: 'openai',
        previousBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'openai',
          profileId: 'old',
          groupId: 'team',
        },
        nextBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'openai',
          profileId: 'new',
          groupId: 'team',
        },
        fromBindings: {
          v: 1,
          bindingsByServiceId: {
            openai: { source: 'connected', selection: 'group', profileId: 'old', groupId: 'team' },
          },
        },
        toBindings: {
          v: 1,
          bindingsByServiceId: {
            openai: { source: 'connected', selection: 'group', profileId: 'new', groupId: 'team' },
          },
        },
        connectedServiceMaterializationIdentityV1: MATERIALIZATION_IDENTITY,
        vendorResumeId: 'pi-session-missing',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
      })).resolves.toMatchObject({
        mode: 'unsupported',
        reason: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          materializationIdentityId: 'csm_1',
          targetMaterializedRoot: root,
          vendorResumeId: 'pi-session-missing',
          candidatePersistedSessionFile: candidate,
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps non-exact connected switches on shared-state-required continuity', async () => {
    await expect(resolvePiConnectedServiceSwitchContinuity({
      sessionId: 'session-1',
      agentId: 'pi',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'new',
        groupId: null,
      },
      fromBindings: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', selection: 'profile', profileId: 'old' },
        },
      },
      toBindings: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', selection: 'profile', profileId: 'new' },
        },
      },
      connectedServiceMaterializationIdentityV1: MATERIALIZATION_IDENTITY,
      vendorResumeId: 'pi-session-1',
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'pi_exact_connected_service_selection_required',
    });
  });

  it('uses the request-time broker boundary for a brokered different-member switch', async () => {
    await expect(resolvePiConnectedServiceSwitchContinuity({
      sessionId: 'session-1',
      agentId: 'pi',
      serviceId: 'openai-codex',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai-codex',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai-codex',
        profileId: 'new',
        groupId: null,
      },
      fromBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old' },
        },
      },
      toBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'new' },
        },
      },
      runtimeAuthSelection: {
        brokerSelectionIdentity: 'pi|connected|broker:1|openai-codex:acct-old:',
      },
      connectedServiceMaterializationIdentityV1: MATERIALIZATION_IDENTITY,
      vendorResumeId: 'pi-session-1',
    })).resolves.toEqual({ mode: 'hot_apply' });
  });
});
