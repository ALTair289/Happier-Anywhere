export type OpenCodeManagedServerLogSource = 'stdout' | 'stderr';

/**
 * Header facts written at the top of each managed-server log. Contains NO environment values and
 * NO secrets/tokens — only command basename + CLI args (which carry hostname/port), endpoint, pids,
 * and the launch fingerprint (a hash).
 */
export type OpenCodeManagedServerLogHeader = Readonly<{
  commandBasename: string;
  args: readonly string[];
  hostname: string;
  port: number;
  spawnPid: number;
  baseUrl: string;
  launchFingerprint?: string;
  startedAtIso: string;
}>;

/**
 * Live capture handle for a managed `opencode serve` process. Teeing post-start stdout/stderr here
 * both DRAINS the child's pipes (so it never blocks on a full pipe) and PERSISTS the output for
 * later diagnosis. All methods are best-effort and never throw.
 */
export type OpenCodeManagedServerLogCapture = Readonly<{
  logPath: string;
  write: (source: OpenCodeManagedServerLogSource, chunk: Buffer | string) => void;
  recordTrackedPid: (pid: number) => void;
  recordNote: (note: string) => void;
  close: () => Promise<void>;
}>;
