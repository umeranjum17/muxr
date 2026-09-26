export type DaemonMode = 'selfhost' | 'relay';

export function parseDaemonMode(unitText: string): DaemonMode | undefined {
    if (/MUXR_MODE[\s\S]{0,80}selfhost/.test(unitText)) return 'selfhost';
    if (/MUXR_MODE[\s\S]{0,80}relay/.test(unitText)) return 'relay';
    return undefined;
}

export function parseDaemonModeArg(value: unknown): DaemonMode {
    if (value === 'selfhost' || value === 'relay') return value;
    throw new Error('--mode must be selfhost or relay');
}
