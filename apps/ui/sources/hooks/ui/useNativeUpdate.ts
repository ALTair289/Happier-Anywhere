import { storage } from '@/sync/domains/state/storage';
import { useShallow } from 'zustand/react/shallow';
import type { NativeUpdateStatus } from '@/sync/store/domains/realtime';

export function useNativeUpdateStatus(): NativeUpdateStatus {
    return storage(useShallow((state) => state.nativeUpdateStatus));
}

export function useNativeUpdate(): string | null {
    const nativeUpdateStatus = useNativeUpdateStatus();
    
    // Return the update URL if available, otherwise null
    return nativeUpdateStatus?.updateUrl || null;
}
