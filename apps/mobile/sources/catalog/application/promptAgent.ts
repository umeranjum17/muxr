import type { PromptAttachment } from '@muxr/contract';

export type PromptAgentCommand = {
    agentRoute: string;
    text: string;
    hasAttachments: boolean;
    /** Stable submission identity; a resend after a lost answer reuses it so the host runs it once. */
    promptId?: string;
};

export type PromptAgentDelivery = {
    agentRoute: string;
    text: string;
    streamingBehavior: 'steer';
    attachments?: PromptAttachment[];
    promptId?: string;
};

export type PromptAgentResult =
    | { ok: true }
    | { ok: false; reason: 'empty' };

export type PromptAgentPorts = {
    markSent: (agentRoute: string) => void;
    attachments: () => Promise<PromptAttachment[]>;
    deliver: (delivery: PromptAgentDelivery) => Promise<unknown>;
};

/** Prompt an Agent by Agent Route. A mid-turn message is a correction (steer). */
export async function promptAgent(command: PromptAgentCommand, ports: PromptAgentPorts): Promise<PromptAgentResult> {
    const text = command.text.trim();
    if (text.length === 0 && !command.hasAttachments) return { ok: false, reason: 'empty' };
    ports.markSent(command.agentRoute);
    const attachments = command.hasAttachments ? await ports.attachments() : [];
    await ports.deliver({
        agentRoute: command.agentRoute,
        text,
        streamingBehavior: 'steer',
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(command.promptId === undefined ? {} : { promptId: command.promptId }),
    });
    return { ok: true };
}
