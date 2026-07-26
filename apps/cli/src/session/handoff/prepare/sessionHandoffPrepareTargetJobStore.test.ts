import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const recoveryWriteBarrier = vi.hoisted(() => {
  let destinationSuffix: string | null = null;
  let enteredResolve: (() => void) | null = null;
  let releaseResolve: (() => void) | null = null;
  let entered = Promise.resolve();
  let release = Promise.resolve();

  return {
    arm(nextDestinationSuffix: string) {
      destinationSuffix = nextDestinationSuffix;
      entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      release = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
    },
    async pauseIfArmed(destination: string): Promise<void> {
      if (destinationSuffix === null || !destination.endsWith(destinationSuffix)) return;
      destinationSuffix = null;
      enteredResolve?.();
      await release;
    },
    waitUntilEntered: async () => await entered,
    release: () => releaseResolve?.(),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      // This is the filesystem commit boundary; internal store/lease logic remains real.
      await recoveryWriteBarrier.pauseIfArmed(newPath);
      return await actual.rename(oldPath, newPath);
    }),
  };
});

import {
  createSessionHandoffPrepareTargetJobStore,
  recoverSessionHandoffPrepareTargetJobsAfterRestart,
} from './sessionHandoffPrepareTargetJobStore';
import {
  releaseSessionHandoffPrepareTargetJobLease,
  startSessionHandoffPrepareTargetJobLeaseHeartbeat,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from './sessionHandoffPrepareTargetJobLease';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

function createDeferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 500): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function runTransitionWorker(input: Readonly<{
  activeServerDir: string;
  barrierPath: string;
  jobId: string;
  workerId: string;
  transitions: number;
}>): Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>> {
  const worker = spawn(process.execPath, [
    '--no-deprecation',
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    `
      import { access, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { createSessionHandoffPrepareTargetJobStore } from ${JSON.stringify(new URL('./sessionHandoffPrepareTargetJobStore.ts', import.meta.url).href)};

      const activeServerDir = process.env.HAPPIER_TEST_ACTIVE_SERVER_DIR;
      const barrierPath = process.env.HAPPIER_TEST_BARRIER_PATH;
      const jobId = process.env.HAPPIER_TEST_JOB_ID;
      const workerId = process.env.HAPPIER_TEST_WORKER_ID;
      const transitions = Number(process.env.HAPPIER_TEST_TRANSITIONS);
      if (!activeServerDir || !barrierPath || !jobId || !workerId || !Number.isSafeInteger(transitions)) {
        throw new Error('Missing transition-worker input');
      }

      await writeFile(join(activeServerDir, 'ready-' + workerId), workerId, 'utf8');
      while (true) {
        try {
          await access(barrierPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      }

      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const acknowledged = [];
      for (let index = 0; index < transitions; index += 1) {
        const transitioned = await store.transitionV2(jobId, (current) => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8);
          return {
            ...current,
            updatedAtMs: current.updatedAtMs + 1,
            transitionRevision: current.transitionRevision + 1,
          };
        });
        acknowledged.push(transitioned?.transitionRevision ?? null);
      }
      process.stdout.write(JSON.stringify({ acknowledged }));
    `,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HAPPIER_TEST_ACTIVE_SERVER_DIR: input.activeServerDir,
      HAPPIER_TEST_BARRIER_PATH: input.barrierPath,
      HAPPIER_TEST_JOB_ID: input.jobId,
      HAPPIER_TEST_WORKER_ID: input.workerId,
      HAPPIER_TEST_TRANSITIONS: String(input.transitions),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  worker.stdout.setEncoding('utf8');
  worker.stderr.setEncoding('utf8');
  worker.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  worker.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  return { code: typeof code === 'number' ? code : null, stdout, stderr };
}

async function waitForTransitionWorkers(activeServerDir: string, workerCount: number): Promise<void> {
  const startedAtMs = Date.now();
  for (;;) {
    const readyCount = await readdir(activeServerDir)
      .then((entries) => entries.filter((entry) => entry.startsWith('ready-')).length)
      .catch(() => 0);
    if (readyCount === workerCount) return;
    if (Date.now() - startedAtMs > 30_000) {
      throw new Error(`Timed out waiting for ${workerCount} transition workers; observed ${readyCount}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('sessionHandoffPrepareTargetJobStore', () => {
  it('atomically upgrades a ready v1 target job to exact-session v2 ownership state', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-upgrade-ready-v2-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const handoffId = 'handoff_upgrade_ready_v2';
      const jobId = 'job_upgrade_ready_v2';
      const status = { handoffId, jobId, status: 'ready_for_cutover' as const, phase: 'cutover' as const, recoveryActions: [] };
      await store.write({
        jobId, handoffId, createdAtMs: 1, updatedAtMs: 2, completedAtMs: 2, status,
        prepareTargetResult: {
          handoffId,
          status,
          remoteSessionId: 'remote_1',
          directSource: { kind: 'claudeConfig', configDir: null, projectId: null },
          resume: {
            directory: '/repo', agent: 'claude', resume: 'remote_1',
            transcriptStorage: 'direct', approvedNewDirectoryCreation: true,
          },
        },
      });

      await expect(store.upgradeReadyV1ToPreparedV2({ jobId, sessionId: 'session_1' })).resolves.toMatchObject({
        schemaVersion: 2,
        recordKind: 'prepared_target',
        sessionId: 'session_1',
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  it.each(['', '.', '..', 'nested/job', 'nested\\job'])(
    'rejects non-isolated job id %j at the store path boundary',
    async (jobId) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-store-invalid-id-'));
      try {
        const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
        await expect(store.read(jobId)).rejects.toThrow('Invalid session handoff prepare-target job id');
      } finally {
        await rm(activeServerDir, { recursive: true, force: true });
      }
    },
  );

  it('reads deployed v1 bytes and writes new prepared jobs only through the explicit v2 lifecycle contract', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-versioned-'));
    try {
      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      await mkdir(jobsDirectory, { recursive: true });
      const legacyJobId = 'prepare_job_legacy_readable';
      await writeFile(join(jobsDirectory, `${legacyJobId}.json`), JSON.stringify({
        schemaVersion: 1,
        jobId: legacyJobId,
        handoffId: 'handoff_legacy_readable',
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          handoffId: 'handoff_legacy_readable',
          status: 'ready_for_cutover',
          phase: 'cutover',
          jobId: legacyJobId,
          recoveryActions: [],
        },
      }), 'utf8');

      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.read(legacyJobId)).resolves.toMatchObject({
        schemaVersion: 1,
        handoffId: 'handoff_legacy_readable',
      });

      const jobId = 'prepare_job_v2';
      const handoffId = 'handoff_v2';
      await store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_exact_v2',
        createdAtMs: 2,
        updatedAtMs: 2,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId,
          status: 'pending',
          phase: 'preparing',
          jobId,
          recoveryActions: [],
        },
      });

      await expect(store.read(jobId)).resolves.toEqual(expect.objectContaining({
        schemaVersion: 2,
        sessionId: 'session_exact_v2',
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
      }));

      await store.transitionV2(jobId, (current) => {
        const { schemaVersion: _schemaVersion, ...record } = current;
        return {
          ...record,
          updatedAtMs: 3,
          transitionRevision: current.transitionRevision + 1,
        };
      });
      await expect(store.read(jobId)).resolves.toEqual(expect.objectContaining({
        schemaVersion: 2,
        sessionId: 'session_exact_v2',
        updatedAtMs: 3,
        transitionRevision: 1,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
      }));
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects v2 prepared jobs without exact identity or coherent lifecycle state', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-v2-invalid-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const base = {
        jobId: 'prepare_job_v2_invalid',
        handoffId: 'handoff_v2_invalid',
        createdAtMs: 1,
        updatedAtMs: 1,
        transitionRevision: 0,
        resume: { status: 'not_attempted' as const },
        terminal: { status: 'open' as const },
        targetCleanup: { status: 'not_required' as const },
        status: {
          handoffId: 'handoff_v2_invalid',
          status: 'pending' as const,
          phase: 'preparing' as const,
          recoveryActions: [],
        },
      };

      await expect(store.writePreparedV2({ ...base, sessionId: '' })).rejects.toMatchObject({ name: 'ZodError' });
      await expect(store.writePreparedV2({
        ...base,
        sessionId: 'session_exact_v2',
        terminal: { status: 'aborting', operationId: 'abort_1', claimedRevision: 1 },
      })).rejects.toMatchObject({ name: 'ZodError' });
      await expect(store.writePreparedV2({
        ...base,
        sessionId: 'session_exact_v2',
        // Boundary fixture deliberately bypasses the static union to prove persisted runtime rejection.
        resume: { status: 'legacy_unknown' as never },
        targetCleanup: { status: 'not_applicable', reason: 'source_only' },
      })).rejects.toMatchObject({ name: 'ZodError' });
      await expect(store.writePreparedV2({
        ...base,
        jobId: 'prepare_job_v2_invalid_revision',
        handoffId: 'handoff_v2_invalid_revision',
        sessionId: 'session_exact_v2',
        transitionRevision: 1,
        status: {
          ...base.status,
          handoffId: 'handoff_v2_invalid_revision',
          jobId: 'prepare_job_v2_invalid_revision',
        },
      })).rejects.toThrow(/initial.*revision/i);
      await expect(store.writePreparedV2({
        ...base,
        jobId: 'prepare_job_v2_invalid_owned',
        handoffId: 'handoff_v2_invalid_owned',
        sessionId: 'session_exact_v2',
        resume: { status: 'attempted', attemptId: 'attempt_bypass', acceptedAtMs: 1 },
        status: {
          ...base.status,
          handoffId: 'handoff_v2_invalid_owned',
          jobId: 'prepare_job_v2_invalid_owned',
        },
      })).rejects.toThrow(/initial.*resume/i);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects incoherent v2 terminal and public statuses at creation and transition boundaries', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-v2-terminal-coherence-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const creationJobId = 'prepare_job_v2_terminal_creation';
      const creationHandoffId = 'handoff_v2_terminal_creation';
      await expect(store.writeSourceOnlyV2({
        jobId: creationJobId,
        handoffId: creationHandoffId,
        sessionId: 'session_v2_terminal_creation',
        createdAtMs: 1,
        updatedAtMs: 1,
        transitionRevision: 1,
        resume: { status: 'not_applicable' },
        terminal: { status: 'aborted', operationId: 'abort_creation', completedRevision: 1 },
        targetCleanup: { status: 'not_applicable', reason: 'source_only' },
        status: {
          handoffId: creationHandoffId,
          jobId: creationJobId,
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      })).rejects.toMatchObject({ name: 'ZodError' });
      await expect(store.read(creationJobId)).resolves.toBeNull();

      const completedCreationJobId = 'prepare_job_v2_completed_creation';
      const completedCreationHandoffId = 'handoff_v2_completed_creation';
      await expect(store.writeSourceOnlyV2({
        jobId: completedCreationJobId,
        handoffId: completedCreationHandoffId,
        sessionId: 'session_v2_completed_creation',
        createdAtMs: 1,
        updatedAtMs: 1,
        completedAtMs: 1,
        transitionRevision: 1,
        resume: { status: 'not_applicable' },
        terminal: { status: 'completed', operationId: 'commit_creation', completedRevision: 1 },
        targetCleanup: { status: 'not_applicable', reason: 'source_only' },
        status: {
          handoffId: completedCreationHandoffId,
          jobId: completedCreationJobId,
          status: 'aborted',
          phase: 'cutover',
          recoveryActions: [],
        },
      })).rejects.toMatchObject({ name: 'ZodError' });
      await expect(store.read(completedCreationJobId)).resolves.toBeNull();

      const transitionJobId = 'prepare_job_v2_terminal_transition';
      const transitionHandoffId = 'handoff_v2_terminal_transition';
      await store.writePreparedV2({
        jobId: transitionJobId,
        handoffId: transitionHandoffId,
        sessionId: 'session_v2_terminal_transition',
        createdAtMs: 1,
        updatedAtMs: 1,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId: transitionHandoffId,
          jobId: transitionJobId,
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      });
      const before = await store.read(transitionJobId);
      await expect(store.transitionV2(transitionJobId, (current) => ({
        ...current,
        updatedAtMs: 2,
        abortedAtMs: 2,
        transitionRevision: 1,
        terminal: { status: 'aborted', operationId: 'abort_transition', completedRevision: 1 },
        targetCleanup: { status: 'not_owned', reason: 'resume_not_attempted' },
      }))).rejects.toMatchObject({ name: 'ZodError' });
      await expect(store.transitionV2(transitionJobId, (current) => ({
        ...current,
        updatedAtMs: 2,
        transitionRevision: 1,
        resume: { status: 'attempted', attemptId: 'attempt_aborting', acceptedAtMs: 2 },
        terminal: { status: 'aborting', operationId: 'abort_claim', claimedRevision: 1 },
        targetCleanup: { status: 'pending' },
        status: { ...current.status, status: 'aborted' },
      }))).rejects.toMatchObject({ name: 'ZodError' });
      await expect(store.read(transitionJobId)).resolves.toEqual(before);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('separates v2 creation from immutable monotonic transitions', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-v2-transition-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_job_v2_transition';
      const handoffId = 'handoff_v2_transition';
      await store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_original',
        createdAtMs: 1,
        updatedAtMs: 1,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      });

      await expect(store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_replaced',
        createdAtMs: 1,
        updatedAtMs: 2,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      })).rejects.toThrow(/already exists/i);

      const secondStoreInstance = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const revisions = await Promise.all([
        store.transitionV2(jobId, (current) => ({
          ...current,
          updatedAtMs: current.updatedAtMs + 1,
          transitionRevision: current.transitionRevision + 1,
        })),
        secondStoreInstance.transitionV2(jobId, (current) => ({
          ...current,
          updatedAtMs: current.updatedAtMs + 1,
          transitionRevision: current.transitionRevision + 1,
        })),
      ]);

      expect(
        revisions
          .map((record) => record?.transitionRevision)
          .sort((left, right) => (left ?? 0) - (right ?? 0)),
      ).toEqual([1, 2]);
      await expect(store.read(jobId)).resolves.toMatchObject({
        jobId,
        handoffId,
        sessionId: 'session_original',
        transitionRevision: 2,
        updatedAtMs: 3,
      });

      await expect(store.transitionV2(jobId, (current) => ({
        ...current,
        sessionId: 'session_replaced',
        transitionRevision: current.transitionRevision + 1,
      }))).rejects.toThrow(/identity/i);
      await expect(store.transitionV2(jobId, (current) => ({
        ...current,
        transitionRevision: current.transitionRevision,
      }))).rejects.toThrow(/revision/i);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('retains every acknowledged v2 transition across independent daemon processes', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-v2-process-race-'));
    const barrierPath = join(activeServerDir, 'release-workers');
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_job_v2_process_race';
      const handoffId = 'handoff_v2_process_race';
      await store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_process_race',
        createdAtMs: 1,
        updatedAtMs: 1,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      });

      const workerCount = 6;
      const transitionsPerWorker = 6;
      const workers = Array.from({ length: workerCount }, (_, index) => runTransitionWorker({
        activeServerDir,
        barrierPath,
        jobId,
        workerId: String(index),
        transitions: transitionsPerWorker,
      }));
      await waitForTransitionWorkers(activeServerDir, workerCount);
      await writeFile(barrierPath, 'go', 'utf8');
      const results = await Promise.all(workers);

      expect(results.map(({ code }) => code)).toEqual(Array.from({ length: workerCount }, () => 0));
      expect(results.filter(({ code }) => code !== 0).map(({ stderr }) => stderr)).toEqual([]);
      const acknowledgedRevisions = results.flatMap(({ stdout }) => {
        const parsed = JSON.parse(stdout) as { acknowledged: Array<number | null> };
        return parsed.acknowledged;
      });
      expect(acknowledgedRevisions).toHaveLength(workerCount * transitionsPerWorker);
      expect(new Set(acknowledgedRevisions).size).toBe(workerCount * transitionsPerWorker);
      await expect(store.read(jobId)).resolves.toMatchObject({
        transitionRevision: workerCount * transitionsPerWorker,
        updatedAtMs: 1 + (workerCount * transitionsPerWorker),
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 40_000);

  it('rejects resume ownership rollback and attempt identity replacement', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-v2-resume-monotonic-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_job_v2_resume_monotonic';
      const handoffId = 'handoff_v2_resume_monotonic';
      await store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_resume_monotonic',
        createdAtMs: 1,
        updatedAtMs: 1,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId,
          jobId,
          status: 'ready_for_cutover',
          phase: 'cutover',
          recoveryActions: [],
        },
      });
      await store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 2,
        transitionRevision: 1,
        resume: { status: 'attempted', attemptId: 'attempt_original', acceptedAtMs: 2 },
      }));

      await expect(store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 3,
        transitionRevision: 2,
        resume: { status: 'not_attempted' },
      }))).rejects.toThrow(/resume.*backward|ownership.*immutable/i);
      await expect(store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 3,
        transitionRevision: 2,
        resume: { status: 'attempted', attemptId: 'attempt_replaced', acceptedAtMs: 2 },
      }))).rejects.toThrow(/attempt.*identity|ownership.*immutable/i);
      await expect(store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 3,
        transitionRevision: 2,
        resume: { status: 'attempted', attemptId: 'attempt_original', acceptedAtMs: 3 },
      }))).rejects.toThrow(/attempt.*identity|ownership.*immutable/i);
      await store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 3,
        transitionRevision: 2,
        resume: {
          status: 'confirmed',
          attemptId: 'attempt_original',
          acceptedAtMs: 2,
          confirmedAtMs: 3,
        },
      }));
      await expect(store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 4,
        transitionRevision: 3,
        resume: { status: 'attempted', attemptId: 'attempt_original', acceptedAtMs: 2 },
      }))).rejects.toThrow(/resume.*backward|ownership.*immutable/i);
      await expect(store.read(jobId)).resolves.toMatchObject({
        transitionRevision: 2,
        resume: {
          status: 'confirmed',
          attemptId: 'attempt_original',
          acceptedAtMs: 2,
          confirmedAtMs: 3,
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('deep-freezes v2 transition inputs so in-place mutation cannot bypass lifecycle invariants', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-v2-frozen-transition-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_job_v2_frozen_transition';
      const handoffId = 'handoff_v2_frozen_transition';
      await store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_frozen_transition',
        createdAtMs: 1,
        updatedAtMs: 1,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId,
          jobId,
          status: 'ready_for_cutover',
          phase: 'cutover',
          recoveryActions: [],
        },
      });
      await store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 2,
        transitionRevision: 1,
        resume: { status: 'attempted', attemptId: 'attempt_frozen', acceptedAtMs: 2 },
      }));

      await expect(store.transitionV2(jobId, (current) => {
        Object.defineProperty(current, 'sessionId', { value: 'session_replaced' });
        return { ...current, updatedAtMs: 3, transitionRevision: 2 };
      })).rejects.toThrow();
      await expect(store.transitionV2(jobId, (current) => {
        if (current.recordKind === 'prepared_target' && current.resume.status === 'attempted') {
          Object.defineProperty(current.resume, 'attemptId', { value: 'attempt_replaced' });
          Object.defineProperty(current.resume, 'acceptedAtMs', { value: 3 });
        }
        return { ...current, updatedAtMs: 3, transitionRevision: 2 };
      })).rejects.toThrow();
      await expect(store.transitionV2(jobId, (current) => {
        Object.defineProperty(current, 'resume', { value: { status: 'not_attempted' } });
        return { ...current, updatedAtMs: 3, transitionRevision: 2 };
      })).rejects.toThrow();

      await store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 3,
        transitionRevision: 2,
        resume: {
          status: 'confirmed',
          attemptId: 'attempt_frozen',
          acceptedAtMs: 2,
          confirmedAtMs: 3,
        },
      }));
      await expect(store.transitionV2(jobId, (current) => {
        if (current.recordKind === 'prepared_target' && current.resume.status === 'confirmed') {
          Object.defineProperty(current.resume, 'confirmedAtMs', { value: 4 });
        }
        return { ...current, updatedAtMs: 4, transitionRevision: 3 };
      })).rejects.toThrow();

      await store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 4,
        transitionRevision: 3,
        terminal: { status: 'aborting', operationId: 'abort_frozen', claimedRevision: 3 },
        targetCleanup: { status: 'pending' },
      }));
      await store.transitionV2(jobId, (current) => ({
        ...current,
        updatedAtMs: 5,
        transitionRevision: 4,
        terminal: { status: 'aborted', operationId: 'abort_frozen', completedRevision: 4 },
        targetCleanup: { status: 'proved_absent', proof: 'stopped', provedAtMs: 5 },
        status: { ...current.status, status: 'aborted' },
      }));
      await expect(store.transitionV2(jobId, (current) => {
        Object.defineProperty(current, 'terminal', { value: { status: 'open' } });
        Object.defineProperty(current, 'targetCleanup', { value: { status: 'not_required' } });
        return { ...current, updatedAtMs: 6, transitionRevision: 5 };
      })).rejects.toThrow();

      await expect(store.read(jobId)).resolves.toMatchObject({
        sessionId: 'session_frozen_transition',
        transitionRevision: 4,
        resume: {
          status: 'confirmed',
          attemptId: 'attempt_frozen',
          acceptedAtMs: 2,
          confirmedAtMs: 3,
        },
        terminal: { status: 'aborted', operationId: 'abort_frozen', completedRevision: 4 },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('preserves legacy job identity across retained v1 writers and v1-to-v2 conversion', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-v1-identity-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_job_v1_identity';
      const handoffId = 'handoff_v1_identity';
      const status = {
        handoffId,
        jobId,
        status: 'ready_for_cutover' as const,
        phase: 'cutover' as const,
        recoveryActions: [],
      };
      await store.write({
        jobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 1,
        status,
      });

      await expect(store.write({
        jobId,
        handoffId: 'handoff_stale_replacement',
        createdAtMs: 2,
        updatedAtMs: 2,
        status: { ...status, handoffId: 'handoff_stale_replacement' },
      })).rejects.toThrow(/identity/i);
      await expect(store.update(jobId, (current) => ({
        ...current,
        handoffId: 'handoff_stale_update',
        createdAtMs: 2,
        updatedAtMs: 2,
        status: { ...current.status, handoffId: 'handoff_stale_update' },
      }))).rejects.toThrow(/identity/i);
      await expect(store.writeLegacyCleanupUnavailableV2({
        jobId,
        handoffId: 'handoff_stale_conversion',
        createdAtMs: 2,
        updatedAtMs: 2,
        transitionRevision: 1,
        resume: { status: 'legacy_unknown' },
        terminal: { status: 'aborted', operationId: 'abort_stale_conversion', completedRevision: 1 },
        targetCleanup: { status: 'legacy_cleanup_unavailable' },
        status: {
          ...status,
          handoffId: 'handoff_stale_conversion',
          status: 'aborted',
        },
      })).rejects.toThrow(/identity/i);
      await expect(store.read(jobId)).resolves.toMatchObject({
        schemaVersion: 1,
        jobId,
        handoffId,
        createdAtMs: 1,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('deep-freezes legacy update inputs so in-place mutation cannot replace v1 identity', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-v1-frozen-update-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_job_v1_frozen_update';
      const handoffId = 'handoff_v1_frozen_update';
      await store.write({
        jobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      });

      await expect(store.update(jobId, (current) => {
        Object.defineProperty(current, 'handoffId', { value: 'handoff_replaced' });
        Object.defineProperty(current.status, 'handoffId', { value: 'handoff_replaced' });
        return { ...current, updatedAtMs: 2 };
      })).rejects.toThrow();
      await expect(store.read(jobId)).resolves.toMatchObject({
        schemaVersion: 1,
        jobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 1,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects every stale v1 mutation entry after v2 creation without changing persisted bytes', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-stale-v1-after-v2-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_job_stale_v1_after_v2';
      const handoffId = 'handoff_stale_v1_after_v2';
      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      const jobPath = join(jobsDirectory, `${jobId}.json`);
      const status = {
        handoffId,
        jobId,
        status: 'pending' as const,
        phase: 'preparing' as const,
        recoveryActions: [],
      };
      await store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_stale_v1_after_v2',
        createdAtMs: 1,
        updatedAtMs: 1,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status,
      });
      const originalBytes = await readFile(jobPath, 'utf8');

      await expect(store.write({
        jobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 2,
        status,
      })).rejects.toThrow(/v1 writer.*v2/i);
      await expect(store.update(jobId, (current) => ({
        ...current,
        updatedAtMs: 2,
      }))).rejects.toThrow(/legacy update.*v2/i);
      await expect(store.writeLegacyCleanupUnavailableV2({
        jobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 2,
        transitionRevision: 1,
        resume: { status: 'legacy_unknown' },
        terminal: { status: 'aborted', operationId: 'abort_stale_v1', completedRevision: 1 },
        targetCleanup: { status: 'legacy_cleanup_unavailable' },
        status: { ...status, status: 'aborted' },
      })).rejects.toThrow(/legacy conversion.*v2/i);

      await expect(readFile(jobPath, 'utf8')).resolves.toBe(originalBytes);
      await expect(store.read(jobId)).resolves.toMatchObject({
        schemaVersion: 2,
        recordKind: 'prepared_target',
        sessionId: 'session_stale_v1_after_v2',
        transitionRevision: 0,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when a persisted job file uses an unsupported schemaVersion', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-schema-'));
    try {
      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      await mkdir(jobsDirectory, { recursive: true });

      const jobId = 'prepare_job_schema_unsupported';
      await writeFile(join(jobsDirectory, `${jobId}.json`), JSON.stringify({
        schemaVersion: 3,
        jobId,
        handoffId: 'handoff_schema_unsupported',
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          handoffId: 'handoff_schema_unsupported',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      }), 'utf8');

      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.read(jobId)).resolves.toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when a persisted job file omits schemaVersion (no undeployed compatibility)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-legacy-'));
    try {
      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      await mkdir(jobsDirectory, { recursive: true });
      await writeFile(join(jobsDirectory, 'job_legacy_1.json'), JSON.stringify({
        // schemaVersion is intentionally omitted to prove we do not keep undeployed compatibility shims.
        jobId: 'job_legacy_1',
        handoffId: 'handoff_legacy_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          handoffId: 'handoff_legacy_1',
          status: 'in_progress',
          phase: 'preparing',
          recoveryActions: [],
        },
      }), 'utf8');

      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.read('job_legacy_1')).resolves.toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects incoherent records where the top-level handoffId disagrees with the status.handoffId', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-coherence-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.write({
        jobId: 'job_incoherent_1',
        handoffId: 'handoff_a',
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          handoffId: 'handoff_b',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      })).rejects.toMatchObject({ name: 'ZodError' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects incoherent records where status.jobId disagrees with the jobId (when provided)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-coherence-jobid-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.write({
        jobId: 'job_incoherent_2',
        handoffId: 'handoff_jobid',
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          handoffId: 'handoff_jobid',
          status: 'pending',
          phase: 'preparing',
          jobId: 'job_other',
          recoveryActions: [],
        },
      })).rejects.toMatchObject({ name: 'ZodError' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('keeps restart-recoverable pending jobs resumable instead of terminalizing them during daemon startup recovery', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-recoverable-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const nowMs = Date.now();
      const jobId = 'job_recoverable_1';
      const handoffId = 'handoff_recoverable_1';

      await store.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
        },
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
          handoffMetadataV2: {
            providerBundleTransferPublication: {
              transferId: `session-handoff:${handoffId}:provider-bundle`,
              sizeBytes: 123,
              manifestHash: 'hash',
              endpointCandidates: [
                { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: nowMs + 60_000, authorizationToken: 'tok' },
              ],
            },
          },
        },
      });

      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs,
      });

      await expect(store.read(jobId)).resolves.toMatchObject({
        jobId,
        handoffId,
        status: {
          status: 'pending',
          phase: 'staging_target',
        },
      });
      await expect(store.read(jobId)).resolves.not.toMatchObject({
        status: {
          status: 'awaiting_recovery',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('recovers a nonterminal v2 job through its versioned transition owner', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-recover-v2-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const nowMs = Date.now();
      const jobId = 'job_recover_v2';
      const handoffId = 'handoff_recover_v2';
      await store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_recover_v2',
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: { phaseDetail: 'importing_workspace' },
            resumable: false,
          },
        },
      });

      await recoverSessionHandoffPrepareTargetJobsAfterRestart({ activeServerDir, nowMs });

      await expect(store.read(jobId)).resolves.toMatchObject({
        schemaVersion: 2,
        recordKind: 'prepared_target',
        sessionId: 'session_recover_v2',
        transitionRevision: 1,
        updatedAtMs: nowMs,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          status: 'awaiting_recovery',
          progress: {
            updatedAtMs: nowMs,
            current: { phaseDetail: 'daemon_restart_missing_runner' },
          },
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('does not mark a prepare-target job awaiting_recovery while a live lease still exists on daemon startup', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-live-lease-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const nowMs = Date.now();
      const jobId = 'job_live_lease_1';
      const handoffId = 'handoff_live_lease_1';

      await store.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
        },
      });

      const leaseDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs-staging', jobId, 'lease');
      await mkdir(leaseDirectory, { recursive: true });
      const liveLeaseRecord = {
        ownerId: `cli-daemon:${process.pid}:current`,
        acquiredAtMs: nowMs - 5_000,
        renewedAtMs: nowMs - 50,
        expiresAtMs: nowMs + 60_000,
      };
      await writeFile(join(leaseDirectory, 'lease.json'), JSON.stringify(liveLeaseRecord), 'utf8');
      await writeFile(join(leaseDirectory, 'runner.json'), JSON.stringify(liveLeaseRecord), 'utf8');

      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs,
      });

      await expect(store.read(jobId)).resolves.toMatchObject({
        jobId,
        handoffId,
        status: {
          status: 'pending',
          phase: 'staging_target',
        },
      });
      await expect(store.read(jobId)).resolves.not.toMatchObject({
        status: {
          status: 'awaiting_recovery',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects missing-runner recovery when the exact acquired lease proof was replaced', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-exact-proof-'));
    const nowMs = Date.now();
    const jobId = 'job_exact_proof_replaced';
    const handoffId = 'handoff_exact_proof_replaced';
    const ownerId = 'status-probe:exact-proof';
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await store.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
      });
      const acquired = await tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId,
        nowMs,
        ttlMs: 15_000,
      });
      expect(acquired.acquired).toBe(true);
      const heartbeat = startSessionHandoffPrepareTargetJobLeaseHeartbeat({
        activeServerDir,
        jobId,
        ownerId,
        leaseId: acquired.lease!.leaseId!,
        ttlMs: 15_000,
        nowMs: () => Date.now(),
      });
      const leaseDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs-staging', jobId, 'lease');
      const successor = {
        leaseId: 'real-runner-successor-lease',
        attempt: 2,
        ownerId: 'real-runner:exact-proof-successor',
        acquiredAtMs: nowMs,
        renewedAtMs: nowMs,
        expiresAtMs: nowMs + 60_000,
      };
      await writeFile(join(leaseDirectory, 'lease.json'), `${JSON.stringify(successor)}\n`, 'utf8');
      await writeFile(join(leaseDirectory, 'runner.json'), `${JSON.stringify(successor)}\n`, 'utf8');

      const recovered = await store.recoverMissingRunner(jobId, nowMs, heartbeat.proof);

      expect(recovered?.status.status).toBe('pending');
      await heartbeat.stop();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('renews daemon-start proof across multiple heartbeats and makes recovery the expected winner', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-recovery-race-v2-'));
    const nowMs = Date.now();
    const jobId = 'job_recovery_race_v2';
    const handoffId = 'handoff_recovery_race_v2';
    const realRunnerOwnerId = 'real-runner:daemon-start-race';
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_recovery_race_v2',
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
      });

      const releaseMutationLock = createDeferred();
      const mutationLockEntered = createDeferred();
      const mutationLock = withJsonOwnerFileLock({
        lockPath: join(activeServerDir, 'session-handoff', 'prepare-target-jobs', `${jobId}.json.lock`),
        timeoutMs: 10_000,
        staleAfterMs: 30_000,
        errorCode: 'test_prepare_target_job_lock_timeout',
      }, async () => {
        mutationLockEntered.resolve();
        await releaseMutationLock.promise;
      });
      await mutationLockEntered.promise;

      recoveryWriteBarrier.arm(`/prepare-target-jobs/${jobId}.json`);
      const recovery = recoverSessionHandoffPrepareTargetJobsAfterRestart({ activeServerDir, nowMs });
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      releaseMutationLock.resolve();
      await mutationLock;
      await recoveryWriteBarrier.waitUntilEntered();

      const realRunnerAfterRecovery = tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: realRunnerOwnerId,
        // The real runner sees the proof lease as expired while the recovery write is paused.
        nowMs: Date.now() + 60_000,
        ttlMs: 60_000,
      });
      expect(await settlesWithin(realRunnerAfterRecovery)).toBe(false);
      recoveryWriteBarrier.release();
      await recovery;
      const recovered = await store.read(jobId);
      const realRunnerLease = await realRunnerAfterRecovery;
      await releaseSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: realRunnerOwnerId,
        leaseId: realRunnerLease.lease!.leaseId!,
      });

      expect(recovered?.status.status).toBe('awaiting_recovery');
      expect(realRunnerLease.acquired).toBe(true);
    } finally {
      recoveryWriteBarrier.release();
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('releases daemon-start missing-runner proof when the recovery transition throws', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-recovery-throw-'));
    const nowMs = Date.now();
    const jobId = 'job_recovery_throw_v2';
    const handoffId = 'handoff_recovery_throw_v2';
    const realRunnerOwnerId = 'real-runner:after-recovery-throw';
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await store.writePreparedV2({
        jobId,
        handoffId,
        sessionId: 'session_recovery_throw_v2',
        createdAtMs: nowMs,
        updatedAtMs: nowMs + 1_000,
        transitionRevision: 0,
        resume: { status: 'not_attempted' },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
      });

      await expect(recoverSessionHandoffPrepareTargetJobsAfterRestart({ activeServerDir, nowMs })).rejects.toThrow(
        'Session handoff v2 updatedAtMs cannot move backward',
      );
      const realRunnerLease = await tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: realRunnerOwnerId,
        nowMs: Date.now(),
        ttlMs: 60_000,
      });
      expect(realRunnerLease.acquired).toBe(true);
      await releaseSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: realRunnerOwnerId,
        leaseId: realRunnerLease.lease!.leaseId!,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
