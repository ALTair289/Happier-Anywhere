-- Cross-group source-link clobber fix (R3-5):
-- A connected-service profile can belong to multiple auth groups, and each
-- group_member link owns a distinct sourceKey. The previous UNIQUE on
-- (accountId, serviceId, profileId) forced those links to collide, so a second
-- group's link overwrote the first. Source identity is (accountId, sourceKey)
-- (already UNIQUE); demote the profile tuple to a plain lookup index so per-group
-- links coexist while profile-scoped reads/deletes stay indexed.

-- DropIndex
DROP INDEX "ConnectedServiceUsageSource_accountId_serviceId_profileId_key";

-- CreateIndex
CREATE INDEX "csus_account_service_profile_idx" ON "ConnectedServiceUsageSource"("accountId", "serviceId", "profileId");
