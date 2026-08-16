/**
 * Names for panes nobody named. A herd of "pi" panes is unreferrable -- by
 * thumb or by voice -- so every unnamed pane gets one of these instead of its
 * kind or its `pp_` id. Animals: short, distinct over dictation, and nothing
 * here collides with an agent kind.
 */
const POOL = [
    'Otter', 'Falcon', 'Badger', 'Heron', 'Bison',
    'Lynx', 'Raven', 'Marten', 'Kestrel', 'Ibex',
    'Osprey', 'Wolf', 'Stoat', 'Gannet', 'Elk',
    'Puffin', 'Vole', 'Shrike', 'Tapir', 'Curlew',
    'Beaver', 'Merlin', 'Pika', 'Godwit', 'Sable',
    'Hare', 'Auk', 'Weasel', 'Grebe', 'Fox',
];

/** Herdr's own generated handles, which are ids wearing a name's clothes. */
export function isGeneratedName(name: string | null | undefined): boolean {
    return typeof name !== 'string' || name.trim() === '' || /^pp_|^pph_/i.test(name);
}

const ANIMALS = new Set(POOL.map((name) => name.toLowerCase()));
const GREETING = /^(hi|hey|hello|yo|sup|test|ok|hmm|thanks|help)(\s|$)/i;
const FIRST_PROMPT = /^[a-z0-9]+(?:\s+[a-z0-9]+){2,5}$/;

/**
 * Labels that are not a name somebody chose: herd animals, agent kinds,
 * first-prompt leftovers ("hi"), and lowercase chat utterances.
 */
export function isPlaceholderLabel(name: string | null | undefined): boolean {
    if (isGeneratedName(name) || isGenericTabLabel(name)) return true;
    const value = name!.trim();
    const stem = value.toLowerCase().replace(/\s+\d+$/, '');
    if (ANIMALS.has(stem)) return true;
    if (GREETING.test(value)) return true;
    return FIRST_PROMPT.test(value);
}

/** Default tab labels are not a name somebody deliberately gave the agent. */
const AGENT_KINDS = new Set([
    'pi', 'claude', 'codex', 'opencode', 'gemini', 'grok', 'cursor', 'amp', 'copilot',
    'droid', 'kimi', 'kilo', 'devin', 'hermes', 'omp', 'cline', 'kiro', 'maki',
    'mastracode', 'qodercli', 'agy', 'shell',
]);

export function isGenericTabLabel(label: string | null | undefined): boolean {
    const value = typeof label === 'string' ? label.trim().toLowerCase() : undefined;
    return value === undefined || value === '' || /^\d+$/.test(value) || AGENT_KINDS.has(value);
}

/** Explicit pane label, then agent name, then meaningful tab label. */
export function explicitHerdName(options: {
    paneLabel?: string;
    agentName?: string;
    tabLabel?: string;
}): string | undefined {
    const pane = options.paneLabel?.trim();
    if (pane !== undefined && pane !== '' && !isPlaceholderLabel(pane)) return pane;
    if (!isGeneratedName(options.agentName)) return options.agentName?.trim();
    return isPlaceholderLabel(options.tabLabel) ? undefined : options.tabLabel?.trim();
}

/** First free name in the pool; once it is exhausted, the pool with a number. */
export function pickHerdName(taken: Iterable<string>): string {
    const used = new Set([...taken].map((name) => name.toLowerCase()));
    for (let round = 1; ; round += 1) {
        for (const name of POOL) {
            const candidate = round === 1 ? name : `${name} ${round}`;
            if (!used.has(candidate.toLowerCase())) return candidate;
        }
    }
}
