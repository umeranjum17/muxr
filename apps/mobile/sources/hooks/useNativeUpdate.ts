import { storage } from '@/catalog/store';
import { useShallow } from 'zustand/react/shallow';

export function useNativeUpdate(): string | null {
    // Get native update status from global storage
    const nativeUpdateStatus = storage(useShallow((state) => state.nativeUpdateStatus));
    
    // Return the update URL if available, otherwise null
    return nativeUpdateStatus?.updateUrl || null;
}