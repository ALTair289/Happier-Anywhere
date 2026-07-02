ALTER TABLE "Session" ADD COLUMN "runtimeActivityActiveCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "runtimeActivityObservedAt" BIGINT;
ALTER TABLE "Session" ADD COLUMN "runtimeActivityExpiresAt" BIGINT;
ALTER TABLE "Session" ADD COLUMN "runtimeActivitySourceClass" TEXT;
