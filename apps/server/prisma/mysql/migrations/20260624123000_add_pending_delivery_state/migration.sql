ALTER TABLE `SessionPendingMessage`
ADD COLUMN `deliveryState` VARCHAR(191) NULL,
ADD COLUMN `deliveryBlockedReason` VARCHAR(191) NULL;

CREATE INDEX `SessionPendingMessage_sid_status_dstate_position_idx`
ON `SessionPendingMessage`(`sessionId`, `status`, `deliveryState`, `position`);
