import { describe, expect, it } from "vitest";

import { generateMySqlSchemaFromPostgres, generateSqliteSchemaFromPostgres } from "./schemaSync";

describe("schemaSync", () => {
    it("generates provider-specific schemas from prisma/schema.prisma", () => {
        const master = `
generator client {
    provider        = "prisma-client-js"
    previewFeatures = ["metrics", "relationJoins"]
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model Account { id String @id }
`;

        const sqlite = generateSqliteSchemaFromPostgres(master);
        expect(sqlite).toContain('provider = "sqlite"');

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain('provider = "mysql"');
    });

    it("includes release binaryTargets in sqlite/mysql generator blocks (cross-compiled server binaries)", () => {
        const master = `
generator client {
    provider        = "prisma-client-js"
    previewFeatures = ["metrics", "relationJoins"]
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model Account { id String @id }
`;

        const sqlite = generateSqliteSchemaFromPostgres(master);
        expect(sqlite).toMatch(
            /binaryTargets\s*=\s*\["native",\s*"debian-openssl-3\.0\.x",\s*"linux-arm64-openssl-3\.0\.x",\s*"darwin",\s*"darwin-arm64",\s*"windows"\]/,
        );

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toMatch(
            /binaryTargets\s*=\s*\["native",\s*"debian-openssl-3\.0\.x",\s*"linux-arm64-openssl-3\.0\.x",\s*"darwin",\s*"darwin-arm64",\s*"windows"\]/,
        );
    });

    it("pins MySQL-indexed sha256 token hashes to VARBINARY(32)", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model PublicSessionShare {
    id        String @id
    tokenHash Bytes  @unique
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("tokenHash Bytes  @db.VarBinary(32) @unique");
    });

    it("pins all MySQL tokenHash unique fields to VARBINARY(32)", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model PublicSessionShare {
    id        String @id
    tokenHash Bytes  @unique
}

model InviteToken {
    id        String @id
    tokenHash Bytes  @unique
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        const matches = mysql.match(/tokenHash\s+Bytes\s+@db\.VarBinary\(32\)\s+@unique/g) ?? [];
        expect(matches).toHaveLength(2);
    });

	    it("uses LongText for large encrypted state blobs in MySQL", () => {
	        const master = `
	generator client {
	    provider = "prisma-client-js"
	}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

	model Session {
	    id        String @id
	    metadata  String
	    agentState String?
	}

	model Account {
	    id       String @id
	    settings String?
	}

	model AccountSettingsSnapshot {
	    id              String @id
	    settingsDbValue String?
	}

	model Machine {
	    id         String @id
	    metadata   String
	    daemonState String?
	}
	`;

	        const mysql = generateMySqlSchemaFromPostgres(master);
	        expect(mysql).toContain("metadata  String @db.LongText");
	        expect(mysql).toContain("agentState String? @db.LongText");
	        expect(mysql).toContain("settings String? @db.LongText");
	        expect(mysql).toContain("settingsDbValue String? @db.LongText");
	        expect(mysql).toContain("daemonState String? @db.LongText");
	    });

	    it("uses LongText for connected-service auth group JSON strings in MySQL", () => {
	        const master = `
	generator client {
	    provider = "prisma-client-js"
	}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

	model ConnectedServiceAuthGroup {
	    id         String @id
	    policyJson String
	    stateJson  String?
	}

	model ConnectedServiceAuthGroupMember {
	    id        String @id
	    stateJson String?
	}
	`;

	        const mysql = generateMySqlSchemaFromPostgres(master);
	        expect(mysql).toContain("policyJson String @db.LongText");
	        expect(mysql).toContain("stateJson  String? @db.LongText");
	        expect(mysql).toContain("stateJson String? @db.LongText");
	    });

    it("uses LongText for session organization legacy keys and display envelopes in MySQL", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model SessionOrganizationFolder {
    id             String @id
    folderKey      String
    parentKey      String?
    displayDbValue String?
}

model SessionOrganizationOrderEntry {
    id       String @id
    scopeKey String
    itemKey  String
}

model SessionOrganizationLabel {
    id             String @id
    scopeKey       String
    displayDbValue String?
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("folderKey      String @db.LongText");
        expect(mysql).toContain("parentKey      String? @db.LongText");
        expect(mysql).toContain("displayDbValue String? @db.LongText");
        expect(mysql).toContain("scopeKey String @db.LongText");
        expect(mysql).toContain("itemKey  String @db.LongText");
    });
	});
