export function normalizeClaudeUnifiedPromptIdentityText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Claude may render one logical composer value across several terminal rows. Treat those visual
 * whitespace breaks as presentation only while retaining the exact normalized word sequence.
 */
export function normalizeClaudeUnifiedComposerRenderingText(value: string): string {
  return normalizeClaudeUnifiedPromptIdentityText(value).replace(/\s+/g, ' ');
}
