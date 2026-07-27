export type ClaudeResumeSummaryCompactResidueEpisode = Readonly<{
  arm: () => void;
  ownsComposerDraft: (draft: string) => boolean;
  cancel: () => void;
}>;

/**
 * Runtime-local provenance for Claude's native `resume_from_summary` side effect. Claude submits
 * `/compact` itself, but some versions can leave that exact command in the composer after the
 * compact turn ends. This one-shot episode lets the existing draft guard clear only that residue:
 * it is never persisted, never time-limited, and any different composer text cancels ownership.
 */
export function createClaudeResumeSummaryCompactResidueEpisode(): ClaudeResumeSummaryCompactResidueEpisode {
  let armed = false;

  return {
    arm() {
      armed = true;
    },
    ownsComposerDraft(draft) {
      if (!armed) return false;
      if (draft.length === 0) {
        armed = false;
        return false;
      }
      if (/^\/compact[ \t\r\n]*$/u.test(draft)) return true;
      armed = false;
      return false;
    },
    cancel() {
      armed = false;
    },
  };
}
