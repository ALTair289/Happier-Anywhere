ALTER TABLE "SessionPendingMessage" ADD COLUMN "deliveryState" TEXT;
ALTER TABLE "SessionPendingMessage" ADD COLUMN "deliveryBlockedReason" TEXT;

CREATE INDEX "SessionPendingMessage_sid_status_dstate_position_idx"
ON "SessionPendingMessage"("sessionId", "status", "deliveryState", "position");
