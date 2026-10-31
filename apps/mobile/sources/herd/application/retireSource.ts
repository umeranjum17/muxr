import { sessionStopAfterHandoff } from '@/catalog/ops';
import { sync } from '@/catalog/sync';
import { Modal } from '@/modal';

export function mapHomePath(path: string | undefined, sourceHome: string | undefined, targetHome: string | undefined): { cwd: string; folder: string } {
    if (path === undefined || sourceHome === undefined || targetHome === undefined) return { cwd: '~', folder: '~' };
    const home = sourceHome.replace(/[/\\]+$/, '');
    if (path !== home && !path.startsWith(`${home}/`) && !path.startsWith(`${home}\\`)) return { cwd: '~', folder: '~' };
    const relative = path.slice(home.length).replace(/^[/\\]+/, '');
    if (!relative) return { cwd: targetHome, folder: '~' };
    const separator = targetHome.includes('\\') && !targetHome.includes('/') ? '\\' : '/';
    const target = targetHome.replace(/[/\\]+$/, '');
    return { cwd: `${target}${separator}${relative.replace(/[/\\]+/g, separator)}`, folder: `~/${relative.replace(/\\/g, '/')}` };
}

/** Close the source only while it is at rest (strict: isSessionIdle also counts blocked/failed). Returns a notice when it stays open. */
export async function retireSource(sessionId: string, sourceName: string): Promise<string | undefined> {
    const kept = (why: string) => `${why} It is still open on ${sourceName}. Close it when you are done.`;
    let refusal = 'You chose to keep it open.';
    const atRest = async (): Promise<boolean> => {
        const { agentStatus } = await sync.request('session.status', { sessionId });
        if (agentStatus === 'idle' || agentStatus === 'done') return true;
        refusal = agentStatus === undefined || agentStatus === 'unknown'
            ? 'The agent there could not be checked, so it was not closed.'
            : 'The agent there is not idle, so it was not closed.';
        return false;
    };
    try {
        if (!await atRest()) return kept(refusal);
        const result = await sessionStopAfterHandoff(sessionId, {
            confirmClose: async (prompt) => (await Modal.confirm(`${prompt.confirmText}?`, prompt.message, { cancelText: 'Cancel', confirmText: prompt.confirmText, destructive: true })) && atRest(),
            confirmRetry: async (reason) => (await Modal.confirm('Could not close the agent', reason, { cancelText: 'Cancel', confirmText: 'Retry' })) && atRest(),
        });
        return result.status === 'closed' ? undefined : kept(refusal);
    } catch (cause) {
        if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'agent-unavailable') return undefined;
        return kept(`It could not be closed: ${message(cause)}`);
    }
}

function message(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

