import type { TerminalHostAdapter, TerminalHostHandle, TerminalHostLiveness } from './_types';

export type TerminalHostRecoveryProbeResult = Readonly<{
  liveness: TerminalHostLiveness | null;
  inconclusiveProbeCount: number;
}>;

export async function evaluateTerminalHostLivenessForRecovery(
  adapter: TerminalHostAdapter,
  handle: TerminalHostHandle,
): Promise<TerminalHostRecoveryProbeResult> {
  const first = await adapter.evaluateLiveness(handle).catch(() => null);
  if (first?.probeInconclusive !== true) {
    return {
      liveness: first,
      inconclusiveProbeCount: 0,
    };
  }

  const second = await adapter.evaluateLiveness(handle).catch(() => null);
  return {
    liveness: second ?? first,
    inconclusiveProbeCount: second?.probeInconclusive === true ? 2 : 1,
  };
}

export function shouldDiscardTerminalAttachmentAfterRecoveryProbe(
  result: TerminalHostRecoveryProbeResult,
): boolean {
  if (result.liveness?.paneAlive === true) return false;
  if (result.liveness?.probeInconclusive === true) {
    return result.inconclusiveProbeCount >= 2;
  }
  return true;
}

export function isTerminalHostConfirmedDeadForRelaunch(
  result: TerminalHostRecoveryProbeResult,
): boolean {
  return result.liveness?.paneAlive === false && result.liveness.probeInconclusive !== true;
}
