import type { TerminalHostAdapter, TerminalHostHandle, TerminalHostLiveness } from './_types';
import { sanitizeTerminalHostDiagnosticText } from './sanitizeTerminalHostDiagnosticText';

export type TerminalHostRecoveryProbeResult =
  | Readonly<{ status: 'alive'; liveness: TerminalHostLiveness; probeCount: number }>
  | Readonly<{ status: 'dead'; liveness: TerminalHostLiveness; probeCount: number }>
  | Readonly<{ status: 'inconclusive'; liveness: TerminalHostLiveness; probeCount: number }>;

export type TerminalHostConfirmedDeadProbeResult = Extract<
  TerminalHostRecoveryProbeResult,
  { status: 'dead' }
>;

function inconclusiveLivenessFromProbeError(error: unknown): TerminalHostLiveness {
  const message = error instanceof Error ? error.message : String(error);
  return {
    paneAlive: false,
    probeInconclusive: true,
    paneScreenDumpError: sanitizeTerminalHostDiagnosticText(message),
    observedAt: Date.now(),
  };
}

async function evaluateOnce(
  adapter: TerminalHostAdapter,
  handle: TerminalHostHandle,
): Promise<TerminalHostLiveness> {
  try {
    return await adapter.evaluateLiveness(handle);
  } catch (error) {
    return inconclusiveLivenessFromProbeError(error);
  }
}

function classifyRecoveryProbe(
  liveness: TerminalHostLiveness,
  probeCount: number,
): TerminalHostRecoveryProbeResult {
  if (liveness.probeInconclusive === true) {
    return { status: 'inconclusive', liveness, probeCount };
  }
  return liveness.paneAlive
    ? { status: 'alive', liveness, probeCount }
    : { status: 'dead', liveness, probeCount };
}

export async function evaluateTerminalHostLivenessForRecovery(
  adapter: TerminalHostAdapter,
  handle: TerminalHostHandle,
): Promise<TerminalHostRecoveryProbeResult> {
  const first = await evaluateOnce(adapter, handle);
  const firstResult = classifyRecoveryProbe(first, 1);
  if (firstResult.status !== 'inconclusive') return firstResult;

  const second = await evaluateOnce(adapter, handle);
  return classifyRecoveryProbe(second, 2);
}

export function isTerminalHostConfirmedDeadForRelaunch(
  result: TerminalHostRecoveryProbeResult,
): result is TerminalHostConfirmedDeadProbeResult {
  return result.status === 'dead';
}
