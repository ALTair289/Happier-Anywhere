/**
 * One size for the session header's icon actions.
 *
 * The cluster had grown to 22 / 21 / 22 / 22 across four separately-owned buttons, which reads as
 * misalignment rather than as variety — nobody chose those numbers together.
 */
export const SESSION_HEADER_ICON_SIZE_PX = 20;

/**
 * The optical correction, not an exception to the rule above.
 *
 * A declared icon size is an em box, not the ink inside it. Glyphs that reach their box edges paint
 * noticeably more area than glyphs with generous internal margins, so matching the numbers leaves
 * them looking oversized next to their neighbours. Two glyphs in this header do that, for different
 * reasons: `terminal-outline` is a full-bleed rectangle, and `ellipsis-horizontal` runs its three
 * dots the full width of the box. Matching the ink means giving both a smaller box.
 */
export const SESSION_HEADER_WIDE_ICON_SIZE_PX = 18;

/**
 * The densest tier: a glyph that fills its box in BOTH axes.
 *
 * Measured ink at a declared 18, from a rendered header: `list-outline` 16x11, `info` 16x16,
 * `terminal-outline` 18x16 — and Octicons `sidebar-expand` a solid 18x18, the only glyph that fills
 * its box completely. At a matched number it read as clearly the largest icon in the row, so it
 * takes the smallest box.
 */
export const SESSION_HEADER_DENSE_ICON_SIZE_PX = 16;
