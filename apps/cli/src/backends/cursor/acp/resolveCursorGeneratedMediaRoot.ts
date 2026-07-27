import { homedir as osHomedir } from 'node:os';
import { posix, win32 } from 'node:path';

function resolveHomeDirectory(input: Readonly<{
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: () => string;
}>): string | null {
  const candidates = input.platform === 'win32'
    ? [
        input.env.USERPROFILE,
        input.env.HOMEDRIVE && input.env.HOMEPATH
          ? `${input.env.HOMEDRIVE}${input.env.HOMEPATH}`
          : undefined,
        input.env.HOME,
        input.homedir(),
      ]
    : [input.env.HOME, input.homedir()];
  const value = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
  return typeof value === 'string' ? value.trim() : null;
}

function cursorProjectDirectoryName(directory: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  return pathApi
    .normalize(pathApi.resolve(directory))
    .replace(/[^A-Za-z0-9]/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function resolveCursorGeneratedMediaRoot(input: Readonly<{
  directory: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}>): string | null {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const homeDirectory = resolveHomeDirectory({
    env,
    platform,
    homedir: input.homedir ?? osHomedir,
  });
  const projectDirectoryName = cursorProjectDirectoryName(input.directory, platform);
  if (!homeDirectory || !projectDirectoryName) return null;

  const pathApi = platform === 'win32' ? win32 : posix;
  return pathApi.join(homeDirectory, '.cursor', 'projects', projectDirectoryName, 'assets');
}
