/**
 * Loopback WebSocket URLs. Admission policy lives in domain.
 */
import { usesLoopbackWsAuth } from '../domain/admission.js';

export function loopbackMachineSocketUrl(relayUrl: string, machineId: string, token?: string): string {
    const url = `${relayUrl}?role=machine&machineId=${encodeURIComponent(machineId)}`;
    if (token === undefined) return url;
    return `${url}&token=${encodeURIComponent(token)}`;
}
