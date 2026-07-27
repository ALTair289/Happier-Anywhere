import * as React from 'react';

import { useAllMachines } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

export function resolveConnectedServiceRecoveryCreditMachineTarget(params: Readonly<{
    machines: ReadonlyArray<Machine>;
}>): string | null {
    return params.machines.find(isMachineOnline)?.id ?? null;
}

export function useConnectedServiceRecoveryCreditMachineTarget(): string | null {
    const machines = useAllMachines();

    return React.useMemo(() => resolveConnectedServiceRecoveryCreditMachineTarget({
        machines,
    }), [machines]);
}
