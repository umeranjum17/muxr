/**
 * Spaces, tabs and panes on Herdr Core: the Herdr app's shared document, as plain data.
 *
 * Each machine keeps its layout in the opaque Core document `herdr-app`: `spaces[]`, each with
 * `tabs[]`, each with a `root` node (a `block` holding one `terminal`, or a `row`, `column` or
 * `stack` of children). It is the Herdr app's own format, not a published API, so every rule
 * here reads what it needs and keeps every other field exactly as found: a newer build's fields
 * survive muxr's write. A document that cannot be read gives `undefined`, and the caller falls
 * back to the labels (`herdr.space`, `herdr.tab`) that each agent terminal carries.
 *
 * Nothing here touches a socket: every function takes a document and returns a new one.
 */

export const APP_DOCUMENT = 'herdr-app';
export const SPACE_LABEL = 'herdr.space';
export const TAB_LABEL = 'herdr.tab';
export const DEFAULT_SPACE = 'Agents';

type Fields = Record<string, unknown>;

export interface AppNode extends Fields {
    id?: string;
    type?: string;
    children?: AppNode[];
    content?: { terminal?: string } & Fields;
    floating?: AppNode[];
}
export interface AppTab extends Fields { id: string; name: string; root: AppNode }
export interface AppSpace extends Fields { id: string; name: string; tabs: AppTab[] }
export interface AppDocument extends Fields { spaces: AppSpace[] }

/** What a terminal must show for the layout to place it. A Core terminal does. */
export interface Placeable {
    address: string;
    name: string | null;
    cwd: string;
    labels: Record<string, string>;
}

export interface Placement { spaceId: string; space: string; tabId: string; tab: string }
export interface ArrangedTab { id: string; name: string; terminals: string[] }
export interface ArrangedSpace { id: string; name: string; tabs: ArrangedTab[] }

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = <T>(value: T): T => structuredClone(value);
const emptyRoot = (): AppNode => ({ id: '', type: 'row', children: [] });

/** The document Core holds, or `undefined` when it is not a layout this muxr can read. A never-written document is an empty layout. */
export function parseDocument(value: unknown): AppDocument | undefined {
    if (value === null || value === undefined) return { spaces: [] };
    if (!isObject(value)) return undefined;
    const spaces = value.spaces ?? [];
    if (!Array.isArray(spaces)) return undefined;
    const readTab = (tab: unknown): AppTab | undefined => {
        if (!isObject(tab) || typeof tab.id !== 'string' || typeof tab.name !== 'string') return undefined;
        if (tab.root !== undefined && !isObject(tab.root)) return undefined;
        return { ...tab, id: tab.id, name: tab.name, root: (tab.root as AppNode | undefined) ?? emptyRoot() };
    };
    const readSpace = (space: unknown): AppSpace | undefined => {
        if (!isObject(space) || typeof space.id !== 'string' || typeof space.name !== 'string') return undefined;
        const tabs = space.tabs ?? [];
        if (!Array.isArray(tabs)) return undefined;
        const read = tabs.map(readTab);
        if (read.some((tab) => tab === undefined)) return undefined;
        return { ...space, id: space.id, name: space.name, tabs: read as AppTab[] };
    };
    const read = spaces.map(readSpace);
    if (read.some((space) => space === undefined)) return undefined;
    return clone({ ...value, spaces: read as AppSpace[] });
}

/** Every terminal a node shows, in layout order, floating blocks last. */
export function terminalsIn(node: AppNode): string[] {
    const own = typeof node.content?.terminal === 'string' ? [node.content.terminal] : [];
    return [...own, ...(node.children ?? []).flatMap(terminalsIn), ...(node.floating ?? []).flatMap(terminalsIn)];
}

const isBlockOf = (node: AppNode, terminal: string): boolean => node.type === 'block' && node.content?.terminal === terminal;

/** A fresh id that no space, tab or node of the document uses, built from `base`. */
function idFactory(doc: AppDocument): (base: string) => string {
    const taken = new Set<string>();
    const walk = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (!isObject(value)) return;
        for (const [key, inner] of Object.entries(value)) {
            if (key === 'id' && typeof inner === 'string') taken.add(inner);
            else walk(inner);
        }
    };
    walk(doc);
    return (base) => {
        let id = base;
        for (let n = 2; taken.has(id); n += 1) id = `${base}-${String(n)}`;
        taken.add(id);
        return id;
    };
}

const blockOf = (terminal: string, newId: (base: string) => string): AppNode => ({ id: newId(`block:${terminal}`), type: 'block', content: { terminal } });

/** Put `block` beside the anchor's block: after it in a container of the same axis, else in a new container around both. */
function splitIn(node: AppNode, anchor: string, block: AppNode, axis: 'row' | 'column', newId: (base: string) => string): AppNode | undefined {
    if (isBlockOf(node, anchor)) return { id: newId(axis), type: axis, children: [node, block] };
    const children = node.children;
    if (children === undefined) return undefined;
    const direct = children.findIndex((child) => isBlockOf(child, anchor));
    if (direct >= 0 && node.type === axis) return { ...node, children: [...children.slice(0, direct + 1), block, ...children.slice(direct + 1)] };
    for (const [index, child] of children.entries()) {
        const wrapped = splitIn(child, anchor, block, axis, newId);
        if (wrapped !== undefined) return { ...node, children: children.map((existing, at) => (at === index ? wrapped : existing)) };
    }
    return undefined;
}

/** The node without the terminal's block; a container left with one child becomes that child, with none it goes. */
function withoutBlock(node: AppNode, terminal: string): AppNode | undefined {
    if (isBlockOf(node, terminal)) return undefined;
    const floating = node.floating?.map((float) => withoutBlock(float, terminal)).filter((float): float is AppNode => float !== undefined);
    const base: AppNode = floating === undefined ? node : { ...node, floating };
    if (node.children === undefined) return base;
    const children = node.children.map((child) => withoutBlock(child, terminal)).filter((child): child is AppNode => child !== undefined);
    if (children.length === node.children.length && children.every((child, at) => child === node.children?.[at])) return base;
    if (children.length === 0) return undefined;
    return children.length === 1 && base.type !== 'stack' ? children[0] : { ...base, children };
}

export interface Place { space: string; tab: string; folder?: string }

/** Where a terminal belongs by its own labels: the space and tab it was started under. */
export function labelPlace(terminal: Placeable): Place {
    return {
        space: terminal.labels[SPACE_LABEL] ?? DEFAULT_SPACE,
        tab: terminal.labels[TAB_LABEL] ?? terminal.name ?? terminal.address,
        folder: terminal.cwd,
    };
}

/** Show the terminal in the named space and tab, making either when missing; a tab that exists takes it as one more pane. */
export function placeTerminal(doc: AppDocument, terminal: string, place: Place): AppDocument {
    const next = clone(doc);
    const newId = idFactory(next);
    let space = next.spaces.find((candidate) => candidate.name === place.space);
    if (space === undefined) {
        space = { id: newId(`space:${place.space}`), name: place.space, folder: place.folder ?? '', tabs: [] };
        next.spaces.push(space);
    }
    const block = blockOf(terminal, newId);
    const tab = space.tabs.find((candidate) => candidate.name === place.tab);
    if (tab === undefined) {
        space.tabs.push({ id: newId(`tab:${place.space}/${place.tab}`), name: place.tab, root: block });
        return next;
    }
    const last = terminalsIn(tab.root).at(-1);
    tab.root = last === undefined ? block : splitIn(tab.root, last, block, 'row', newId) ?? block;
    return next;
}

/** Show the terminal beside the anchor, to its right or below it. Throws when the anchor is not in the layout. */
export function splitTerminal(doc: AppDocument, anchor: string, terminal: string, direction: 'right' | 'down'): AppDocument {
    const next = clone(doc);
    const newId = idFactory(next);
    for (const space of next.spaces) {
        for (const tab of space.tabs) {
            const split = splitIn(tab.root, anchor, blockOf(terminal, newId), direction === 'right' ? 'row' : 'column', newId);
            if (split !== undefined) { tab.root = split; return next; }
        }
    }
    throw new Error(`the layout does not show ${anchor}, so it cannot be split`);
}

/** Take the terminal out of every tab; a tab or space left empty goes with it. */
export function removeTerminal(doc: AppDocument, terminal: string): AppDocument {
    const spaces = doc.spaces.map((space) => ({
        ...space,
        tabs: space.tabs.flatMap((tab) => {
            const root = withoutBlock(tab.root, terminal);
            return root === undefined ? [] : [{ ...tab, root }];
        }),
    }));
    return clone({ ...doc, spaces: spaces.filter((space, at) => space.tabs.length > 0 || doc.spaces[at]?.tabs.length === 0) });
}

export function renameSpace(doc: AppDocument, spaceId: string, name: string): AppDocument {
    if (!doc.spaces.some((space) => space.id === spaceId)) throw new Error(`unknown space: ${spaceId}`);
    return clone({ ...doc, spaces: doc.spaces.map((space) => (space.id === spaceId ? { ...space, name } : space)) });
}

export function renameTab(doc: AppDocument, tabId: string, name: string): AppDocument {
    if (!doc.spaces.some((space) => space.tabs.some((tab) => tab.id === tabId))) throw new Error(`unknown tab: ${tabId}`);
    return clone({ ...doc, spaces: doc.spaces.map((space) => ({ ...space, tabs: space.tabs.map((tab) => (tab.id === tabId ? { ...tab, name } : tab)) })) });
}

/**
 * The layout with every terminal in `agents` placed: those the document does not show go where
 * their labels say. Also the whole story when the document is unreadable (`undefined`), so the
 * label fallback and the document are one code path.
 */
export function reconcile(doc: AppDocument | undefined, agents: readonly Placeable[]): AppDocument {
    const base = doc ?? { spaces: [] };
    const shown = new Set(base.spaces.flatMap((space) => space.tabs.flatMap((tab) => terminalsIn(tab.root))));
    return agents.filter((agent) => !shown.has(agent.address)).reduce((current, agent) => placeTerminal(current, agent.address, labelPlace(agent)), base);
}

/** Spaces, tabs and the agents in them, in layout order, with what is not an agent or not there any more left out. */
export function arrange(doc: AppDocument | undefined, agents: readonly Placeable[]): ArrangedSpace[] {
    const known = new Set(agents.map((agent) => agent.address));
    return reconcile(doc, agents).spaces.flatMap((space) => {
        const tabs = space.tabs.flatMap((tab) => {
            const terminals = terminalsIn(tab.root).filter((address) => known.has(address));
            return terminals.length === 0 ? [] : [{ id: tab.id, name: tab.name, terminals }];
        });
        return tabs.length === 0 ? [] : [{ id: space.id, name: space.name, tabs }];
    });
}

export function placementsOf(arranged: readonly ArrangedSpace[]): Map<string, Placement> {
    const placements = new Map<string, Placement>();
    for (const space of arranged) {
        for (const tab of space.tabs) {
            for (const address of tab.terminals) placements.set(address, { spaceId: space.id, space: space.name, tabId: tab.id, tab: tab.name });
        }
    }
    return placements;
}

/** `wanted`, or `wanted 2`, `wanted 3`... when the space already has a tab of that name. */
export function freeTabName(space: ArrangedSpace | undefined, wanted: string): string {
    const taken = new Set(space?.tabs.map((tab) => tab.name));
    let name = wanted;
    for (let n = 2; taken.has(name); n += 1) name = `${wanted}-${String(n)}`;
    return name;
}
