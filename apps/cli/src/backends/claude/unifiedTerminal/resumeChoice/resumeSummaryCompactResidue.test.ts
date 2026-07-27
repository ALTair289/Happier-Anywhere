import { describe, expect, it } from 'vitest';

import { createClaudeResumeSummaryCompactResidueEpisode } from './resumeSummaryCompactResidue';

describe('createClaudeResumeSummaryCompactResidueEpisode', () => {
  it.each(['/compact', '/compact ', '/compact\t', '/compact\r\n'])(
    'owns only the exact provider command with optional trailing whitespace: %j',
    (draft) => {
      const episode = createClaudeResumeSummaryCompactResidueEpisode();
      episode.arm();
      expect(episode.ownsComposerDraft(draft)).toBe(true);
    },
  );

  it.each([' /compact', '\t/compact', '/compact focus on tests', '/compact-now'])(
    'rejects and cancels different composer content: %j',
    (draft) => {
      const episode = createClaudeResumeSummaryCompactResidueEpisode();
      episode.arm();
      expect(episode.ownsComposerDraft(draft)).toBe(false);
      expect(episode.ownsComposerDraft('/compact')).toBe(false);
    },
  );

  it('consumes the episode only after observing a verified empty composer', () => {
    const episode = createClaudeResumeSummaryCompactResidueEpisode();
    episode.arm();
    expect(episode.ownsComposerDraft('')).toBe(false);
    expect(episode.ownsComposerDraft('/compact')).toBe(false);
  });

  it('cancels the episode explicitly on runtime disposal', () => {
    const episode = createClaudeResumeSummaryCompactResidueEpisode();
    episode.arm();
    episode.cancel();
    expect(episode.ownsComposerDraft('/compact')).toBe(false);
  });
});
