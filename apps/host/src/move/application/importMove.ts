import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { importConversation } from '@byokit/herdr';
import type { MoveReady } from '@trymuxr/contract';
import type { SessionSource } from '../../agent/index.js';
import { startAgent } from '../../agent/index.js';
import { homePath } from '../../platform/homePath.js';
import { conversationRoot, listPlans, planAccounts, planLaunchEnv, resolvePlanLaunch, type PlanAccountRecord } from '../../plans/index.js';
import { moveAdapter, moveError } from '../domain/adapters.js';
import type { TransferStore } from '../infrastructure/transferStore.js';

export interface MoveImportDeps {
    source: SessionSource;
    store: TransferStore;
    env: NodeJS.ProcessEnv;
    /** Record which plan account the new pane runs on, as `session.start` does. */
    rememberPane(paneId: string, accountId: string): Promise<void>;
}

const signInFirst = (kind: string): string =>
    `Sign in to ${kind === 'claude' ? 'Claude' : kind} on this computer first, then move the agent here. Sign-ins never move.`;

/** The signed-in account this computer would resume on, found the way the Accounts screen finds it. */
async function destinationAccount(env: NodeJS.ProcessEnv, provider: string): Promise<PlanAccountRecord | undefined> {
    const listed = await listPlans(env, {}, { includeSingle: true });
    const account = listed.providers.find((entry) => entry.provider === provider)?.accounts.find((entry) => entry.signedIn);
    return account === undefined ? undefined : resolvePlanLaunch(env, account.id, provider);
}

/** Destination side: can this computer resume this kind? */
export async function moveReady(deps: Pick<MoveImportDeps, 'source' | 'env'>, kind: string): Promise<MoveReady> {
    const adapter = moveAdapter(kind);
    if (adapter === undefined) return { ready: false, code: 'move-not-ready', message: 'This kind of agent keeps Continue.' };
    if (!(await deps.source.installedAgentKinds([kind])).includes(kind)) {
        return { ready: false, code: 'move-not-ready', message: `${kind === 'claude' ? 'Claude' : kind} isn't installed on this computer.` };
    }
    if (await destinationAccount(deps.env, adapter.provider) === undefined) return { ready: false, code: 'move-not-ready', message: signInFirst(kind) };
    return { ready: true, home: homedir() };
}

/** Destination side: verify the staged bundle, import it into this computer's own sign-in folder, resume the agent in a pane. */
export async function importMove(
    deps: MoveImportDeps,
    params: { transferId: string; kind: string; conversation: string; bytes: number; digest: string; cwd: string; taskTitle?: string },
): Promise<{ sessionId: string; cwd: string }> {
    const adapter = moveAdapter(params.kind);
    if (adapter === undefined) throw moveError('move-unsupported', 'This kind of agent keeps Continue.');
    const staged = deps.store.staged(params.transferId);
    if (staged.bytes !== params.bytes || staged.digest !== params.digest) {
        deps.store.release(params.transferId);
        throw moveError('move-corrupt', 'The conversation was damaged on the way, so nothing was imported. The original is untouched; try again.');
    }
    const record = await destinationAccount(deps.env, adapter.provider);
    if (record === undefined) throw moveError('move-not-ready', signInFirst(params.kind));
    const imported = await importConversation({ bundle: staged.path, accountFolder: conversationRoot(record.folder), kind: params.kind, conversation: params.conversation });
    if (!imported.ok) {
        const exists = imported.code === 'exists';
        throw moveError(exists ? 'move-exists' : 'move-corrupt', exists
            ? 'This conversation is already on this computer. Open it from the agent list; the original is untouched.'
            : `The conversation could not be imported (${imported.message}). The original is untouched.`);
    }
    deps.store.release(params.transferId);
    const launchEnv = await planLaunchEnv(deps.env, record);
    if (record.found) launchEnv.set.CLAUDE_CONFIG_DIR = record.folder;
    const cwd = existsSync(homePath(params.cwd)) ? homePath(params.cwd) : homedir();
    const resumeArgs = planAccounts(deps.env).resumeArgs(params.kind, { kind: 'id', value: params.conversation });
    const started = await startAgent({
        exists: existsSync,
        create: async (dir) => { await mkdir(dir, { recursive: true }); },
        start: (command) => deps.source.start(command),
    }, {
        cwd, kind: params.kind, resumeArgs, planEnv: launchEnv.set, planUnset: launchEnv.unset,
        ...(params.taskTitle === undefined ? {} : { label: params.taskTitle }),
    });
    if (!started.ok || !('info' in started.data)) {
        throw moveError('move-resume-failed', `The conversation is now on this computer, but the agent did not start. Start ${params.kind} here in ${cwd} with --resume to carry on; the original is untouched.`);
    }
    await deps.rememberPane(started.data.info.paneId ?? started.data.info.id, record.id).catch(() => undefined);
    return { sessionId: started.data.info.id, cwd };
}
