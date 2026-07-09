import { z } from 'zod';

/**
 * Wire contract for the daemon run-materialization bridge. The runner POSTs here (DEDICATED scoped
 * run-materialize capability token, mirroring the broker-bridge least-privilege precedent) to obtain the CS env for an execution run. Only PATHS
 * (e.g. `CODEX_HOME`) cross the wire — never token/secret values (those live inside the materialized
 * home the daemon owns).
 */
export const EXECUTION_RUN_CONNECTED_SERVICE_MATERIALIZE_PATH =
  '/connected-service-auth/execution-run/materialize';

export const ExecutionRunConnectedServiceMaterializeRequestSchema = z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1),
  pid: z.number().int().positive(),
  materializationKey: z.string().min(1),
  connectedServicesBindingsRaw: z.unknown(),
  sessionDirectory: z.string().nullable().optional(),
  sessionId: z.string().min(1).optional(),
});

export type ExecutionRunConnectedServiceMaterializeRequestWire =
  z.infer<typeof ExecutionRunConnectedServiceMaterializeRequestSchema>;

export const ExecutionRunConnectedServiceMaterializeResponseSchema = z.object({
  env: z.record(z.string(), z.string()),
});

export type ExecutionRunConnectedServiceMaterializeResponseWire =
  z.infer<typeof ExecutionRunConnectedServiceMaterializeResponseSchema>;

/** Run-end lifecycle: unregister the run's runtime target + clean the run-scoped materialized root. */
export const EXECUTION_RUN_CONNECTED_SERVICE_RELEASE_PATH =
  '/connected-service-auth/execution-run/release';

export const ExecutionRunConnectedServiceReleaseRequestSchema = z.object({
  runId: z.string().min(1),
  pid: z.number().int().positive(),
  materializationKey: z.string().min(1),
});

export type ExecutionRunConnectedServiceReleaseRequestWire =
  z.infer<typeof ExecutionRunConnectedServiceReleaseRequestSchema>;

export const ExecutionRunConnectedServiceReleaseResponseSchema = z.object({
  released: z.boolean(),
});

export type ExecutionRunConnectedServiceReleaseResponseWire =
  z.infer<typeof ExecutionRunConnectedServiceReleaseResponseSchema>;
