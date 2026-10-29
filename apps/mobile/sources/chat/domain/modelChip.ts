/** Effort words a harness puts after its model name; the chip shows them dimmer. */
const EFFORTS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);

/** A harness's own model commands: muxr sends them and shows nothing of its own to pick from. */
const MODEL_COMMANDS: Readonly<Record<string, ReadonlyArray<{ command: string; title: string }>>> = {
    claude: [{ command: '/model', title: 'Model and effort' }],
    pi: [{ command: '/model', title: 'Model' }, { command: '/thinking', title: 'Effort' }],
};

/** What the harness reports as its model, split into the model and the effort when it names one. */
export function splitModelEffort(reported: string | undefined): { model: string; effort?: string } | undefined {
    const words = reported?.trim().split(/\s+/).filter((word) => word !== '') ?? [];
    if (words.length === 0) return undefined;
    const last = words[words.length - 1]!.toLowerCase();
    if (words.length > 1 && EFFORTS.has(last)) return { model: words.slice(0, -1).join(' '), effort: words[words.length - 1]! };
    return { model: words.join(' ') };
}

/** The commands this agent's harness answers to for changing its model and effort. */
export function modelCommands(agentKind: string | undefined): ReadonlyArray<{ command: string; title: string }> {
    return agentKind === undefined ? [] : MODEL_COMMANDS[agentKind.toLowerCase()] ?? [];
}
