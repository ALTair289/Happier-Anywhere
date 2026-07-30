import fs from 'node:fs';
import path from 'node:path';

/**
 * Integrity gate for the vendored `@legendapp/list` patch.
 *
 * WHY THIS EXISTS
 * The patch carries five behaviour fixes for defects that fail SILENTLY when the hunk is lost —
 * one of them leaves the whole transcript permanently invisible. `patch-package` regenerates the
 * patch from whatever is in `node_modules` at the time, so a regeneration performed against a
 * partially-reverted tree drops hunks without any error. Nothing then fails until a user reports
 * the symptom.
 *
 * The check people reached for first — `git apply -R --check <patch> --directory=node_modules` —
 * is VACUOUS here: it resolves the patch's `node_modules/...` paths against the repo root, where
 * the package is not hoisted, so it prints "Skipped patch" for every file and exits 0 even for a
 * deliberately corrupted patch. `patch -p1 --dry-run -R` does discriminate, but `patch(1)` is not
 * reliably present on Windows, which this repository treats as first-class. So this gate asserts
 * the installed ARTIFACTS instead: pure `fs`, no external binary, same answer on every platform.
 *
 * WHAT IT PROVES
 * That each documented fix is present in every runtime build a consumer can resolve. It does not
 * re-verify hunk context; it answers the question that actually matters — "is the fix installed".
 */

/** Runtime builds a consumer can resolve. `.d.ts` files carry no behaviour and are excluded. */
export const LEGEND_RUNTIME_BUILDS = Object.freeze([
    'react-native.mjs',
    'react-native.js',
    'react-native.web.mjs',
    'react-native.web.js',
    'react.mjs',
    'react.js',
]);

/**
 * One entry per behaviour hunk, with the provenance that lets a future reader decide whether it is
 * still needed. `removeWhen` is the condition under which the hunk should be DELETED rather than
 * carried forward — most likely because upstream fixed it.
 */
export const LEGEND_PATCH_MARKERS = Object.freeze([
    {
        id: 'position-suffix-shift',
        marker: 'positionShift',
        minOccurrences: 1,
        defect: 'updateItemPositions had one early exit (the breakAt guard) and it was the only path '
            + 'that skipped updateTotalSize, so position suffixes went stale while the incremental '
            + 'total stayed fresh. Live symptom: the transcript reserved 1184px past its last row and '
            + 'the viewport landed in the empty space.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w13/',
        removeWhen: 'upstream always reconciles positions and total in the same pass',
    },
    {
        id: 'ready-to-render-liveness',
        marker: 'mountedContainerId',
        minOccurrences: 1,
        defect: 'checkAllSizesKnown mutates (deletes sizesKnown) while applyItemSize drops '
            + 'needsRecalculate in exactly the !didContainersLayout case, so nothing re-runs the gate. '
            + 'didContainersLayout could stay false for the life of the mount, and because the row '
            + 'container is styled `opacity: readyToRender ? 1 : 0`, the whole transcript stayed '
            + 'INVISIBLE with its rows present in the DOM.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w20/',
        removeWhen: 'upstream schedules re-measurement when it invalidates a mounted row size',
    },
    {
        id: 'item-size-version-accounting',
        marker: 'previouslyContributedSize',
        minOccurrences: 1,
        defect: 'validateItemSizeVersion deleted a row size record without withdrawing its '
            + 'contribution to the incremental total, so the next setSize posted the full size on top '
            + 'of the un-withdrawn old one. Permanent when the row settles to exactly its estimate, '
            + 'because applyItemSize only recalculates on diff !== 0.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w16/',
        removeWhen: 'upstream pairs the delete with its decrement',
    },
    {
        id: 'render-range-beyond-content',
        marker: 'startBuffered === null && endBuffered === null',
        minOccurrences: 1,
        defect: 'When a scroll offset lands past every laid-out item, both range ends resolve null and '
            + 'calculateItemsInView writes no containers — then never recovers, because the next pass '
            + 'early-returns on !prevNumContainers. The mounted set freezes permanently.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w12/',
        removeWhen: 'upstream anchors the range when the probe falls beyond the last item',
    },
    {
        id: 'prefer-cached-size-refresh',
        marker: 'preferCachedSize = !doMVCP || state.scrollAdjustHandler',
        minOccurrences: 1,
        defect: 'dataChanged was part of the preferCachedSize term, and the dataChanged pass is the only '
            + 'one that walks from index 0 — so on an end-anchored list the entire scrollback stayed '
            + 'pinned at the estimate seed. Reproduced against the installed package: 200 rows of 26px '
            + 'reported 38156 end-anchored versus the exact 5200 top-anchored.',
        evidence: '.project/reviews/2026-07-27-independent-transcript-audit/w10/',
        removeWhen: 'upstream refreshes estimates on the pass that walks from index 0',
    },
]);

/**
 * @param {Readonly<{ packageDir: string }>} params
 * @returns {{ status: 'ok' | 'missing' | 'skipped', reason?: string, missing: Array<{ build: string, id: string, marker: string, found: number, expected: number }>, missingBuilds: string[] }}
 */
export function verifyVendoredLegendPatchMarkers(params) {
    const packageDir = params.packageDir;
    if (!fs.existsSync(packageDir)) {
        // Not installed (fresh clone, pruned install, or a workspace that does not depend on it).
        // Absence of the package is not a patch-integrity failure.
        return {
            status: 'skipped',
            reason: `package not installed at ${packageDir}`,
            missing: [],
            missingBuilds: [],
        };
    }

    const missing = [];
    const missingBuilds = [];

    for (const build of LEGEND_RUNTIME_BUILDS) {
        const buildPath = path.join(packageDir, build);
        if (!fs.existsSync(buildPath)) {
            // The package IS installed, so every runtime build it ships must be readable here. A
            // build the gate cannot read is a build it cannot certify, and answering `ok` for the
            // surviving subset would reproduce the exact vacuity this gate replaced — a check that
            // silently skips what it was asked to verify and still exits 0. Upstream renaming its
            // build outputs must fail loudly so a human updates LEGEND_RUNTIME_BUILDS.
            missingBuilds.push(build);
            continue;
        }
        const contents = fs.readFileSync(buildPath, 'utf8');
        for (const entry of LEGEND_PATCH_MARKERS) {
            const found = countOccurrences(contents, entry.marker);
            if (found < entry.minOccurrences) {
                missing.push({
                    build,
                    id: entry.id,
                    marker: entry.marker,
                    found,
                    expected: entry.minOccurrences,
                });
            }
        }
    }

    return missing.length > 0 || missingBuilds.length > 0
        ? { status: 'missing', missing, missingBuilds }
        : { status: 'ok', missing: [], missingBuilds: [] };
}

/** @param {ReturnType<typeof verifyVendoredLegendPatchMarkers>} result */
export function formatVendoredLegendPatchFailure(result) {
    const lines = ['Vendored @legendapp/list patch is missing behaviour hunks:'];
    for (const build of result.missingBuilds ?? []) {
        lines.push(`  - ${build}: runtime build absent, so its hunks could not be certified`);
    }
    for (const item of result.missing) {
        const entry = LEGEND_PATCH_MARKERS.find((candidate) => candidate.id === item.id);
        lines.push(`  - ${item.build}: ${item.id} (found ${item.found}, expected >= ${item.expected})`);
        if (entry) lines.push(`      ${entry.defect}`);
        if (entry) lines.push(`      evidence: ${entry.evidence}`);
    }
    lines.push('');
    lines.push('This usually means the patch was regenerated against a partially-reverted node_modules.');
    lines.push('Do NOT hand-edit the .patch file. Restore the behaviour in node_modules, then run:');
    lines.push('  npx patch-package @legendapp/list');
    return lines.join('\n');
}

function countOccurrences(haystack, needle) {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
