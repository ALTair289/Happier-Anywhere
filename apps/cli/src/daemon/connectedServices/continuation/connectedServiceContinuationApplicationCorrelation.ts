export type ConnectedServiceContinuationApplicationKey = Readonly<{
  sessionId: string;
  serviceId: string;
  groupId: string;
  profileId: string;
  generation: number;
}>;

function readCorrelationKeys(
  input: ConnectedServiceContinuationApplicationKey,
): Readonly<{ target: string; scope: string }> | null {
  const dimensions = [
    input.sessionId,
    input.serviceId,
    input.groupId,
    input.profileId,
  ];
  if (dimensions.some((value) => value.length === 0 || value.trim() !== value)) {
    return null;
  }
  if (!Number.isInteger(input.generation) || input.generation < 0) {
    return null;
  }
  return {
    target: JSON.stringify([...dimensions, input.generation]),
    scope: JSON.stringify(dimensions.slice(0, 3)),
  };
}

export function createConnectedServiceContinuationApplicationCorrelation<T>() {
  const pendingByTarget = new Map<string, T>();
  const targetByScope = new Map<string, Readonly<{
    target: string;
    generation: number;
  }>>();

  return {
    register(
      key: ConnectedServiceContinuationApplicationKey,
      continuation: T,
    ): boolean {
      const correlationKeys = readCorrelationKeys(key);
      if (correlationKeys === null || pendingByTarget.has(correlationKeys.target)) {
        return false;
      }
      const previous = targetByScope.get(correlationKeys.scope);
      if (previous !== undefined) {
        if (key.generation <= previous.generation) {
          return false;
        }
        pendingByTarget.delete(previous.target);
      }
      pendingByTarget.set(correlationKeys.target, continuation);
      targetByScope.set(correlationKeys.scope, {
        target: correlationKeys.target,
        generation: key.generation,
      });
      return true;
    },

    async settle(
      key: ConnectedServiceContinuationApplicationKey,
      settleContinuation: (continuation: T) => Promise<void>,
    ): Promise<boolean> {
      const correlationKeys = readCorrelationKeys(key);
      if (correlationKeys === null) return false;
      const continuation = pendingByTarget.get(correlationKeys.target);
      if (continuation === undefined) return false;
      await settleContinuation(continuation);
      if (pendingByTarget.get(correlationKeys.target) === continuation) {
        pendingByTarget.delete(correlationKeys.target);
      }
      return true;
    },
  };
}
