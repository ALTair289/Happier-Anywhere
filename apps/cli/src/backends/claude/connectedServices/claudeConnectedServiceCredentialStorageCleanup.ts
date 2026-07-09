import { join } from 'node:path';

import type { ConnectedServiceCredentialStorageCleanup } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { deleteClaudeCodeMacOsKeychainCredential } from './nativeAuth/claudeCodeMacOsKeychain';

export const claudeConnectedServiceCredentialStorageCleanup: ConnectedServiceCredentialStorageCleanup = {
  async deleteCredentialStorageForHomeRoot({ rootDir }) {
    if (process.platform !== 'darwin') return;
    await deleteClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: join(rootDir, 'claude-config'),
    });
  },
};
