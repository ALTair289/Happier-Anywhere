import { join } from 'node:path';
import { expandHome } from '../paths/canonical_home.mjs';
import { applyEffectiveDbProviderEnv } from './effective_db_provider.mjs';

export function applyServerLightEnvDefaults({ baseEnv, serverEnv, baseDir }) {
  applyEffectiveDbProviderEnv({
    serverComponentName: 'happier-server-light',
    env: baseEnv,
    targetEnv: serverEnv,
  });
  delete serverEnv.DATABASE_URL;
  const dataDir = baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR?.trim()
    ? expandHome(baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR.trim(), baseEnv)
    : join(baseDir, 'server-light');
  serverEnv.HAPPIER_SERVER_LIGHT_DATA_DIR = dataDir;
  serverEnv.HAPPIER_SERVER_LIGHT_FILES_DIR = baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR?.trim()
    ? expandHome(baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR.trim(), baseEnv)
    : join(dataDir, 'files');
  serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR = baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR?.trim()
    ? expandHome(baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR.trim(), baseEnv)
    : join(dataDir, 'pglite');
}
