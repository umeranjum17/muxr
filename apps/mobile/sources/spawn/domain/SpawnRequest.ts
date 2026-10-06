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

    /** Says what will start and where, or what is still missing. */
    startButtonLabel(): string {
        if (this.kinds.length === 0) return 'Choose an agent to start';
        if (this.directory === '') return 'Choose a folder to start';
        const where = this.directory.split('/').filter(Boolean).pop() ?? this.directory;
        const what = this.kinds.length > 1 ? `${this.kinds.length} agents` : this.kinds[0];
        return `Start ${what} in ${where}`;
    }

    startParams(createCwd: boolean): Record<string, unknown> {
        const cwd = { cwd: this.directory, ...(createCwd ? { createCwd: true } : {}) };
        const worktree = this.worktree ? { worktree: {} } : {};
        if (this.squad) return { ...cwd, kinds: [...this.kinds], ...worktree };
        return { ...cwd, kind: this.kinds[0], ...worktree };
    }
}
