export type MachineRecord = {
    id: string;
    active: boolean;
    displayName?: string;
    host?: string;
};

/** A paired computer running herdr. Identity is the machine id, never the display name. */
export class PairedMachine {
    constructor(readonly record: MachineRecord) {}

    get id(): string {
        return this.record.id;
    }

    isOnline(): boolean {
        return this.record.active;
    }

    title(): string {
        return this.record.displayName || this.record.host || 'Unknown machine';
    }

    pairedTitle(): string {
        return this.title() === 'Unknown machine' ? 'Paired computer' : this.title();
    }
}
