/**
 * The herd a visitor sees before they have paired a computer.
 *
 * It is sample data on purpose: no request, no machine, no grant. Every
 * surface that draws it says so, so a demo transcript can never be mistaken
 * for something running on a real computer.
 */
export type DemoAgentState = 'working' | 'needs-you' | 'idle';

export type DemoTurn = { from: 'you' | 'agent'; text: string };

export type DemoAgent = {
    /** Never shown: the rows are drawn from name and task. */
    id: string;
    name: string;
    avatarId: string;
    provider: string;
    providerKind: 'claude' | 'codex' | 'pi';
    model: string;
    state: DemoAgentState;
    task: string;
    turns: readonly DemoTurn[];
};

/** Whose fake computer this is: the demo is named, not anonymous. */
export const DEMO_COMPUTER = "Umer's MacBook Pro";

export const DEMO_AGENTS: readonly DemoAgent[] = [
    {
        id: 'demo-agent-1',
        name: 'zulu-2',
        avatarId: 'zulu-2-agent',
        provider: 'Claude Code',
        providerKind: 'claude',
        model: 'Sonnet 4.5',
        state: 'working',
        task: 'Fixing the sign-in redirect',
        turns: [
            { from: 'you', text: 'Safari loops on the sign-in redirect after the callback. Chrome is fine. Can you find it?' },
            { from: 'agent', text: 'Found it. The callback writes the session cookie and redirects in the same response, so Safari reads the cookie a beat too late and drops the next target. The page then bounces back to sign-in.\n\nI am pinning the target inside the session instead of the URL, and adding one regression test that fails on the old code.' },
            { from: 'you', text: 'Nice. Run the suite before you push?' },
            { from: 'agent', text: 'Running it now. Three of four green, the last one is still going.' },
        ],
    },
    {
        id: 'demo-agent-2',
        name: 'kestrel',
        avatarId: 'kestrel-agent',
        provider: 'Codex',
        providerKind: 'codex',
        model: 'GPT-5 Codex',
        state: 'needs-you',
        task: 'Approving the users migration',
        turns: [
            { from: 'you', text: 'Add a last_seen_at column to users and backfill it from sessions.' },
            { from: 'agent', text: 'The migration is written. It adds the column, backfills each user from their newest session, and drops nothing.\n\nIt wants to run against your local database. Say yes and I will run it, then check the counts.' },
        ],
    },
    {
        id: 'demo-agent-3',
        name: 'ember',
        avatarId: 'ember-agent',
        provider: 'Pi',
        providerKind: 'pi',
        model: 'Pi 2',
        state: 'idle',
        task: 'Flaky-test sweep finished',
        turns: [
            { from: 'you', text: 'Which tests were flaky this week?' },
            { from: 'agent', text: 'Three. Two settled after the retry fix in the pairing suite. The third is a real race in the artifact upload, so I opened a branch for it.\n\nNothing else is red. I will wait here.' },
        ],
    },
];

const stateWords: Record<DemoAgentState, string> = {
    working: 'Working',
    'needs-you': 'Needs you',
    idle: 'Idle',
};

/** One plain sentence for a row: what it is doing, then the task. */
export function demoAgentStatus(agent: DemoAgent): string {
    if (agent.state === 'needs-you') return 'Needs you';
    return `${stateWords[agent.state]} · ${agent.task}`;
}
