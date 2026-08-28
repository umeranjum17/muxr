import {
    applyCollaboration,
    selectCollaborationMachines,
    type CollaborationIntent,
    type CollaborationMachine,
    type CollaborationReport,
    type PeerRequester,
} from './computerCollaboration';

export type GrantPeerAuthorityCommand = {
    intent: CollaborationIntent;
    selected: CollaborationMachine[];
    machines: CollaborationMachine[];
    request: PeerRequester;
};

/** Authorize the selected Machines to reach each other. Machine ids authorize. */
export async function grantPeerAuthority(command: GrantPeerAuthorityCommand): Promise<CollaborationReport> {
    const next = selectCollaborationMachines(command.intent, command.selected);
    return applyCollaboration(next, command.machines, command.request);
}
