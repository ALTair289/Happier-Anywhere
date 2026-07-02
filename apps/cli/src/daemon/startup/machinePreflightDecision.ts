import type { DaemonStartupSource } from '@/daemon/ownership/daemonOwnershipMetadata';

export type StartDaemonMachinePreflightDecision =
  | 'stop_current_daemon'
  | 'skip_sync_preflight_for_self_restart'
  | 'run_sync_preflight';

export function resolveStartDaemonMachinePreflightDecision(params: Readonly<{
  runningDaemonVersionMatches: boolean;
  startupSource: DaemonStartupSource;
}>): StartDaemonMachinePreflightDecision {
  if (params.startupSource === 'self-restart') {
    return 'skip_sync_preflight_for_self_restart';
  }
  if (!params.runningDaemonVersionMatches) {
    return 'stop_current_daemon';
  }
  return 'run_sync_preflight';
}
