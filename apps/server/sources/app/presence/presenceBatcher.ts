type MachinePresence = { accountId: string; machineId: string; timestamp: number };

export class PresenceBatcher {
    private machineByKey = new Map<string, MachinePresence>();

    recordMachineAlive(accountId: string, machineId: string, timestamp: number): void {
        const key = `${accountId}:${machineId}`;
        const existing = this.machineByKey.get(key);
        if (!existing || timestamp > existing.timestamp) {
            this.machineByKey.set(key, { accountId, machineId, timestamp });
        }
    }

    snapshot(): { machines: MachinePresence[] } {
        const machines = Array.from(this.machineByKey.values());
        return { machines };
    }

    commit(snapshot: { machines: MachinePresence[] }): void {
        // Remove only entries that have not been superseded since the snapshot.
        for (const m of snapshot.machines) {
            const key = `${m.accountId}:${m.machineId}`;
            const current = this.machineByKey.get(key);
            if (current && current.timestamp <= m.timestamp) {
                this.machineByKey.delete(key);
            }
        }
    }

    drain(): { machines: MachinePresence[] } {
        const { machines } = this.snapshot();
        this.machineByKey.clear();
        return { machines };
    }
}
