import { configuration } from '@/configuration';

type SessionHeartbeatMode = 'local' | 'remote';

type StartSessionHeartbeatLoopOptions = Readonly<{
  getThinking: () => boolean;
  getMode: () => SessionHeartbeatMode;
  keepAlive: (thinking: boolean, mode: SessionHeartbeatMode) => void;
}>;

export function startSessionHeartbeatLoop(
  options: StartSessionHeartbeatLoopOptions,
): ReturnType<typeof setInterval> {
  const sendHeartbeat = (): void => {
    options.keepAlive(options.getThinking(), options.getMode());
  };

  sendHeartbeat();
  let lastHeartbeatSentAt = Date.now();
  const tickIntervalMs = Math.min(
    configuration.sessionKeepAliveIdleMs,
    configuration.sessionKeepAliveThinkingMs,
  );
  const heartbeatInterval = setInterval(() => {
    const cadenceMs = options.getThinking()
      ? configuration.sessionKeepAliveThinkingMs
      : configuration.sessionKeepAliveIdleMs;
    const now = Date.now();
    if (now - lastHeartbeatSentAt < cadenceMs) return;

    sendHeartbeat();
    lastHeartbeatSentAt = now;
  }, tickIntervalMs);
  heartbeatInterval.unref?.();
  return heartbeatInterval;
}
