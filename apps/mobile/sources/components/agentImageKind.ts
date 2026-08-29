export const agentImageKinds = {
    amp: 'amp',
    agy: 'antigravity',
    antigravity: 'antigravity',
    'antigravity-cli': 'antigravity',
    claude: 'claude',
    cline: 'cline',
    codex: 'codex',
    copilot: 'copilot',
    cursor: 'cursor',
    devin: 'devin',
    droid: 'droid',
    gemini: 'gemini',
    grok: 'grok',
    hermes: 'hermes',
    kilo: 'kilocode',
    kilocode: 'kilocode',
    kimi: 'kimi',
    kiro: 'kiro',
    maki: 'maki',
    mastracode: 'mastracode',
    omp: 'omp',
    opencode: 'opencode',
    pi: 'pi',
    qoder: 'qoder',
    qodercli: 'qoder',
} as const;

export type AgentImageKind = (typeof agentImageKinds)[keyof typeof agentImageKinds];

export function agentImageKind(name: string): AgentImageKind | undefined {
    return agentImageKinds[name as keyof typeof agentImageKinds];
}
