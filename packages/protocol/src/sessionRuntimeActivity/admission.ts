import type { SessionRuntimeActivityProjection } from './projection.js';

export type RuntimeIdleAdmission =
  | Readonly<{
      decision: 'allow';
      revision: number;
    }>
  | Readonly<{
      decision: 'defer';
      reason: 'active' | 'unknown';
      revision: number;
    }>;

export function decideRuntimeIdleAdmission(
  projection: SessionRuntimeActivityProjection,
): RuntimeIdleAdmission {
  if (projection.state === 'idle') {
    return {
      decision: 'allow',
      revision: projection.revision,
    };
  }

  return {
    decision: 'defer',
    reason: projection.state,
    revision: projection.revision,
  };
}
