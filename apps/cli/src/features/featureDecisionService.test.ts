import { describe, expect, it } from 'vitest';
import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol';

import {
  resolveCliFeatureDecision,
  type CliServerFeaturesSnapshot,
} from './featureDecisionService';

function buildFeaturesResponse(): FeaturesResponse {
  return FeaturesResponseSchema.parse({
    features: {
      bugReports: { enabled: true },
      automations: {
        enabled: true,
      },
      connectedServices: {
        enabled: true,
        quotas: { enabled: false },
      },
    },
    capabilities: {},
  });
}

describe('resolveCliFeatureDecision', () => {
  it('enables bugReports when server and local policy enable the feature', () => {
    const snapshot: CliServerFeaturesSnapshot = {
      status: 'ready',
      features: buildFeaturesResponse(),
    };

    const decision = resolveCliFeatureDecision({
      featureId: 'bugReports',
      env: {} as NodeJS.ProcessEnv,
      serverSnapshot: snapshot,
    });

    expect(decision.state).toBe('enabled');
    expect(decision.blockedBy).toBeNull();
  });

  it('fails closed when the server features endpoint is missing', () => {
    const decision = resolveCliFeatureDecision({
      featureId: 'bugReports',
      env: {} as NodeJS.ProcessEnv,
      serverSnapshot: {
        status: 'unsupported',
        reason: 'endpoint_missing',
      },
    });

    expect(decision.state).toBe('unsupported');
    expect(decision.blockerCode).toBe('endpoint_missing');
  });

  it('disables automations when the local env gate is off', () => {
    const decision = resolveCliFeatureDecision({
      featureId: 'automations',
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'false',
      } as NodeJS.ProcessEnv,
    });

    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('local_policy');
  });

  it('disables automations when build policy denies the feature', () => {
    const decision = resolveCliFeatureDecision({
      featureId: 'automations',
      env: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: 'true',
        HAPPIER_BUILD_FEATURES_DENY: 'automations',
      } as NodeJS.ProcessEnv,
    });

    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('build_policy');
  });

  it('disables connectedServices.quotas when the server reports quotas disabled', () => {
    const snapshot: CliServerFeaturesSnapshot = {
      status: 'ready',
      features: buildFeaturesResponse(),
    };

    const decision = resolveCliFeatureDecision({
      featureId: 'connectedServices.quotas',
      env: {
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      } as NodeJS.ProcessEnv,
      serverSnapshot: snapshot,
    });

    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('server');
  });

  it('fails closed for pending delivery-state support when an old server only reports the basic pending queue gate', () => {
    const snapshot: CliServerFeaturesSnapshot = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sharing: {
            pendingQueueV2: { enabled: true },
          },
        },
        capabilities: {},
      }),
    };

    const decision = resolveCliFeatureDecision({
      featureId: 'sharing.pendingDeliveryState',
      env: {} as NodeJS.ProcessEnv,
      serverSnapshot: snapshot,
    });

    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('server');
  });

  // Unified mode is itself opt-in; the TUI runtime-control gate rides it and defaults ON.
  // The env flag is a KILL-SWITCH (set =0 to disable), not an enable switch.
  it('enables the Claude Unified TUI runtime-control gate by default (unified mode is the opt-in)', () => {
    const decision = resolveCliFeatureDecision({
      featureId: 'providers.claude.unifiedTerminal.tuiRuntimeControl',
      env: {} as NodeJS.ProcessEnv,
    });

    expect(decision.state).toBe('enabled');
    expect(decision.blockedBy).toBeNull();
  });

  it('disables the Claude Unified TUI runtime-control gate via the env kill-switch', () => {
    const decision = resolveCliFeatureDecision({
      featureId: 'providers.claude.unifiedTerminal.tuiRuntimeControl',
      env: {
        HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED: '0',
      } as NodeJS.ProcessEnv,
    });

    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('local_policy');
  });

  it('disables voice.agent when execution.runs dependency is locally disabled', () => {
    const decision = resolveCliFeatureDecision({
      featureId: 'voice.agent',
      env: {
        HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED: '0',
        HAPPIER_FEATURE_VOICE__ENABLED: '1',
      } as NodeJS.ProcessEnv,
    });

    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('dependency');
    expect(decision.blockerCode).toBe('dependency_disabled');
  });
});
