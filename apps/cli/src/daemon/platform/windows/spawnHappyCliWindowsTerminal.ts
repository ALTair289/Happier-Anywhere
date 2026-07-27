import { startProcessInWindowsTerminal } from '@/terminal/windows/windowsTerminalProcess';

export async function startHappySessionInWindowsTerminal(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  windowId: string;
  title: string;
}): Promise<{ ok: true; pid: number } | { ok: false; errorMessage: string }> {
  return await startProcessInWindowsTerminal({
    ...params,
    inheritParentEnv: false,
  });
}
