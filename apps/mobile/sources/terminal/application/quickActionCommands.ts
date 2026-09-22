import type { Command } from '@/components/CommandPalette/types';
import { destructiveCommand, type AgentCommand } from '../domain/agentCommands';
import type { QuickAction } from '../domain/quickActions';

/**
 * The outside world one row needs: where its text goes when tapped, and how to
 * ask about it first when the agent's own catalogue calls it destructive.
 */
export interface QuickActionPalette {
    agentKind: string | undefined;
    sentHint: (label: string) => void;
    send: (text: string) => void;
    confirmDangerous: (entry: AgentCommand) => void;
    insert: (text: string) => void;
}

/**
 * The palette row for one of the person's own actions. A tap sends, whatever
 * the text holds; the pencil beside the row is the way to fill the prompt
 * instead. The one exception is a command the agent's own catalogue marks
 * destructive, which asks the same question its catalogue row asks.
 */
export function quickActionCommand(action: QuickAction, category: string, palette: QuickActionPalette): Command {
    const dangerous = destructiveCommand(palette.agentKind, action.text);
    return {
        id: `quick:${action.id}`,
        title: action.label,
        category,
        destructive: dangerous !== undefined || undefined,
        action: dangerous !== undefined
            ? () => palette.confirmDangerous(dangerous)
            : () => {
                palette.sentHint(action.label);
                palette.send(action.text);
            },
        secondaryAction: () => palette.insert(action.text),
    };
}
