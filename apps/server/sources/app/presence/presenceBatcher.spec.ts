import { describe, expect, it } from "vitest";
import { PresenceBatcher } from "./presenceBatcher";

describe("PresenceBatcher", () => {
    it("coalesces to the max timestamp per machine", () => {
        const batcher = new PresenceBatcher();

        batcher.recordMachineAlive("u1", "m1", 10);
        batcher.recordMachineAlive("u1", "m1", 9);
        batcher.recordMachineAlive("u1", "m1", 12);

        const first = batcher.drain();
        expect(first.machines).toEqual([{ accountId: "u1", machineId: "m1", timestamp: 12 }]);

        const second = batcher.drain();
        expect(second.machines).toEqual([]);
    });

    it("commit() does not drop newer timestamps recorded after snapshot", () => {
        const batcher = new PresenceBatcher();

        batcher.recordMachineAlive("u1", "m1", 10);
        const snap = batcher.snapshot();
        batcher.recordMachineAlive("u1", "m1", 11);

        batcher.commit(snap);

        const after = batcher.drain();
        expect(after.machines).toEqual([{ accountId: "u1", machineId: "m1", timestamp: 11 }]);
    });
});
