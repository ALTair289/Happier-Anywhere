import { beforeEach, describe, expect, it, vi } from 'vitest';

import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';

import { createDefaultVoiceQaControllerDeps } from './voiceQaRuntimeDeps';

describe('createDefaultVoiceQaControllerDeps', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards exact transcript-custody directives to the canonical voice session writer', async () => {
    const sendTurn = vi
      .spyOn(voiceAgentSessions, 'sendTurn')
      .mockResolvedValue({ assistantText: 'ok', actions: [] });
    const deps = createDefaultVoiceQaControllerDeps();
    const persist = {
      userTranscript: {
        mode: 'persist',
        localId: ' durable-outer-id ',
      },
    } as const;
    const suppress = {
      userTranscript: {
        mode: 'suppress',
      },
    } as const;

    await deps.sendLocalTurn('voice-hidden-s1', 'Outer prompt', persist);
    await deps.sendLocalTurn('voice-hidden-s1', 'VOICE_TOOL_RESULTS_JSON: {}', suppress);

    expect(sendTurn).toHaveBeenNthCalledWith(
      1,
      'voice-hidden-s1',
      'Outer prompt',
      persist,
    );
    expect(sendTurn).toHaveBeenNthCalledWith(
      2,
      'voice-hidden-s1',
      'VOICE_TOOL_RESULTS_JSON: {}',
      suppress,
    );
  });
});
