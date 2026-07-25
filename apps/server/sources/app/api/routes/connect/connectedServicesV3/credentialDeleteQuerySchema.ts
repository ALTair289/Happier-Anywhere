import { z } from "zod";
import { ConnectedServiceCredentialRevisionV1Schema } from "@happier-dev/protocol";

function parseBooleanQueryFlag(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0" || normalized === "") return false;
    return value;
}

export const ConnectedServiceCredentialDeleteQuerySchema = z.object({
    cleanupGroupReferences: z.preprocess(parseBooleanQueryFlag, z.boolean().optional()),
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema.optional(),
});
