export type SpawnMember = { kind: string; displayName?: string };

export type SpawnRejection =
    | { kind: 'no-agent'; message: string }
    | { kind: 'no-directory'; message: string }
    | { kind: 'duplicate-names'; message: string };

/**
 * One Agent or a squad the person is about to start. Display names never
 * authorize; they only fail the request when two members share one.
 */
export class SpawnRequest {
    constructor(
        readonly directory: string,
        readonly kinds: readonly string[],
        readonly namedMembers: readonly SpawnMember[],
        readonly squad: boolean,
        readonly worktree: boolean,
    ) {}

    hasDuplicateNames(): boolean {
        const normalized = this.namedMembers.flatMap((member) => {
            if (member.displayName === undefined) return [];
            return [member.displayName.replace(/\s+/g, ' ').toLocaleLowerCase()];
        });
        return new Set(normalized).size !== normalized.length;
    }

    rejection(): SpawnRejection | null {
        if (this.kinds.length === 0) {
            return { kind: 'no-agent', message: 'Select an installed agent first.' };
        }
        if (this.directory === '') {
            return { kind: 'no-directory', message: 'Pick a directory first.' };
        }
        if (this.hasDuplicateNames()) {
            return { kind: 'duplicate-names', message: 'Give each squad member a different name.' };
        }
        return null;
    }

    startButtonLabel(): string {
        if (this.kinds.length === 0) return 'Select an installed agent';
        if (this.kinds.length > 1) return `Start squad (${this.kinds.length})`;
        return `Start ${this.kinds[0]}`;
    }

    startParams(createCwd: boolean): Record<string, unknown> {
        const cwd = { cwd: this.directory, ...(createCwd ? { createCwd: true } : {}) };
        const worktree = this.worktree ? { worktree: {} } : {};
        if (this.squad) {
            return { ...cwd, kinds: [...this.kinds], members: [...this.namedMembers], ...worktree };
        }
        const displayName = this.namedMembers[0]?.displayName;
        return {
            ...cwd,
            kind: this.kinds[0],
            ...(displayName === undefined ? {} : { displayName }),
            ...worktree,
        };
    }
}
