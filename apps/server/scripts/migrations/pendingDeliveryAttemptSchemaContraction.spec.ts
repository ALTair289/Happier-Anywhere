import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

describe("pending delivery attempt v1 final schema contraction", () => {
    it.each([
        "prisma/schema.prisma",
        "prisma/sqlite/schema.prisma",
        "prisma/mysql/schema.prisma",
    ])("removes the dormant attempt aggregate from every final Prisma schema: %s", async (schemaPath) => {
        const schema = await read(schemaPath);
        expect(schema).not.toContain("attempt_queued");
        expect(schema).not.toMatch(/activePendingAttemptId\s+String\?/);
        expect(schema).not.toMatch(/deliveryContract\s+String\?/);
        expect(schema).not.toContain("model SessionPendingDeliveryAttempt {");
        expect(schema).not.toContain("pendingDeliveryAttempts SessionPendingDeliveryAttempt[]");
        expect(schema).not.toContain("deliveryAttempts SessionPendingDeliveryAttempt[]");
        expect(schema).not.toContain("claimCredentialVerifier");
        expect(schema).not.toContain("runtimeIncarnationId");
        expect(schema).not.toMatch(/^\s*writeRisk\s+/m);
    });
});
