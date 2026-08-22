import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import { resolveCliTestLaunchSpec } from '../process/cliLaunchSpec';
import { runLoggedCommand } from '../process/spawnProcess';
import { repoRootDir } from '../paths';

export type JsonEnvelope = {
  ok: boolean;
  kind: string;
  data?: unknown;
  error?: unknown;
};

function pickLastJsonEnvelope(text: string): JsonEnvelope {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (!(line.startsWith('{') || line.startsWith('['))) continue;
    try {
      const parsed = JSON.parse(line) as JsonEnvelope;
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean' && typeof parsed.kind === 'string') {
        return parsed;
      }
    } catch {
      // keep scanning backwards
    }
  }
  throw new Error(`Failed to parse JSON envelope from CLI stdout: ${JSON.stringify(lines.slice(-20).join('\n'))}`);
}

function summarizeEnvelopeError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' && record.code.trim() ? record.code.trim() : 'unknown';
  const rawMessage = typeof record.message === 'string' ? record.message.trim() : '';
  const message = rawMessage
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .slice(0, 500);
  return message ? `${code}: ${message}` : code;
}

export async function runCliJson(params: Readonly<{
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  env: NodeJS.ProcessEnv;
  label: string;
  args: string[];
  timeoutMs?: number;
  launchOptions?: Readonly<{
    preferSourceEntrypoint?: boolean;
    skipSourceFreshnessCheck?: boolean;
    skipSharedDepsBuild?: boolean;
  }>;
}>): Promise<JsonEnvelope> {
  const cliLaunchSpec = await resolveCliTestLaunchSpec(
    { testDir: params.testDir, env: params.env },
    {
      snapshotDir: resolvePath(join(params.testDir, 'cli-dist')),
      preferSourceEntrypoint: params.launchOptions?.preferSourceEntrypoint,
      skipSourceFreshnessCheck: params.launchOptions?.skipSourceFreshnessCheck,
    },
  );
  const stdoutPath = resolvePath(join(params.testDir, `cli.${params.label}.stdout.log`));
  const stderrPath = resolvePath(join(params.testDir, `cli.${params.label}.stderr.log`));
  const env = {
    ...params.env,
    ...(params.launchOptions?.skipSharedDepsBuild
      ? {
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        }
      : {}),
  };

  let commandError: Error | null = null;
  try {
    await runLoggedCommand({
      command: cliLaunchSpec.command,
      args: [...cliLaunchSpec.args, ...params.args],
      cwd: repoRootDir(),
      env: {
        ...env,
        ...(cliLaunchSpec.env ?? {}),
        CI: '1',
        HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
        HAPPIER_HOME_DIR: params.cliHomeDir,
        HAPPIER_SERVER_URL: params.serverUrl,
        HAPPIER_WEBAPP_URL: params.webappUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
      },
      stdoutPath,
      stderrPath,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    commandError = error instanceof Error ? error : new Error(String(error));
  }

  const stdoutText = await readFile(stdoutPath, 'utf8').catch(() => '');
  let envelope: JsonEnvelope;
  try {
    envelope = pickLastJsonEnvelope(stdoutText);
  } catch (parseError) {
    if (!commandError) throw parseError;
    const parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(
      `${commandError.message}; ${parseMessage}; stdoutPath=${stdoutPath}; stderrPath=${stderrPath}`,
    );
  }

  if (commandError) {
    throw new Error(
      `${commandError.message}; CLI JSON error=${summarizeEnvelopeError(envelope.error)}; ` +
        `stdoutPath=${stdoutPath}; stderrPath=${stderrPath}`,
    );
  }

  return envelope;
}
