export type SpawnSessionType = 'simple' | 'worktree';

const NONE = '__none__';
const CREATE_NEW = '__new__';

/** Which Worktree the next Spawn uses. Picker keys are not Agent Routes. */
export class WorktreeSelection {
    constructor(
        readonly sessionType: SpawnSessionType,
        readonly worktreeKey: string | null,
    ) {}

    static none(): WorktreeSelection {
        return new WorktreeSelection('simple', null);
    }

    static createNew(): WorktreeSelection {
        return new WorktreeSelection('worktree', null);
    }

    static existing(key: string): WorktreeSelection {
        return new WorktreeSelection('worktree', key);
    }

    static fromPickerKey(key: string): WorktreeSelection {
        if (key === NONE) return WorktreeSelection.none();
        if (key === CREATE_NEW) return WorktreeSelection.createNew();
        return WorktreeSelection.existing(key);
    }

    pickerKey(): string {
        if (this.sessionType === 'worktree') return this.worktreeKey ?? CREATE_NEW;
        return NONE;
    }

    isNone(): boolean {
        return this.sessionType === 'simple';
    }

    wantsNewCheckout(): boolean {
        return this.sessionType === 'worktree' && this.worktreeKey === null;
    }

    existingPath(): string | null {
        if (this.sessionType !== 'worktree') return null;
        return this.worktreeKey;
    }
}
