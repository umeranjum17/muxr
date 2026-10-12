import type { AgentLifecycle, HerdrTreePane } from '@trymuxr/contract';
import type { Session } from '@/catalog';
import { displayedAgentStatus, paneStatus, sessionHoldsRequest } from '@/herd';

/**
 * The lifecycle the terminal header draws: the agent's attention state, from
 * the same rule every other surface uses (`displayedAgentStatus`).
 *
 * The Herdr tree pane only carries a fresh status on its next resnapshot, so a
 * header that reads it keeps "Needs you" after an answer until the phone polls
 * it again. Home clears the moment the host reports the answer, so read the
 * session's own live status here too and fall back to the pane only when there
 * is no online session.
 */
export function terminalPaneStatus(pane: HerdrTreePane | undefined, session?: Session | null): AgentLifecycle {
    if (pane?.promptable !== true) return 'unknown';
    if (session == null || session.presence !== 'online') return pane.agentStatus;
    return displayedAgentStatus(paneStatus(session), sessionHoldsRequest(session));
}
