import { activityCache } from "./sessionCache";
import { shouldPublishPresenceToRedis } from "./presenceMode";
import { publishMachineAlive } from "./presenceRedisQueue";
import { log } from "@/utils/logging/log";

export async function recordMachineAlive(params: { accountId: string; machineId: string; timestamp: number }): Promise<void> {
    const shouldPersist = activityCache.queueMachineUpdate(params.machineId, params.timestamp);
    if (!shouldPersist) return;
    if (!shouldPublishPresenceToRedis(process.env)) return;
    try {
        await publishMachineAlive({ accountId: params.accountId, machineId: params.machineId, timestamp: params.timestamp });
        activityCache.markMachineUpdateSent(params.machineId, params.timestamp);
    } catch (e) {
        log({ module: "presence-recorder", level: "warn" }, `Failed to publish machine alive: ${e}`);
    }
}
