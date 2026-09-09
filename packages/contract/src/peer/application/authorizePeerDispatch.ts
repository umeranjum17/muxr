import { fail, ok, type Outcome } from '../../shared/outcome.js';
import { peerCapabilityForRequest, type PeerCapability } from '../domain/peer.js';

/** Decide whether a Peer Allowlist authorizes this request. */
export function authorizePeerDispatch(command: {
    allowlist: readonly PeerCapability[];
    requestType: string;
}): Outcome<PeerCapability> {
    const needed = peerCapabilityForRequest(command.requestType);
    if (needed === undefined || !command.allowlist.includes(needed)) return fail('peer-forbidden');
    return ok(needed);
}
