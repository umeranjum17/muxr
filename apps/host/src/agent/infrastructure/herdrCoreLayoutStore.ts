/**
 * The Herdr app's layout document on a Herdr Core: read it, and change it one safe step at a time.
 *
 * Core keeps the document as an opaque JSON value with a version. A write names the version it
 * read, so two writers (muxr and the Herdr app) never silently overwrite each other: the loser
 * gets `conflict`, and `update` reads again and re-applies its change. A document muxr cannot read
 * is never written over.
 */

import { APP_DOCUMENT, parseDocument, reconcile, type AppDocument, type Placeable } from '../domain/herdrAppLayout.js';
import { HerdrCoreError, type HerdrCoreClient } from './herdrCoreClient.js';

const ATTEMPTS = 4;

export class LayoutUnavailableError extends Error {
    constructor() {
        super("Herdr Core's shared layout cannot be read, so spaces and tabs cannot be changed from here");
        this.name = 'LayoutUnavailableError';
    }
}

export interface LayoutStore {
    /** The document now, or `undefined` when it is not a layout muxr can read. */
    read(): Promise<AppDocument | undefined>;
    /** Place `agents` that the layout does not show, apply `change`, write; on a version conflict read and try again. */
    update(agents: readonly Placeable[], change: (doc: AppDocument) => AppDocument): Promise<AppDocument>;
}

export function createLayoutStore(client: Pick<HerdrCoreClient, 'call'>): LayoutStore {
    const get = () => client.call<{ value: unknown; version: number }>('doc.get', { name: APP_DOCUMENT });
    return {
        async read() {
            return parseDocument((await get()).value);
        },
        async update(agents, change) {
            for (let attempt = 1; ; attempt += 1) {
                const { value, version } = await get();
                const doc = parseDocument(value);
                if (doc === undefined) throw new LayoutUnavailableError();
                const next = change(reconcile(doc, agents));
                try {
                    await client.call('doc.set', { name: APP_DOCUMENT, value: next, version });
                    return next;
                } catch (cause) {
                    if (!(cause instanceof HerdrCoreError) || cause.kind !== 'conflict' || attempt >= ATTEMPTS) throw cause;
                }
            }
        },
    };
}
