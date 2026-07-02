import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';
import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import {
  resolveHappierRuntimeContextEnv,
  type HappierRuntimeServerContext,
} from '@/utils/env/resolveHappierRuntimeContextEnv';
import { resolveStackProcessKindOverrideForSessionSpawn } from './resolveStackProcessKindOverrideForSessionSpawn';

type ChildServerSelectionEnv = HappierRuntimeServerContext;

export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
  serverSelectionEnv?: ChildServerSelectionEnv;
}): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv({ ...params.processEnv, ...params.extraEnv });
  delete env.HAPPIER_SESSION_AUTOSTART_DAEMON;

  if (String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() === 'background-service') {
    env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY] = '1';
  } else {
    delete env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY];
  }
  delete env.HAPPIER_DAEMON_RUNTIME_ID;
  delete env.HAPPIER_DAEMON_STARTUP_SOURCE;
  delete env.HAPPIER_DAEMON_TAKEOVER;

  delete env.HAPPIER_STACK_PROCESS_KIND;
  Object.assign(env, resolveStackProcessKindOverrideForSessionSpawn(env));

  if (params.serverSelectionEnv) {
    // Clear any stale inherited split URLs, then apply the authoritative selection
    // via the shared runtime-context resolver (single source of truth shared with
    // the coding-agent spawn seam). For a non-split stack the resolver omits the
    // local/public URLs, so they must be cleared here first.
    delete env.HAPPIER_PUBLIC_SERVER_URL;
    delete env.HAPPIER_LOCAL_SERVER_URL;
    Object.assign(env, resolveHappierRuntimeContextEnv({ server: params.serverSelectionEnv }));
  }

  return env;
}
