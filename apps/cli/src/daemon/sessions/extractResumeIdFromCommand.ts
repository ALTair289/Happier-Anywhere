/**
 * Extracts the vendor resume id from a runner's live process command (`--resume <id>`).
 *
 * Shared single owner for argv resume parsing: markerless recovery
 * (`reattachFromMarkers`) and marker adoption backfill (`adoptSessionsFromMarkers`)
 * both consume this so a runner's resume identity is recovered from one parser, never two.
 */
export function extractResumeIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)--resume(?:=|\s+)(\S+)/.exec(command);
  const resumeId = typeof match?.[1] === 'string' ? match[1].trim() : '';
  return resumeId || null;
}
