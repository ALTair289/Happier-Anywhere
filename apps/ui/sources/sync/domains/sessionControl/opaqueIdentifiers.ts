import { z } from 'zod';

/** ACP session-control identifiers and enum values are provider-owned opaque strings. */
export function readNonBlankSessionControlIdentifier(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function readSessionControlValueId(value: unknown): string | null {
    if (typeof value === 'string') return readNonBlankSessionControlIdentifier(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

export const opaqueSessionControlIdentifierSchema = z.string().refine(
    (value) => value.trim().length > 0,
    { message: 'Identifier must not be blank' },
);
