import { z } from 'zod';

import {
  ClientKindAppVersionMapV1Schema,
  ClientKindUpgradeUrlMapV1Schema,
  SessionSyncProtocolVersionSchema,
} from './primitives.js';

export const SessionSyncCompatibilityEnforcementSchema = z.enum(['observe', 'required']);

export const SessionSyncServerRequirementsV1Schema = z
  .object({
    v: z.literal(1),
    enforcement: SessionSyncCompatibilityEnforcementSchema,
    minimumSessionSyncProtocolVersion: SessionSyncProtocolVersionSchema,
    declarationTransport: z.literal('headers-v1'),
    minimumVersionsByClientKind: ClientKindAppVersionMapV1Schema.optional(),
    upgradeUrlsByClientKind: ClientKindUpgradeUrlMapV1Schema.optional(),
  })
  .strict();

export type SessionSyncServerRequirementsV1 = z.infer<typeof SessionSyncServerRequirementsV1Schema>;

export const ClientCompatibilityCapabilitiesV1Schema = z
  .object({
    v: z.literal(1),
    sessionSync: SessionSyncServerRequirementsV1Schema,
  })
  .strict();

export type ClientCompatibilityCapabilitiesV1 = z.infer<typeof ClientCompatibilityCapabilitiesV1Schema>;
