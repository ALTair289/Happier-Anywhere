import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function readSessionModel(schemaPath: string): string {
    const schema = readFileSync(resolve(process.cwd(), schemaPath), "utf8");
    const model = schema.match(/model Session \{([\s\S]*?)\n\}/)?.[1];
    if (!model) throw new Error(`Session model missing from ${schemaPath}`);
    return model;
}

describe("Session publisher presence schema ownership", () => {
    it.each([
        "prisma/schema.prisma",
        "prisma/mysql/schema.prisma",
        "prisma/sqlite/schema.prisma",
    ])("defaults Session.active to false in %s", (schemaPath) => {
        expect(readSessionModel(schemaPath)).toMatch(/\bactive\s+Boolean\s+@default\(false\)/);
    });
});
