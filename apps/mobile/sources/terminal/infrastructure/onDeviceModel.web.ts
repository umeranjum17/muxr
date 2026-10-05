import type { LocalModel, InferState } from '@byokit/infer';

/** The browser has no on-device model binding. */
export function openOnDeviceModel(_onState: (state: InferState) => void): LocalModel | null {
    return null;
}
