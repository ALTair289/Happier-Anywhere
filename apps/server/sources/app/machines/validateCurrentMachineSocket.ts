import { db } from "@/storage/db";

type MachineSocketValidationStore = Readonly<{
    machine: {
        findFirst: (args: {
            where: { accountId: string; id: string };
            select: { revokedAt: true; replacedByMachineId: true };
        }) => Promise<{ revokedAt: Date | null; replacedByMachineId: string | null } | null>;
    };
}>;

export type CurrentMachineSocketValidationResult =
    | { ok: true }
    | { ok: false; reason: "machine_not_found" | "machine_revoked" | "machine_replaced" };

export type CurrentMachineSocketValidationErrorReason =
    Extract<CurrentMachineSocketValidationResult, { ok: false }>["reason"];

export function classifyCurrentMachineSocketRecord(
    machine: Readonly<{ revokedAt: Date | null; replacedByMachineId: string | null }> | null,
): CurrentMachineSocketValidationResult {
    if (!machine) return { ok: false, reason: "machine_not_found" };
    if (machine.revokedAt) return { ok: false, reason: "machine_revoked" };
    if (machine.replacedByMachineId) return { ok: false, reason: "machine_replaced" };
    return { ok: true };
}

export async function validateCurrentMachineSocket(params: Readonly<{
    accountId: string;
    machineId: string;
    store?: MachineSocketValidationStore;
}>): Promise<CurrentMachineSocketValidationResult> {
    const store = params.store ?? db;
    const machine = await store.machine.findFirst({
        where: { accountId: params.accountId, id: params.machineId },
        select: { revokedAt: true, replacedByMachineId: true },
    });
    return classifyCurrentMachineSocketRecord(machine);
}

export function formatCurrentMachineSocketError(reason: CurrentMachineSocketValidationErrorReason): string {
    switch (reason) {
        case "machine_not_found":
            return "Machine not found";
        case "machine_revoked":
            return "Machine revoked";
        case "machine_replaced":
            return "Machine replaced";
    }
}
