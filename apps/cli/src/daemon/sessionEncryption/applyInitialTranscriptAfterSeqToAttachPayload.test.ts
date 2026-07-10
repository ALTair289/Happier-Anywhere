import { describe, expect, it } from 'vitest';

import { applyInitialTranscriptAfterSeqToAttachPayload } from './applyInitialTranscriptAfterSeqToAttachPayload';

describe('applyInitialTranscriptAfterSeqToAttachPayload', () => {
  it('applies an explicit resume transcript cursor to the attach payload', () => {
    expect(
      applyInitialTranscriptAfterSeqToAttachPayload(
        { v: 2, encryptionMode: 'plain' },
        36,
      ),
    ).toEqual({
      v: 2,
      encryptionMode: 'plain',
      lastObservedMessageSeq: 36,
      initialTranscriptAfterSeq: 36,
      initialTranscriptCatchUpAuthorization: 'explicit_cursor',
    });
  });

  it('overrides a stale attach payload cursor with the explicit wake cursor', () => {
    expect(
      applyInitialTranscriptAfterSeqToAttachPayload(
        { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 99 },
        36,
      ),
    ).toEqual({
      v: 2,
      encryptionMode: 'plain',
      lastObservedMessageSeq: 36,
      initialTranscriptAfterSeq: 36,
      initialTranscriptCatchUpAuthorization: 'explicit_cursor',
    });
  });

  it('preserves an explicit zero cursor as a trusted wake boundary', () => {
    expect(
      applyInitialTranscriptAfterSeqToAttachPayload(
        { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 99 },
        0,
      ),
    ).toEqual({
      v: 2,
      encryptionMode: 'plain',
      lastObservedMessageSeq: 0,
      initialTranscriptAfterSeq: 0,
      initialTranscriptCatchUpAuthorization: 'explicit_cursor',
    });
  });

  it('leaves the attach payload unchanged when no valid cursor is provided', () => {
    const payload = { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 99 } as const;

    expect(applyInitialTranscriptAfterSeqToAttachPayload(payload, -1)).toBe(payload);
  });

  it('clamps the explicit wake cursor down to the owed-delivery watermark so undelivered rows are redelivered (A-F2)', () => {
    expect(
      applyInitialTranscriptAfterSeqToAttachPayload(
        { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 4 },
        5,
        { deliveredUserMessageSeq: 4 },
      ),
    ).toEqual({
      v: 2,
      encryptionMode: 'plain',
      lastObservedMessageSeq: 4,
      initialTranscriptAfterSeq: 4,
      initialTranscriptCatchUpAuthorization: 'explicit_cursor',
    });
  });

  it('keeps the explicit wake cursor when the delivered watermark is not lower', () => {
    expect(
      applyInitialTranscriptAfterSeqToAttachPayload(
        { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 4 },
        5,
        { deliveredUserMessageSeq: 9 },
      ),
    ).toEqual({
      v: 2,
      encryptionMode: 'plain',
      lastObservedMessageSeq: 5,
      initialTranscriptAfterSeq: 5,
      initialTranscriptCatchUpAuthorization: 'explicit_cursor',
    });
  });

  it('ignores the delivered watermark when no explicit cursor is provided (attach-context clamp owns that leg)', () => {
    const payload = { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 4 } as const;

    expect(applyInitialTranscriptAfterSeqToAttachPayload(payload, undefined, { deliveredUserMessageSeq: 2 })).toBe(payload);
  });
});
