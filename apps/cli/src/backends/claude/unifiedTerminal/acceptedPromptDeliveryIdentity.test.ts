import { describe, expect, it } from 'vitest';

import { doesClaudeUnifiedPromptBatchMatchAcceptedTranscript } from './acceptedPromptDeliveryIdentity';

describe('doesClaudeUnifiedPromptBatchMatchAcceptedTranscript', () => {
  it('does not treat an empty accepted-prompt delivery identity as a wildcard', () => {
    expect(doesClaudeUnifiedPromptBatchMatchAcceptedTranscript({
      batch: {
        message: 'queued prompt at the arbiter head',
        maxUserMessageSeq: 42,
        userMessageLocalIds: ['queued-42'],
      },
      match: {
        deliveryIdentity: null,
        acceptedPromptNormalizedText: 'older unattributed prompt',
      },
    })).toBe(false);
  });

  it('falls back to canonical prompt text when no seq or local id can identify the accepted prompt', () => {
    expect(doesClaudeUnifiedPromptBatchMatchAcceptedTranscript({
      batch: {
        message: '  first prompt\r\nwith trailing spaces   ',
        maxUserMessageSeq: null,
        userMessageLocalIds: [],
      },
      match: {
        deliveryIdentity: null,
        acceptedPromptNormalizedText: 'first prompt\nwith trailing spaces',
      },
    })).toBe(true);
  });

  it('prefers delivery identity over prompt text when seq or local ids are available', () => {
    expect(doesClaudeUnifiedPromptBatchMatchAcceptedTranscript({
      batch: {
        message: 'same rendered text',
        maxUserMessageSeq: 51,
        userMessageLocalIds: ['local-51'],
      },
      match: {
        deliveryIdentity: { localIds: ['local-52'], userMessageSeq: 52 },
        acceptedPromptNormalizedText: 'same rendered text',
      },
    })).toBe(false);
  });

  it('matches opaque local ids by exact bytes instead of trimmed aliases', () => {
    const match = {
      deliveryIdentity: { localIds: [' local-52\n'] },
      acceptedPromptNormalizedText: 'same rendered text',
    };

    expect(doesClaudeUnifiedPromptBatchMatchAcceptedTranscript({
      batch: {
        message: 'same rendered text',
        userMessageLocalIds: ['local-52'],
      },
      match,
    })).toBe(false);

    expect(doesClaudeUnifiedPromptBatchMatchAcceptedTranscript({
      batch: {
        message: 'different text',
        userMessageLocalIds: [' local-52\n'],
      },
      match,
    })).toBe(true);
  });

  it('rejects a whitespace-only identity instead of correlating it by bytes', () => {
    expect(doesClaudeUnifiedPromptBatchMatchAcceptedTranscript({
      batch: {
        message: 'different text',
        userMessageLocalIds: ['   '],
      },
      match: {
        deliveryIdentity: { localIds: ['   '] },
        acceptedPromptNormalizedText: 'accepted text',
      },
    })).toBe(false);
  });
});
