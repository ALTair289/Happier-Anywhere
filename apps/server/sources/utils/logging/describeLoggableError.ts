/**
 * Render an unknown thrown value into an own-enumerable object the log serializer can emit.
 *
 * `Error.prototype.message` and `.stack` are non-enumerable, so logging `{ error }` directly drops
 * the only fields that identify the failure — a class of log line that records that something failed
 * without recording what. Class fields declared on error subclasses (`code`, `cause` on Prisma and
 * on the transaction wrapper) survive, which is why some errors look diagnosable and others do not.
 */
export function describeLoggableError(error: unknown): Readonly<{ name?: string; code?: string; message: string }> {
    if (error instanceof Error) {
        const codeCandidate = (error as Error & { code?: unknown }).code;
        return {
            name: error.name,
            ...(typeof codeCandidate === "string" ? { code: codeCandidate } : {}),
            message: error.message,
        };
    }
    if (typeof error === "string") return { message: error };
    return { message: String(error) };
}
