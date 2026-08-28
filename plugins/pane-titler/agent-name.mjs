const INTERNAL_NAME = /^pph?_/i;
const ANIMALS = [
    'alpaca', 'badger', 'beaver', 'bison', 'bobcat', 'caribou', 'cheetah', 'condor',
    'cougar', 'coyote', 'crane', 'dolphin', 'eagle', 'falcon', 'ferret', 'finch',
    'fox', 'gecko', 'heron', 'ibex', 'jaguar', 'koala', 'lemur', 'leopard',
    'lynx', 'marten', 'moose', 'narwhal', 'ocelot', 'orca', 'otter', 'owl',
    'panda', 'panther', 'pelican', 'penguin', 'puma', 'raven', 'robin', 'salmon',
    'seal', 'shark', 'sparrow', 'stoat', 'swan', 'tapir', 'tiger', 'toucan',
    'turtle', 'viper', 'walrus', 'weasel', 'whale', 'wolf', 'wombat', 'yak',
];

function displayAgentName(value) {
    const name = typeof value === 'string'
        ? value.normalize('NFKC').replace(/[\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
        : '';
    return name === '' || INTERNAL_NAME.test(name) ? undefined : name;
}

function renameCandidate(value) {
    const clean = displayAgentName(value)?.toLocaleLowerCase('und')
        .replace(/[^a-z0-9_-]+/g, '-').replace(/[-_]{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32);
    return clean !== undefined && /^[a-z][a-z0-9_-]{0,31}$/.test(clean) ? clean : undefined;
}

function agents(run) {
    const parsed = JSON.parse(run(['agent', 'list']));
    return Array.isArray(parsed?.result?.agents) ? parsed.result.agents : [];
}

export function readAgentName(run, paneId) {
    const agent = agents(run).find((candidate) => candidate?.pane_id === paneId);
    return displayAgentName(agent?.name);
}

function animalFor(rows, seed) {
    const used = new Set(rows.flatMap((agent) => {
        const name = renameCandidate(agent?.name);
        return name === undefined ? [] : [name];
    }));
    let hash = 2166136261;
    for (const byte of Buffer.from(seed)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    for (let offset = 0; offset < ANIMALS.length; offset += 1) {
        const candidate = ANIMALS[(hash + offset) % ANIMALS.length];
        if (!used.has(candidate)) return candidate;
    }
    return undefined;
}

export function ensureAgentName(run, paneId) {
    const rows = agents(run);
    const agent = rows.find((candidate) => candidate?.pane_id === paneId);
    if (agent === undefined) return undefined;
    const existing = displayAgentName(agent.name);
    if (existing !== undefined) return existing;
    const raw = typeof agent.name === 'string' ? agent.name.trim() : '';
    if (raw !== '' && !INTERNAL_NAME.test(raw)) return undefined;
    const fallback = animalFor(rows, paneId);
    if (fallback === undefined) return undefined;
    run(['agent', 'rename', paneId, fallback]);
    return fallback;
}

export function renameAgent(run, paneId, value) {
    const requested = displayAgentName(value);
    const existing = readAgentName(run, paneId);
    if (requested !== undefined && requested === existing) return existing;
    const name = renameCandidate(requested);
    if (name === undefined) throw new Error('Agent Name must start with a letter and use only letters, numbers, hyphens, or underscores.');
    run(['agent', 'rename', paneId, name]);
    if (readAgentName(run, paneId) !== name) throw new Error('Herdr did not persist the Agent Name.');
    return name;
}
