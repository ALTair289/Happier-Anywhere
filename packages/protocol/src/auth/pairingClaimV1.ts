import { z } from 'zod';

export const PAIRING_CLAIM_V1_MAX_TTL_MS = 600_000;

export function normalizePairingClaimOriginV1(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_048) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export const PairingClaimOriginV1Schema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => normalizePairingClaimOriginV1(value) !== null, 'Expected a credential-free HTTPS origin')
  .transform((value) => normalizePairingClaimOriginV1(value)!);

export const PairingClaimIdV1Schema = z.string().regex(/^claim_[A-Za-z0-9_-]{43}$/);

export const PairingClaimStartRequestV1Schema = z
  .object({
    origin: PairingClaimOriginV1Schema,
  })
  .strict();

export const PairingClaimStartResponseV1Schema = z
  .object({
    protocol: z.literal('claim-v1'),
    claimId: PairingClaimIdV1Schema,
    origin: PairingClaimOriginV1Schema,
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const PairingClaimConsumeRequestV1Schema = z
  .object({
    claimId: PairingClaimIdV1Schema,
    origin: PairingClaimOriginV1Schema,
    publicKey: z.string().min(1).max(256),
    deviceLabel: z.string().max(256).optional(),
  })
  .strict();

export const PairingClaimConsumeResponseV1Schema = z
  .object({
    state: z.literal('requested'),
    confirmCode: z.string(),
  })
  .strict();

export const PairingClaimNotFoundResponseV1Schema = z.object({ error: z.literal('not_found') }).strict();
export const PairingClaimInvalidPublicKeyResponseV1Schema = z
  .object({ error: z.literal('Invalid public key') })
  .strict();

export type PairingClaimStartRequestV1 = z.infer<typeof PairingClaimStartRequestV1Schema>;
export type PairingClaimStartResponseV1 = z.infer<typeof PairingClaimStartResponseV1Schema>;
export type PairingClaimConsumeRequestV1 = z.infer<typeof PairingClaimConsumeRequestV1Schema>;
export type PairingClaimConsumeResponseV1 = z.infer<typeof PairingClaimConsumeResponseV1Schema>;
