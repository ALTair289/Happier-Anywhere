import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const scriptPath = resolve(repoRoot, 'scripts/pipeline/github/promote-rolling-release.mjs');
const targetSha = '0123456789abcdef0123456789abcdef01234567';
const oldSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source, { encoding: 'utf8', mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function fixture({ missingRolling = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'promote-rolling-release-'));
  const bin = join(root, 'bin');
  const source = join(root, 'source');
  const rolling = join(root, 'rolling');
  mkdirSync(bin);
  mkdirSync(source);
  mkdirSync(rolling);
  const archiveName = 'happier-v1.2.3-preview.4-linux-x64.tar.gz';
  const archive = Buffer.from('immutable archive bytes\n');
  writeFileSync(join(source, archiveName), archive);
  const checksumsName = 'checksums-happier-v1.2.3-preview.4.txt';
  writeFileSync(join(source, checksumsName), `${sha256(archive)}  ${archiveName}\n`);
  writeFileSync(join(source, `${checksumsName}.minisig`), 'signature\n');
  writeFileSync(join(rolling, 'old-asset'), 'old\n');

  const log = join(root, 'gh.log');
  const uploadCounter = join(root, 'upload-counter');
  const draftState = join(root, 'draft-state');
  const publishedState = join(root, 'published-state');
  const channelRef = join(root, 'channel-ref');
  writeFileSync(log, '');
  writeFileSync(uploadCounter, '0');
  if (missingRolling) {
    rmSync(join(rolling, 'old-asset'));
  } else {
    writeFileSync(channelRef, oldSha);
    writeFileSync(publishedState, '1');
  }

  writeExecutable(
    join(bin, 'minisign'),
    '#!/bin/sh\nexit 0\n',
  );
  writeExecutable(
    join(bin, 'gh'),
    `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}

if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ "$3" = "cli-preview" ] && [ ! -f ${JSON.stringify(publishedState)} ]; then exit 1; fi
  printf '%s\\n' "$3"
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  tag="$3"
  destination=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--dir" ]; then destination="$2"; break; fi
    shift
  done
  mkdir -p "$destination"
  if [ "$tag" = "cli-v1.2.3-preview.4" ]; then
    cp ${JSON.stringify(source)}/* "$destination"/
  else
    cp ${JSON.stringify(rolling)}/* "$destination"/
  fi
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "upload" ]; then
  count="$(cat ${JSON.stringify(uploadCounter)})"
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(uploadCounter)}
  if [ "\${HAPPIER_TEST_FAIL_UPLOAD_NUMBER:-0}" = "$count" ]; then
    echo "injected upload failure" >&2
    exit 1
  fi
  cp "$4" ${JSON.stringify(rolling)}/"$(basename "$4")"
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "edit" ]; then
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  exit 0
fi

if [ "$1" = "api" ]; then
  case "$*" in
    *uploads.github.com*releases/77/assets*)
      count="$(cat ${JSON.stringify(uploadCounter)})"
      count=$((count + 1))
      printf '%s' "$count" > ${JSON.stringify(uploadCounter)}
      if [ "\${HAPPIER_TEST_FAIL_UPLOAD_NUMBER:-0}" = "$count" ]; then
        echo "injected upload failure" >&2
        exit 1
      fi
      endpoint=""
      input=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          *releases/77/assets*) endpoint="$1" ;;
          --input) input="$2"; shift ;;
        esac
        shift
      done
      name="\${endpoint##*name=}"
      cp "$input" ${JSON.stringify(rolling)}/"$name"
      exit 0
      ;;
  esac
  case "$*" in
    *git/ref/tags/cli-v1.2.3-preview.4*) printf '%s\\n' ${JSON.stringify(targetSha)} ;;
    *git/ref/tags/cli-preview*) if [ -f ${JSON.stringify(channelRef)} ]; then cat ${JSON.stringify(channelRef)}; else exit 1; fi ;;
    *releases/tags/cli-preview*) if [ -f ${JSON.stringify(publishedState)} ]; then printf '%s\\n' "1"; else exit 1; fi ;;
    *"releases?per_page=100"*)
      if [ -f ${JSON.stringify(draftState)} ] && echo "$*" | grep -q "cli-preview"; then
        printf '%s\\n' "77"
      fi
      ;;
    *"-X POST repos/test/test/releases "*)
      tag_name=""
      target_commitish=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          tag_name=*) tag_name="\${1#tag_name=}" ;;
          target_commitish=*) target_commitish="\${1#target_commitish=}" ;;
        esac
        shift
      done
      : > ${JSON.stringify(draftState)}
      if [ "$tag_name" = "cli-preview" ]; then
        printf '%s' "$target_commitish" > ${JSON.stringify(channelRef)}
      else
        echo "unexpected draft tag: $tag_name" >&2
        exit 3
      fi
      printf '%s\\n' "77"
      ;;
    *"-X DELETE repos/test/test/releases/assets/"*)
      if [ ${missingRolling ? '1' : '0'} = "0" ]; then
        rm -f ${JSON.stringify(rolling)}/*
      else
        asset="\${4##*/}"
        rm -f ${JSON.stringify(rolling)}/"$asset"
      fi
      ;;
    *"repos/test/test/releases/assets/"*)
      asset="\${2##*/}"
      cat ${JSON.stringify(rolling)}/"$asset"
      ;;
    *releases/77*)
      if echo "$*" | grep -q -- "-X PATCH"; then
        if [ "\${HAPPIER_TEST_FAIL_DRAFT_PUBLISH:-0}" = "1" ]; then
          echo "injected draft publish failure" >&2
          exit 1
        fi
        tag_name=""
        target_commitish=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            tag_name=*) tag_name="\${1#tag_name=}" ;;
            target_commitish=*) target_commitish="\${1#target_commitish=}" ;;
          esac
          shift
        done
        if [ "$tag_name" = "cli-preview" ]; then
          printf '%s' "$target_commitish" > ${JSON.stringify(channelRef)}
        fi
        : > ${JSON.stringify(publishedState)}
        rm -f ${JSON.stringify(draftState)}
      else
        case "$*" in
          *"@tsv"*) for file in ${JSON.stringify(rolling)}/*; do [ -e "$file" ] || continue; name="$(basename "$file")"; printf '%s\\t%s\\n' "$name" "$name"; done ;;
          *) for file in ${JSON.stringify(rolling)}/*; do [ -e "$file" ] || continue; basename "$file"; done ;;
        esac
      fi
      ;;
    *"-X POST repos/test/test/git/refs "*) printf '%s' ${JSON.stringify(targetSha)} > ${JSON.stringify(channelRef)} ;;
    *"-X PATCH repos/test/test/git/refs/tags/cli-preview"*) printf '%s' ${JSON.stringify(targetSha)} > ${JSON.stringify(channelRef)} ;;
    *releases/assets/1*) rm -f ${JSON.stringify(rolling)}/* ;;
  esac
  exit 0
fi

echo "unexpected gh call: $*" >&2
exit 2
`,
  );

  return {
    root,
    bin,
    log,
    rolling,
    uploadCounter,
    draftState,
    publishedState,
    channelRef,
  };
}

function args() {
  return [
    scriptPath,
    '--source-tag', 'cli-v1.2.3-preview.4',
    '--rolling-tag', 'cli-preview',
    '--title', 'Happier CLI Preview',
    '--target-sha', targetSha,
    '--notes', 'Current version: 1.2.3-preview.4',
    '--prerelease', 'true',
    '--repo', 'test/test',
    '--public-key', 'scripts/release/installers/happier-release.pub',
  ];
}

test('failed rolling replacement leaves tag and notes unchanged, then the same-version retry completes from immutable bytes', () => {
  const testFixture = fixture();
  try {
    const env = {
      ...process.env,
      PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
      HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '2',
    };
    const failed = spawnSync(process.execPath, args(), {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0);
    const failedLog = readFileSync(testFixture.log, 'utf8');
    assert.doesNotMatch(failedLog, /git\/refs\/tags\/cli-preview/);
    assert.doesNotMatch(failedLog, /release edit cli-preview/);

    writeFileSync(testFixture.uploadCounter, '0');
    writeFileSync(testFixture.log, '');
    execFileSync(process.execPath, args(), {
      cwd: repoRoot,
      env: { ...env, HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '0' },
      encoding: 'utf8',
    });

    const successLog = readFileSync(testFixture.log, 'utf8');
    const auditDownload = successLog.lastIndexOf('gh release download cli-preview');
    const moveTag = successLog.lastIndexOf('gh api -X PATCH repos/test/test/git/refs/tags/cli-preview');
    const editNotes = successLog.lastIndexOf('gh release edit cli-preview');
    assert.ok(auditDownload >= 0);
    assert.ok(moveTag > auditDownload, 'moving tag must follow the rolling byte/signature audit');
    assert.ok(editNotes > moveTag, 'rolling notes/version marker must follow the audited tag move');
    assert.deepEqual(
      readdirSync(testFixture.rolling).sort(),
      [
        'checksums-happier-v1.2.3-preview.4.txt',
        'checksums-happier-v1.2.3-preview.4.txt.minisig',
        'happier-v1.2.3-preview.4-linux-x64.tar.gz',
      ],
    );
    for (const name of readdirSync(testFixture.rolling)) {
      assert.deepEqual(
        readFileSync(join(testFixture.rolling, name)),
        readFileSync(join(testFixture.root, 'source', basename(name))),
      );
    }
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('rolling promotion rejects an immutable tag whose SHA differs from the authorized SHA', () => {
  const testFixture = fixture();
  try {
    const mismatchedSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = spawnSync(
      process.execPath,
      args().map((arg, index, all) => (all[index - 1] === '--target-sha' ? mismatchedSha : arg)),
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        },
        encoding: 'utf8',
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /does not resolve to authorized SHA/i);
    assert.doesNotMatch(
      readFileSync(testFixture.log, 'utf8'),
      /release download/,
      'mismatched immutable identity must fail before release assets are consumed',
    );
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('an initially missing rolling release uses one native draft on the real tag and retries that draft before publishing', () => {
  const testFixture = fixture({ missingRolling: true });
  try {
    const failed = spawnSync(process.execPath, args(), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '2',
      },
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0);
    const failedLog = readFileSync(testFixture.log, 'utf8');
    assert.match(failedLog, /POST repos\/test\/test\/releases .*tag_name=cli-preview .*target_commitish=/);
    assert.doesNotMatch(failedLog, /PATCH repos\/test\/test\/releases\/77/);
    assert.doesNotMatch(failedLog, /happier-rolling-staging/);
    assert.equal(
      existsSync(testFixture.channelRef),
      true,
      'GitHub native draft creation owns the real rolling tag from the start',
    );
    assert.equal(existsSync(testFixture.draftState), true);
    assert.equal(existsSync(testFixture.publishedState), false);

    writeFileSync(testFixture.channelRef, oldSha);
    writeFileSync(testFixture.uploadCounter, '0');
    writeFileSync(testFixture.log, '');
    const mismatchedRetry = spawnSync(process.execPath, args(), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '0',
      },
      encoding: 'utf8',
    });
    assert.equal(mismatchedRetry.status, 1);
    assert.doesNotMatch(
      readFileSync(testFixture.log, 'utf8'),
      /DELETE repos\/test\/test\/releases\/assets/,
      'retry must validate the native draft tag target before replacing assets',
    );

    writeFileSync(testFixture.channelRef, targetSha);
    writeFileSync(testFixture.uploadCounter, '0');
    writeFileSync(testFixture.log, '');
    execFileSync(process.execPath, args(), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '0',
      },
      encoding: 'utf8',
    });
    const successLog = readFileSync(testFixture.log, 'utf8');
    const findExistingDraft = successLog.indexOf('releases?per_page=100');
    const stagedAssetDownload = successLog.lastIndexOf('Accept: application/octet-stream');
    const publishDraft = successLog.lastIndexOf('PATCH repos/test/test/releases/77');
    assert.ok(findExistingDraft >= 0, 'same-version retry must find the existing draft by real rolling tag');
    assert.ok(stagedAssetDownload > findExistingDraft);
    assert.ok(publishDraft > stagedAssetDownload, 'native draft publication must follow exact asset audit');
    assert.doesNotMatch(successLog, /happier-rolling-staging|git\/refs\/tags\/cli-preview.*(?:POST|PATCH|DELETE)/);
    assert.equal(existsSync(testFixture.channelRef), true);
    assert.equal(existsSync(testFixture.draftState), false);
    assert.equal(existsSync(testFixture.publishedState), true);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});
