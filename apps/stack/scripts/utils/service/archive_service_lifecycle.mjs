import { existsSync } from 'node:fs';
import {
  inspectServiceRegistration,
  resolveServiceBackend,
  resolveServiceDefinitionPath,
} from '@happier-dev/cli-common/service';

export function resolveStackServiceDefinitionCandidates({ platform = process.platform, homeDir, label } = {}) {
  const home = String(homeDir ?? '').trim();
  const serviceLabel = String(label ?? '').trim();
  if (!home) throw new Error('[stack] archive service cleanup requires a home directory');
  if (!serviceLabel) throw new Error('[stack] archive service cleanup requires a service label');

  const modes = platform === 'darwin' ? ['user'] : platform === 'linux' || platform === 'win32' ? ['user', 'system'] : null;
  if (!modes) throw new Error(`[stack] archive service cleanup is unsupported on platform: ${platform}`);
  return modes.map((mode) => ({
    mode,
    path: resolveServiceDefinitionPath({ platform, mode, homeDir: home, label: serviceLabel }),
  }));
}

export async function disableInstalledStackServicesBeforeArchive({
  rootDir,
  stackName,
  platform = process.platform,
  homeDir,
  label = stackName === 'main' ? 'dev.happier.stack' : `dev.happier.stack.${stackName}`,
  definitionCandidates = resolveStackServiceDefinitionCandidates({ platform, homeDir, label }),
  definitionExists = (path) => existsSync(path),
  inspectRegistration = ({ mode }) => inspectServiceRegistration({
    backend: resolveServiceBackend({ platform, mode }),
    label,
  }),
  uninstallStackService,
} = {}) {
  if (typeof uninstallStackService !== 'function') {
    throw new Error('[stack] archive service cleanup requires the canonical service uninstall owner');
  }

  const removedModes = [];
  for (const candidate of definitionCandidates) {
    const hasDefinition = definitionExists(candidate.path);
    // Missing files are not proof of absence because historical teardown swallowed OS failures.
    // Definition files are also not proof of registration. Query every candidate read-only so the
    // canonical uninstall owner can remove an absent job's stale definition without teardown mutation.
    // eslint-disable-next-line no-await-in-loop
    const registration = await inspectRegistration({ mode: candidate.mode, path: candidate.path });
    if (!hasDefinition && registration !== 'registered') continue;
    // eslint-disable-next-line no-await-in-loop
    await uninstallStackService({
      rootDir,
      stackName,
      svcCmd: 'uninstall',
      args: [`--mode=${candidate.mode}`],
    });
    removedModes.push(candidate.mode);
  }
  return { removedModes };
}
