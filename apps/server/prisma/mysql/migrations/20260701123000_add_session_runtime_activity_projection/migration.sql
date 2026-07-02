ALTER TABLE `Session`
ADD COLUMN `runtimeActivityActiveCount` INTEGER NOT NULL DEFAULT 0,
ADD COLUMN `runtimeActivityObservedAt` BIGINT NULL,
ADD COLUMN `runtimeActivityExpiresAt` BIGINT NULL,
ADD COLUMN `runtimeActivitySourceClass` VARCHAR(191) NULL;
