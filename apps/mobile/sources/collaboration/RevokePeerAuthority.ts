import {
    applyCollaboration,
    selectCollaborationMachines,
    type CollaborationIntent,
    type CollaborationMachine,
    type CollaborationReport,
    type PeerRequester,
} from './computerCollaboration';

export type RevokePeerAuthorityCommand = {
    intent: CollaborationIntent;
    machines: CollaborationMachine[];
    request: PeerRequester;
};

/** Tear down Collaboration so paired Machines no longer reach each other. */
export async function revokePeerAuthority(command: RevokePeerAuthorityCommand): Promise<CollaborationReport> {
    const next = selectCollaborationMachines(command.intent, []);
    return applyCollaboration(next, command.machines, command.request);
}
