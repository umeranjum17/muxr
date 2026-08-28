import { peerCapabilityForRequest, type ClientRequest, type RequestResponse } from '@muxr/contract';
import { peerGrantAllowsRequest, peerRequestRequiresMutationReceipt, peerStartUsesUnapprovedOptions, type PeerDeviceContext } from '../domain/startPolicy.js';

export type AdmitPeerRequestResult = RequestResponse;

export interface AdmitPeerRequestPorts {
    startAllowed(cwd: string, allowed: readonly string[] | undefined): boolean;
    assertRecoveryReady(): void;
    noteRecoveryWork(): void;
    executeReceipt(
        deviceId: string,
        type: 'session.prompt' | 'session.start' | 'agent.watch',
        mutation: NonNullable<Extract<ClientRequest, { type: 'session.prompt' | 'session.start' | 'agent.watch' }>['params']['peerMutation']>,
        params: Extract<ClientRequest, { type: 'session.prompt' | 'session.start' | 'agent.watch' }>['params'],
        execute: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string; code?: string }>,
    ): Promise<{ ok: true; data: unknown } | { ok: false; error: string; code?: string }>;
}

/**
 * Admit an inbound peer request onto this Machine.
 * Agent Route still authorizes Agents; the Device Grant authorizes the wire.
 */
export async function admitPeerRequest(
    ports: AdmitPeerRequestPorts,
    request: ClientRequest,
    deviceId: string,
    context: PeerDeviceContext,
    execute: () => Promise<RequestResponse>,
): Promise<AdmitPeerRequestResult> {
    const capability = peerCapabilityForRequest(request.type);
    if (!peerGrantAllowsRequest(context.kind, capability, context.capabilities)) {
        return { type: 'result', requestId: request.requestId, ok: false, error: 'peer grant forbids this request', code: 'peer-forbidden' };
    }
    if (request.type === 'session.start' && (peerStartUsesUnapprovedOptions(request.params) || !ports.startAllowed(request.params.cwd, context.allowedCwds))) {
        return { type: 'result', requestId: request.requestId, ok: false, error: 'peer start is outside its approved surface', code: 'peer-forbidden' };
    }
    if (!peerRequestRequiresMutationReceipt(request)) {
        return execute();
    }
    const mutation = request.params.peerMutation;
    if (mutation === undefined) {
        return { type: 'result', requestId: request.requestId, ok: false, error: 'peer mutation metadata is required', code: 'peer-mutation-required' };
    }
    try {
        ports.assertRecoveryReady();
        const outcome = await ports.executeReceipt(deviceId, request.type, mutation, request.params, async () => {
            const response = await execute();
            if (response.ok) return { ok: true as const, data: response.data };
            return { ok: false as const, error: response.error, ...(response.code === undefined ? {} : { code: response.code }) };
        });
        if (outcome.ok) return { type: 'result', requestId: request.requestId, ok: true, data: outcome.data };
        return { type: 'result', requestId: request.requestId, ok: false, error: outcome.error, ...(outcome.code === undefined ? {} : { code: outcome.code }) };
    } catch (error) {
        ports.noteRecoveryWork();
        return {
            type: 'result', requestId: request.requestId, ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...((error as { code?: unknown }).code === undefined ? {} : { code: String((error as { code: unknown }).code) }),
        };
    }
}
