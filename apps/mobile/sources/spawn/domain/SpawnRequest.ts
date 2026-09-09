export type SpawnRejection =
    | { kind: 'no-agent'; message: string }
    | { kind: 'no-directory'; message: string };

/** One Agent or a squad the person is about to start. */
export class SpawnRequest {
    constructor(
        readonly directory: string,
        readonly kinds: readonly string[],
        readonly squad: boolean,
        readonly worktree: boolean,
    ) {}


    rejection(): SpawnRejection | null {
        if (this.kinds.length === 0) {
            return { kind: 'no-agent', message: 'Select an installed agent first.' };
        }
        if (this.directory === '') {
            return { kind: 'no-directory', message: 'Pick a directory first.' };
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
        if (this.squad) return { ...cwd, kinds: [...this.kinds], ...worktree };
        return { ...cwd, kind: this.kinds[0], ...worktree };
    }
}
