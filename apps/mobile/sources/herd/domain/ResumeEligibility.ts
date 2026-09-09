export type ResumeAvailability = {
    canResume: boolean;
    canShowResume: boolean;
    subtitle: string;
    message: string;
};

function unavailable(): ResumeAvailability {
    return { canResume: false, canShowResume: false, subtitle: '', message: '' };
}

function blocked(message: string): ResumeAvailability {
    return { canResume: false, canShowResume: true, subtitle: message, message };
}

function ready(message: string): ResumeAvailability {
    return { canResume: true, canShowResume: true, subtitle: message, message };
}

/**
 * Whether this Agent can be resumed on its Machine. Display metadata never
 * authorizes; missing machine id is a hard no.
 */
export class ResumeEligibility {
    static decide(input: {
        exists: boolean;
        isRig: boolean;
        hostAllowsResume: boolean;
        isConnected: boolean;
        machineId: string | undefined;
        machineKnown: boolean;
        machineOnline: boolean;
        copy: {
            missingMachine: string;
            sameMachineOnly: string;
            machineOffline: string;
            ready: string;
        };
    }): ResumeAvailability {
        if (!input.exists) return unavailable();
        if (input.isRig || !input.hostAllowsResume) return unavailable();
        if (input.isConnected) return unavailable();
        if (!input.machineId) return blocked(input.copy.missingMachine);
        if (!input.machineKnown) return blocked(input.copy.sameMachineOnly);
        if (!input.machineOnline) return blocked(input.copy.machineOffline);
        return ready(input.copy.ready);
    }
}
