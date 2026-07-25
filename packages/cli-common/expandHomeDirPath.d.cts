export function resolveHomeDirFromEnvironment(
  processEnv?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): string;

export function expandHomeDirPath(
  value: string,
  processEnv?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): string;
