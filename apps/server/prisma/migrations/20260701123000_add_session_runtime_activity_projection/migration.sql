ALTER TABLE "Session"
    ADD COLUMN "runtimeActivityActiveCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "runtimeActivityObservedAt" BIGINT,
    ADD COLUMN "runtimeActivityExpiresAt" BIGINT,
    ADD COLUMN "runtimeActivitySourceClass" TEXT;
