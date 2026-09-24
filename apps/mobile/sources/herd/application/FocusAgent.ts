export type FocusAgentCommand = {
    agentRoute: string;
    /** Something sits above Home, so the stack can already hold an agent. */
    aboveHome: boolean;
};

export type FocusAgentResult = {
    href: `/session/${string}`;
    action: 'push' | 'dismissTo';
};

/**
 * Focus the phone on one Agent. The Agent Route authorizes; names never do.
 *
 * The stack holds one agent screen over Home however many agents are opened,
 * so back from an agent is always Home; stepping between agents is the
 * pager's job. From Home the agent is pushed. Anywhere above it the agent
 * screen already in the stack takes the new route and everything over it is
 * popped; with none there, the screen on top is swapped for it.
 */
export function focusAgent(command: FocusAgentCommand): FocusAgentResult {
    return {
        href: `/session/${encodeURIComponent(command.agentRoute)}`,
        action: command.aboveHome ? 'dismissTo' : 'push',
    };
}
