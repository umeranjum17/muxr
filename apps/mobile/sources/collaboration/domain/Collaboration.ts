export type CollaborationSummaryKind = 'off' | 'needs-attention' | 'disconnecting' | 'setting-up' | 'connected';

export type CollaborationIntentView = {
    selectedMachineIds: readonly string[];
    edges: ReadonlyArray<{
        sourceMachineId: string;
        targetMachineId: string;
        setup?: { repairNeeded?: boolean };
        disconnect?: { repair?: true };
    }>;
};

/**
 * The person's intended mesh of paired computers. Machine ids authorize;
 * computer names never do. Two to six computers, or none.
 */
export class Collaboration {
    constructor(readonly intent: CollaborationIntentView) {}

    summaryKind(): CollaborationSummaryKind {
        if (this.intent.selectedMachineIds.length < 2 && this.intent.edges.length === 0) return 'off';
        if (this.intent.edges.some((edge) => edge.setup?.repairNeeded || edge.disconnect?.repair)) {
            return 'needs-attention';
        }
        if (this.intent.edges.some((edge) => edge.disconnect !== undefined)) return 'disconnecting';
        if (this.intent.edges.some((edge) => edge.setup !== undefined)) return 'setting-up';
        return 'connected';
    }

    summaryCopy(): string {
        switch (this.summaryKind()) {
            case 'off': return 'Off';
            case 'needs-attention': return 'Needs attention';
            case 'disconnecting': return 'Disconnecting';
            case 'setting-up': return 'Setting up';
            case 'connected': return `${this.intent.selectedMachineIds.length} computers`;
        }
    }

    includesMachine(machineId: string): boolean {
        if (this.intent.selectedMachineIds.includes(machineId)) return true;
        return this.intent.edges.some((edge) =>
            edge.sourceMachineId === machineId || edge.targetMachineId === machineId);
    }

    hasPendingWork(): boolean {
        const waitingToStart = this.intent.selectedMachineIds.length >= 2 && this.intent.edges.length === 0;
        if (waitingToStart) return true;
        return this.intent.edges.some((edge) => edge.setup !== undefined || edge.disconnect !== undefined);
    }

    static selectionCountAllowed(count: number): boolean {
        return count === 0 || (count >= 2 && count <= 6);
    }
}
