import { z } from 'zod';

export const DEFAULT_SESSION_MESSAGES_CAPABILITIES = Object.freeze({
  role: false,
});

export const SessionMessagesCapabilitiesSchema = z
  .object({
    role: z.boolean().optional().default(DEFAULT_SESSION_MESSAGES_CAPABILITIES.role),
  })
  .optional()
  .default(DEFAULT_SESSION_MESSAGES_CAPABILITIES);

export type SessionMessagesCapabilities = z.infer<typeof SessionMessagesCapabilitiesSchema>;

const SessionProtocolCapabilitySchema = z.object({
  protocolVersion: z.number().int().positive(),
}).strict();

export const SessionRuntimeActivityCapabilitiesSchema = SessionProtocolCapabilitySchema;
export const SessionPendingInputCapabilitiesSchema = SessionProtocolCapabilitySchema;

export type SessionRuntimeActivityCapabilities = z.infer<typeof SessionRuntimeActivityCapabilitiesSchema>;
export type SessionPendingInputCapabilities = z.infer<typeof SessionPendingInputCapabilitiesSchema>;

export const DEFAULT_SESSION_CAPABILITIES = Object.freeze({
  messages: DEFAULT_SESSION_MESSAGES_CAPABILITIES,
});

export const SessionCapabilitiesSchema = z
  .object({
    messages: SessionMessagesCapabilitiesSchema,
    runtimeActivity: SessionRuntimeActivityCapabilitiesSchema.optional(),
    pendingInput: SessionPendingInputCapabilitiesSchema.optional(),
  })
  .optional()
  .default(DEFAULT_SESSION_CAPABILITIES);

export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;
