import { inspectPeerMutation, type PeerMutationMetadata, type PeerMutationRejection } from '../domain/peer.js';
import type { Outcome } from '../../shared/outcome.js';

/** Admit a Peer Mutation before dispatch. Expected rejection is expired or window-too-long. */
export function admitPeerMutation(command: {
    mutation: unknown;
    now: number;
}): Outcome<PeerMutationMetadata, PeerMutationRejection> {
    return inspectPeerMutation(command.mutation, command.now);
}
