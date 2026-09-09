export type FocusAgentCommand = {
    agentRoute: string;
    alreadyViewingAgent?: boolean;
    splitView?: boolean;
};

export type FocusAgentResult = {
    href: `/session/${string}`;
    replace: boolean;
};

/** Focus the phone on one Agent. The Agent Route authorizes; names never do. */
export function focusAgent(command: FocusAgentCommand): FocusAgentResult {
    const href = `/session/${encodeURIComponent(command.agentRoute)}` as const;
    return {
        href,
        replace: command.splitView === true && command.alreadyViewingAgent === true,
    };
}
