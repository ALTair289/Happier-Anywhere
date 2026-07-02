import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract test for the local patch-package fix on @shopify/flash-list (issue-2, 2026-06-12).
 *
 * FlashList 2.3.2's RecyclerView useLayoutEffect calls ViewHolderCollection.commitLayout()
 * (an unconditional setState) on EVERY layout pass that performs no layout modifications.
 * When item measurements never settle (estimated-vs-measured height flip-flop after chain
 * transcript prepends), that unguarded setState ping-pongs with ViewHolderCollection
 * re-renders inside a single synchronous layout-effect cascade and exceeds React's nested
 * update limit ("Maximum update depth exceeded"), crashing the app.
 *
 * The loop is only reproducible on-device (it needs real native measurement churn), so this
 * test pins the load-bearing contract instead: the installed package must carry the guard
 * and the patch file must match the installed version, so a dependency bump cannot silently
 * reintroduce the unguarded path.
 */

const require_ = createRequire(import.meta.url);

function resolveFlashListRoot(): string {
  const packageJsonPath = require_.resolve('@shopify/flash-list/package.json');
  return dirname(packageJsonPath);
}

describe('flash-list commitLayout guard patch', () => {
  it('keeps the patch file aligned with the installed @shopify/flash-list version', () => {
    const flashListRoot = resolveFlashListRoot();
    const pkg = JSON.parse(readFileSync(join(flashListRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const patchPath = resolve(
      __dirname,
      '../../../../../patches',
      `@shopify+flash-list+${pkg.version}.patch`,
    );
    expect(existsSync(patchPath), `expected patch file at ${patchPath}`).toBe(true);

    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('HAPPIER PATCH(flash-list-commit-layout-guard)');
    expect(patchContent).toContain('dist/recyclerview/RecyclerView.js');
    expect(patchContent).toContain('dist/recyclerview/ViewHolderCollection.js');
  });

  it('ships an installed RecyclerView with the guarded commitLayout path applied', () => {
    const flashListRoot = resolveFlashListRoot();
    const distRecyclerView = readFileSync(
      join(flashListRoot, 'dist/recyclerview/RecyclerView.js'),
      'utf8',
    );

    // The guard marker must be present in the runtime entry actually resolved by Metro
    // (package "main" points at dist/).
    expect(distRecyclerView).toContain('HAPPIER PATCH(flash-list-commit-layout-guard)');
    expect(distRecyclerView).not.toContain('HAPPIER PATCH(flash-list-first-reveal-commit)');

    // The pathological shape — commitLayout() invoked unconditionally in the else branch of the
    // layout effect — must be gone: every commitLayout call site in the layout effect must be
    // reachable only behind the pending-commit guard.
    expect(distRecyclerView).toContain('hasPendingCommitRef');
    expect(distRecyclerView).toContain('hasCommittedOnceRef');
  });

  it('ships a ViewHolderCollection that reveals populated measured content without a parent commit', () => {
    const flashListRoot = resolveFlashListRoot();
    const distViewHolderCollection = readFileSync(
      join(flashListRoot, 'dist/recyclerview/ViewHolderCollection.js'),
      'utf8',
    );

    // The blank-list regression reproduced on iOS with data/renderStack intact and the
    // ViewHolderCollection container native alpha stuck at 0. The opacity owner must own a
    // one-time self reveal once it has data, a container layout, and rendered holders.
    expect(distViewHolderCollection).toContain('HAPPIER PATCH(flash-list-view-holder-self-reveal)');
    expect(distViewHolderCollection).toContain('shouldRevealMeasuredContent');
    expect(distViewHolderCollection).toContain('renderStack.size > 0');
    expect(distViewHolderCollection).toContain('setRenderId(1)');
  });
});

describe('flash-list offset-correction hook patch (N1.1 evidence)', () => {
  it('keeps the patch file carrying the offset-correction hook for the installed version', () => {
    const flashListRoot = resolveFlashListRoot();
    const pkg = JSON.parse(readFileSync(join(flashListRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const patchPath = resolve(
      __dirname,
      '../../../../../patches',
      `@shopify+flash-list+${pkg.version}.patch`,
    );
    expect(existsSync(patchPath), `expected patch file at ${patchPath}`).toBe(true);

    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('HAPPIER PATCH(flash-list-offset-correction-hook)');
    expect(patchContent).toContain('dist/recyclerview/hooks/useRecyclerViewController.js');
  });

  it('ships an installed useRecyclerViewController with corrector observability applied', () => {
    const flashListRoot = resolveFlashListRoot();
    const distController = readFileSync(
      join(flashListRoot, 'dist/recyclerview/hooks/useRecyclerViewController.js'),
      'utf8',
    );

    // Marker + the global slot the app-side bridge owns — always-on since N2d.1: the prepend
    // transaction's corrector-deference signal rides this hook in production
    // (sources/components/sessions/transcript/scroll/flashListOffsetCorrectionHook.ts).
    expect(distController).toContain('HAPPIER PATCH(flash-list-offset-correction-hook)');
    expect(distController).toContain('__HAPPIER_FLASHLIST_OFFSET_CORRECTION_HOOK__');

    // Every pauseOffsetCorrection transition and every nonzero correction decision must notify:
    // pause-set/pause-cleared from both imperative-scroll sites, and the applied/skipped split
    // that quantifies D2 (self-inflicted pause overlap).
    expect(distController).toContain('"pause-set"');
    expect(distController).toContain('"pause-cleared"');
    expect(distController).toContain('"scroll-to-index"');
    expect(distController).toContain('"initial-scroll-index"');
    expect(distController).toContain('"correction-applied"');
    expect(distController).toContain('"correction-skipped-paused"');
    expect(distController).toContain('"correction-skipped-happier-paused"');
    expect(distController).toContain('"correction-skipped-animation"');
  });
});
