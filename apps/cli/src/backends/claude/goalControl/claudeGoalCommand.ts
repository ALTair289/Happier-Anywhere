/**
 * Claude native `/goal` command builder (deepening D2).
 *
 * Wraps the literal `/goal` slash-command format in one place so it never
 * scatters across the effector (live-RPC inject + initial-goal injection).
 * Mirrors happy's `ClaudeGoalCommand` shape (`{ type:'set'; objective }` /
 * `{ type:'clear' }`) and its `/goal clear` vs `/goal <objective>` formatting.
 */

export type ClaudeGoalCommandRequest =
  | Readonly<{ type: 'set'; objective: string }>
  | Readonly<{ type: 'clear' }>;

// Any line-break code point: CR, LF, NEL (U+0085), line/paragraph separators
// (U+2028/U+2029), written as escapes so the regex literal stays single-line.
const GOAL_OBJECTIVE_LINE_BREAK_RUN = /[ \t\f\v]*[\r\n\u0085\u2028\u2029]+[ \t\f\v]*/gu;

/**
 * Normalize an objective into a single `/goal` line (LOW-1).
 *
 * The objective is user-controlled and can contain embedded newlines (the
 * composer allows multiline input). Injected verbatim, those line breaks would
 * split the single `/goal` slash-command into multiple garbled TUI lines. Replace
 * each line break (plus any spaces/tabs hugging it) with a single space and trim
 * the ends so the command always occupies exactly one line. Interior runs of
 * plain spaces that contain no line break are intentionally preserved.
 */
function normalizeGoalObjectiveLine(objective: string): string {
  return objective.replace(GOAL_OBJECTIVE_LINE_BREAK_RUN, ' ').trim();
}

/** Build the literal `/goal` user-turn text Claude's TUI consumes. */
export function buildClaudeGoalCommand(request: ClaudeGoalCommandRequest): string {
  if (request.type === 'clear') {
    return '/goal clear';
  }
  return `/goal ${normalizeGoalObjectiveLine(request.objective)}`;
}
