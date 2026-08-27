/**
 * Human first-name defaults for unnamed agents. They are display-only; stable
 * session ids remain the sole routing keys.
 */
const POOL = [
    'John', 'Maria', 'Alex', 'Maya', 'Sam',
    'Nina', 'Leo', 'Sara', 'Omar', 'Lina',
    'Noah', 'Zoe', 'Adam', 'Emma', 'Ryan',
    'Iris', 'Luke', 'Anna', 'Eli', 'Mila',
];

/** Herdr's own generated handles, which are ids wearing a name's clothes. */
export function isGeneratedName(name: string | null | undefined): boolean {
    return typeof name !== 'string' || name.trim() === '' || /^pp_|^pph_/i.test(name);
}

const LEGACY_ANIMALS = new Set(['otter', 'falcon', 'badger', 'heron', 'bison', 'lynx', 'raven', 'marten', 'kestrel', 'ibex', 'osprey', 'wolf', 'stoat', 'gannet', 'elk', 'puffin', 'vole', 'shrike', 'tapir', 'curlew', 'beaver', 'merlin', 'pika', 'godwit', 'sable', 'hare', 'auk', 'weasel', 'grebe', 'fox']);
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
    if (LEGACY_ANIMALS.has(stem)) return true;
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
