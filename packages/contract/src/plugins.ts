import type { AgentLifecycle } from './sessionState.js';

export const MAX_PLUGIN_TEXT_LOCALES = 16;
export const MAX_PLUGIN_LOCALE_TAG_LENGTH = 35;
export const PLUGIN_TEXT_MIN_UI_VERSION = 6;

/** A bounded user-visible manifest string. Plain strings remain the default-compatible form. */
export type PluginText = string | {
    default: string;
    translations: Record<string, string>;
};

export function defaultPluginText(value: PluginText): string {
    return typeof value === 'string' ? value : value.default;
}

/** Pure locale resolution shared by mobile renderers, config generation, and tests. */
export function resolvePluginText(value: PluginText, language: string): string {
    if (typeof value === 'string') return value;
    const entries = Object.entries(value.translations);
    const exact = entries.find(([locale]) => locale.toLowerCase() === language.toLowerCase())?.[1];
    if (exact !== undefined) return exact;
    const base = language.split('-')[0]!.toLowerCase();
    return entries.find(([locale]) => locale.toLowerCase() === base)?.[1] ?? value.default;
}

export type PluginSource =
    | { kind: 'local' }
    | { kind: 'github'; owner?: string; repo?: string; subdir?: string; resolvedCommit?: string }
    | { kind: 'npm'; name: string; version: string; integrity: string };

export interface PluginRow {
    type: 'row';
    title: PluginText;
    subtitle?: PluginText;
}

export interface PluginSettingsSection {
    slot: 'settings.sections';
    id: string;
    title: PluginText;
    children: PluginRow[];
}

export interface PluginToolbarButton {
    slot: 'session.toolbar';
    id: string;
    type: 'button';
    label: PluginText;
    action: { type: 'plugin.invoke'; actionId: string };
}

export type PluginRpcMode = 'read' | 'write';

/** Public host snapshots an RPC may explicitly request. Nothing else is exposed. */
export const PLUGIN_CONTEXT_REQUESTS = ['sessions', 'workspace-tree'] as const;
export type PluginContextRequest = typeof PLUGIN_CONTEXT_REQUESTS[number];

export interface PluginPublicSessionContext {
    sessionId: string;
    label: string;
    cwd?: string;
    workspaceLabel?: string;
    tabLabel?: string;
    agentKind?: string;
    agentStatus: AgentLifecycle;
    activeAt: string;
}

export interface PluginPublicAttentionContext {
    sessionId: string;
    reason: 'waiting' | 'blocked' | 'failed' | 'done';
    detail: string;
    at: string;
}

export interface PluginPublicTreeSession {
    sessionId?: string;
    label: string;
    agentKind?: string;
    agentStatus: AgentLifecycle;
}

export interface PluginPublicTreeTab {
    label: string;
    focused: boolean;
    agentStatus: AgentLifecycle;
    sessions: PluginPublicTreeSession[];
}

export interface PluginPublicTreeWorkspace {
    label: string;
    focused: boolean;
    agentStatus: AgentLifecycle;
    tabs: PluginPublicTreeTab[];
}

export interface PluginPublicContext {
    schemaVersion: 1;
    sessions?: PluginPublicSessionContext[];
    attention?: PluginPublicAttentionContext[];
    workspaces?: PluginPublicTreeWorkspace[];
}

export const MAX_PLUGIN_CONTEXT_SESSIONS = 64;
export const MAX_PLUGIN_CONTEXT_ATTENTION = 64;
export const MAX_PLUGIN_CONTEXT_WORKSPACES = 16;
export const MAX_PLUGIN_CONTEXT_TABS = 24;
export const MAX_PLUGIN_CONTEXT_TREE_SESSIONS = 16;
export const MAX_PLUGIN_CONTEXT_BYTES = 48 * 1024;

export interface PluginRpcCapability {
    slot: 'host.rpc';
    id: string;
    type: 'rpc';
    method: string;
    entry: string;
    /**
     * write calls require a client idempotency key and are replay-fenced on the
     * host: a successful outcome is replayed for five minutes, a rejected write
     * is dropped so it can re-execute on retry. read calls are never cached.
     */
    mode: PluginRpcMode;
    /** true when the manifest spelled the mode out; omitted mode fails closed for browser access. */
    modeDeclared?: boolean;
    /** Optional allow-listed public snapshots passed as MUXR_PLUGIN_CONTEXT_JSON. */
    context?: PluginContextRequest[];
}

/** Persistent provider-neutral byte/control stream owned by a plugin backend. */
export interface PluginStreamCapability {
    slot: 'host.stream';
    id: string;
    type: 'stream';
    entry: string;
}

/** One source of truth: the type and the runtime validator both derive from this. */
export const NATIVE_SLOTS = [
    'app.overlay',
    'navigation.primary',
    'navigation.content',
    'home.cards',
    'home.composer.leading',
    'home.composer.trailing',
    'session.header.trailing',
    'session.overlay',
    'session.pills',
    'session.composer.trailing',
    'terminal.key-row',
    'settings.items',
] as const;

export type PluginNativeSlot = typeof NATIVE_SLOTS[number];

/** Runtime names supplied by each slot's React context. */
export const NATIVE_SLOT_CONTEXT_KEYS = {
    'app.overlay': [],
    'navigation.primary': ['active', 'onSelect'],
    'navigation.content': ['pluginId', 'contributionId', 'params', 'topContentInset', 'bottomContentInset', 'onScroll'],
    'home.cards': [],
    'home.composer.leading': [],
    'home.composer.trailing': ['getText', 'setText'],
    'session.header.trailing': ['sessionId', 'cwd'],
    'session.overlay': ['sessionId', 'visible', 'onClose', 'openMenu', 'showHint'],
    'session.pills': ['sessionId'],
    'session.composer.trailing': ['sessionId', 'getText', 'setText'],
    'terminal.key-row': ['channel'],
    'settings.items': [],
} as const satisfies Record<PluginNativeSlot, readonly string[]>;

export type PluginNativeContextKey = typeof NATIVE_SLOT_CONTEXT_KEYS[PluginNativeSlot][number];
export type PluginPrimitiveParamRule =
    | { type: 'text'; maxLength: number; required?: true }
    | { type: 'id'; required?: true }
    | { type: 'enum'; values: readonly string[]; required?: true }
    | { type: 'integer'; min: number; max: number; required?: true }
    | { type: 'source'; required?: true }
    | { type: 'capability'; required?: true };

export interface PluginPrimitiveSpec {
    slots: readonly PluginNativeSlot[];
    requires: readonly PluginNativeContextKey[];
    params: Readonly<Record<string, PluginPrimitiveParamRule>>;
    /** Cross-plugin mount ceiling for singleton platform surfaces. */
    maxContributions?: number;
    /** Preserve state while a manifest refreshes without changing contribution identity. */
    stableAcrossManifestRefresh?: boolean;
}

type SlotContextKey<S extends PluginNativeSlot> = typeof NATIVE_SLOT_CONTEXT_KEYS[S][number];
type MissingSlotForKey<S extends PluginNativeSlot, K extends PluginNativeContextKey> =
    S extends PluginNativeSlot ? K extends SlotContextKey<S> ? never : S : never;
type SharedContextKey<S extends PluginNativeSlot> = {
    [K in PluginNativeContextKey]: [MissingSlotForKey<S, K>] extends [never] ? K : never
}[PluginNativeContextKey];

function primitiveSpec<const S extends readonly PluginNativeSlot[]>(spec: {
    slots: S;
    requires: readonly SharedContextKey<S[number]>[];
    params: Readonly<Record<string, PluginPrimitiveParamRule>>;
    maxContributions?: number;
    stableAcrossManifestRefresh?: boolean;
}): PluginPrimitiveSpec & typeof spec { return spec; }

/**
 * Installed platform components. Allowed slots follow context requirements,
 * not the bundled plugin that happens to use the primitive today.
 */
export const MIN_PLUGIN_REFRESH_INTERVAL_MS = 5_000;
export const MAX_PLUGIN_REFRESH_INTERVAL_MS = 5 * 60_000;

export const PRIMITIVE_SPECS = {
    'item-list': primitiveSpec({
        slots: ['home.cards', 'navigation.content', 'session.header.trailing', 'session.pills'],
        requires: [],
        params: {
            source: { type: 'source', required: true },
            title: { type: 'text', maxLength: 40 },
            icon: { type: 'id' },
            accessibilityLabel: { type: 'text', maxLength: 80 },
            refreshIntervalMs: { type: 'integer', min: MIN_PLUGIN_REFRESH_INTERVAL_MS, max: MAX_PLUGIN_REFRESH_INTERVAL_MS },
        },
    }),
    collection: primitiveSpec({
        slots: ['navigation.content'],
        requires: [],
        params: {
            source: { type: 'source', required: true },
            title: { type: 'text', maxLength: 80 },
            emptyTitle: { type: 'text', maxLength: 80 },
            emptyMessage: { type: 'text', maxLength: 200 },
            icon: { type: 'id' },
        },
    }),
    'icon-button': primitiveSpec({
        slots: ['home.composer.leading', 'home.composer.trailing', 'session.header.trailing', 'session.composer.trailing'],
        requires: [],
        params: {
            capability: { type: 'capability', required: true },
            icon: { type: 'id', required: true },
            accessibilityLabel: { type: 'text', maxLength: 80, required: true },
            indicator: { type: 'enum', values: ['realtime-session'] },
        },
    }),
    'realtime-session-overlay': primitiveSpec({ slots: ['app.overlay'], requires: [], params: {}, maxContributions: 1, stableAcrossManifestRefresh: true }),
    'tree-sheet': primitiveSpec({
        slots: ['session.overlay'],
        requires: ['sessionId', 'visible', 'onClose', 'openMenu'],
        params: { source: { type: 'source', required: true }, title: { type: 'text', maxLength: 80 } },
        maxContributions: 1,
    }),
    dictate: primitiveSpec({
        slots: ['home.composer.trailing', 'session.composer.trailing'],
        requires: ['getText', 'setText'],
        params: {},
    }),
} as const satisfies Record<string, PluginPrimitiveSpec>;

export type PluginPrimitive = keyof typeof PRIMITIVE_SPECS;
export const PRIMITIVES = Object.keys(PRIMITIVE_SPECS) as PluginPrimitive[];

export interface PluginNativeContribution {
    slot: PluginNativeSlot;
    id: string;
    type: 'native';
    /** Widget compiled into the app. Not a plugin id. */
    primitive: PluginPrimitive;
    title?: PluginText;
    emptyTitle?: PluginText;
    emptyMessage?: PluginText;
    source?: { type: 'plugin.call'; contributionId: string };
    capability?: string;
    icon?: string;
    accessibilityLabel?: PluginText;
    refreshIntervalMs?: number;
    indicator?: 'realtime-session';
}

export interface PluginTerminalKey {
    label: PluginText;
    accessibilityLabel: PluginText;
    send: string;
    ctrl?: string;
    shift?: string;
    ctrlShift?: string;
}

export interface PluginTerminalKeyRow {
    slot: 'terminal.key-row';
    id: string;
    type: 'key-row';
    keys: PluginTerminalKey[];
}

/** Slots a data-card may mount in. Home renders it full width; the others render a compact chip. */
export const DATA_CARD_SLOTS = ['home.cards', 'session.header.trailing', 'session.pills'] as const;

export interface PluginDataCard {
    slot: typeof DATA_CARD_SLOTS[number];
    id: string;
    type: 'data-card';
    title: PluginText;
    source: { type: 'plugin.call'; contributionId: string };
    emptyText?: PluginText;
    /** `card` inlines the value on Home; `sheet` shows a pill that opens it. */
    presentation?: 'card' | 'sheet';
    icon?: string;
}

export interface PluginNavigationItem {
    slot: 'navigation.primary';
    id: string;
    type: 'navigation-item';
    label: PluginText;
    icon: string;
    /**
     * Cross-references a `navigation.content` contribution: a bundled native
     * contribution or a declarative `screen` contribution.
     */
    contentContributionId: string;
    /** Optional read RPC returning `{ count }`; the plugin owns badge policy. */
    badge?: { type: 'plugin.call'; contributionId: string };
}

// --- declarative screens (milestone 1) -------------------------------------

export type PluginScreenTone = 'primary' | 'secondary' | 'positive' | 'warning' | 'danger';
export type PluginScreenFieldKind = 'text' | 'switch' | 'select';
export type PluginScreenButtonVariant = 'primary' | 'secondary' | 'danger';

/** Node strings may bind screen data with dotted paths: `{{data.usage.remaining}}`. */
export interface PluginScreenTextNode {
    type: 'text';
    text: PluginText;
    tone?: PluginScreenTone;
}
/** Unified diff at `path`, drawn by the app's own diff viewer. */
export interface PluginScreenDiffNode {
    type: 'diff';
    path: string;
}
/** Bounded source text at `path`, syntax-highlighted by the app without plugin HTML. */
export interface PluginScreenCodeNode {
    type: 'code';
    path: string;
    /** Optional app-supported language identifier; unknown values fall back to plain text. */
    language?: string;
    /** Optional data path used to infer the language and label the source. */
    fileNamePath?: string;
}
/** Closed action vocabulary. Downloaded manifests never supply executable code. */
export type PluginAction =
    | {
        type: 'screen';
        contributionId: string;
        /** Values are bound like any node string, so `{{item.path}}` works inside a repeat. */
        params?: Record<string, string>;
    }
    | { type: 'kernel.navigate'; target: 'session'; sessionId: string }
    | { type: 'kernel.navigate'; target: 'file'; path: string }
    | { type: 'kernel.navigate'; target: 'web-view'; url: string }
    | { type: 'kernel.navigate'; target: 'preview'; port: number }
    | { type: 'open-url'; url: string }
    | { type: 'attachment'; id: string; name: string; mimeType?: string; size: number }
    | { type: 'capability'; name: string }
    | { type: 'plugin.call'; contributionId: string; input?: unknown }
    | {
        type: 'secure-prompt';
        title: PluginText;
        message: PluginText;
        placeholder?: PluginText;
        inputKey: string;
        submit: { type: 'plugin.call'; contributionId: string };
    }
    | {
        type: 'confirm';
        title: PluginText;
        message: PluginText;
        confirmLabel: PluginText;
        destructive?: true;
        action: { type: 'plugin.call'; contributionId: string; input?: unknown };
    };

export type PluginScreenRowAction = PluginAction;

export interface PluginScreenRowNode {
    type: 'row';
    title: PluginText;
    subtitle?: PluginText;
    value?: PluginText;
    action?: PluginScreenRowAction;
}
export interface PluginScreenMetricNode {
    type: 'metric';
    label: PluginText;
    value: PluginText;
}
export interface PluginScreenBadgeNode {
    type: 'badge';
    label: PluginText;
    tone?: PluginScreenTone;
}
export interface PluginScreenProgressNode {
    type: 'progress';
    /** Exactly one of a literal value or a bounded runtime data path. */
    value?: number;
    path?: string;
    max?: number;
    label?: PluginText;
    valueLabel?: PluginText;
    tone?: PluginScreenTone;
}
export interface PluginScreenDividerNode {
    type: 'divider';
}
export interface PluginScreenEmptyNode {
    type: 'empty';
    title?: PluginText;
    message?: PluginText;
}
/** Password/secret fields are not part of the vocabulary. */
export interface PluginScreenFieldNode {
    type: 'field';
    kind: PluginScreenFieldKind;
    id: string;
    label: PluginText;
    placeholder?: PluginText;
    /** text: initial text; switch: 'true' | 'false'; select: one of options. */
    value?: string;
    /** select only; bounded options. */
    options?: PluginText[];
}
/**
 * RPC action button. `fields` names field ids whose current values become the
 * `plugin.call` input object; the RPC's declared mode decides whether the
 * call needs an idempotency key.
 */
export interface PluginScreenButtonNode {
    type: 'button';
    label: PluginText;
    action: PluginAction;
    /** Only plugin.call buttons may collect fields. */
    fields?: string[];
    variant?: PluginScreenButtonVariant;
}
export interface PluginScreenSectionNode {
    type: 'section';
    title?: PluginText;
    /** Summary-only responsive columns; full-width controls are rejected. */
    columns?: 2 | 3;
    children: PluginScreenNode[];
}
export interface PluginScreenChartNode {
    type: 'chart';
    /**
     * bar ranks categories, column reads a series over time left to right,
     * gauge carries one value against its ceiling, ring splits a whole.
     */
    variant: 'bar' | 'column' | 'gauge' | 'ring';
    /** Runtime path to bounded `{ label, value, valueLabel?, detail?, tone? }` entries. */
    path: string;
    title?: PluginText;
    emptyText?: PluginText;
}
export interface PluginScreenTreeNode {
    type: 'tree';
    title?: PluginText;
    emptyText?: PluginText;
    /** Runtime data path containing bounded { name, path, kind, children? } nodes. */
    path: string;
    /** Optional field id updated when a folder is pressed. */
    selectionField?: string;
    /** Optional read RPC called with screen params plus `{ path }` when an unloaded folder opens. */
    source?: { type: 'plugin.call'; contributionId: string };
    /** Optional leaf action; values bind against the selected tree item. */
    action?: PluginScreenRowAction;
}

/**
 * Data-driven tab strip. Selecting a tab reloads the screen with `param` set to
 * that tab's id, so a plugin serves one provider at a time instead of shipping
 * every provider's detail in a single payload.
 */
export interface PluginScreenTabsNode {
    type: 'tabs';
    /** Runtime path to bounded `{ id, label }` entries. */
    path: string;
    /** Runtime path holding the id of the tab the payload belongs to. */
    selectedPath: string;
    /** Screen param set to the pressed tab's id. */
    param: string;
}

export interface PluginScreenListNode {
    type: 'list';
    title?: PluginText;
    emptyText?: PluginText;
    rows: PluginScreenRowNode[];
    /**
     * Render `template` once per entry of the array at `path`, capped at
     * MAX_ROWS. Inside the template, bind entry fields with `{{item.x}}`.
     * Without this a manifest can only address fixed indices.
     */
    repeat?: { path: string; template: PluginScreenRowNode };
}

export type PluginScreenNode =
    | PluginScreenTextNode
    | PluginScreenDiffNode
    | PluginScreenCodeNode
    | PluginScreenRowNode
    | PluginScreenMetricNode
    | PluginScreenBadgeNode
    | PluginScreenProgressNode
    | PluginScreenChartNode
    | PluginScreenDividerNode
    | PluginScreenEmptyNode
    | PluginScreenFieldNode
    | PluginScreenButtonNode
    | PluginScreenSectionNode
    | PluginScreenListNode
    | PluginScreenTabsNode
    | PluginScreenTreeNode;

export interface PluginScreenContribution {
    slot: 'navigation.content';
    id: string;
    type: 'screen';
    title?: PluginText;
    /** Optional read-mode RPC contribution that loads this screen's data on mount. */
    data?: { type: 'plugin.call'; contributionId: string };
    children: PluginScreenNode[];
}

export interface PluginSettingsItem {
    slot: 'settings.items';
    id: string;
    type: 'settings-item';
    label: PluginText;
    subtitle?: PluginText;
    icon: string;
    action: PluginAction;
}

/**
 * A plugin cannot poll: it renders when asked and answers when called. An event
 * contribution is the only way for a plugin to say "when this happens, do that",
 * so policy that used to be a native hook can live in a manifest.
 *
 * The kernel matches the transition and runs the action. Terminal bytes never
 * reach the plugin; it supplies wording, the kernel supplies content.
 */
export interface PluginEventTrigger {
    slot: 'events';
    id: string;
    on: 'agent.status';
    from: AgentLifecycle;
    to: AgentLifecycle[];
    action: PluginEventAction;
}

/**
 * A plugin reacts with its own backend. The kernel knows how to run a plugin's
 * RPC and nothing else, so no feature name (voice, notify, terminal) is ever
 * spelled here: a plugin that replaces another one uses the same action.
 */
export type PluginEventAction =
    | {
        type: 'plugin.call';
        contributionId: string;
        /** Kernel appends a bounded tail of the pane that changed. */
        include?: 'pane';
    }
    | {
        /**
         * Something that has to happen on the phone (speak, vibrate, draw).
         * The kernel carries the name and never interprets it: a capability
         * exists only because compiled code registered it, exactly like a
         * primitive. Unregistered names are skipped, not fatal.
         */
        type: 'capability';
        name: string;
        include?: 'pane';
    };

/**
 * An Android launcher shortcut. Packaged contributions are baked into the app;
 * runtime-installed contributions become dynamic shortcuts. Both run the same
 * closed action union events use.
 */
export interface PluginShortcut {
    slot: 'shortcuts';
    id: string;
    label: PluginText;
    longLabel?: PluginText;
    /** Legacy aliases retained for deep links made by older builds. */
    synonyms: PluginText[];
    action: PluginEventAction;
}

/** Icon in the session header that opens one of the plugin's screens. */
export interface PluginScreenButton {
    slot: 'session.header.trailing';
    id: string;
    type: 'screen-button';
    title: PluginText;
    icon: string;
    contentContributionId: string;
}

export type PluginContribution = PluginShortcut | PluginEventTrigger | PluginScreenButton | PluginSettingsSection | PluginToolbarButton | PluginRpcCapability | PluginStreamCapability | PluginNativeContribution | PluginTerminalKeyRow | PluginDataCard | PluginNavigationItem | PluginSettingsItem | PluginScreenContribution;

// --- bounds (host-enforced; single source of truth for host + mobile) -------

export const MAX_SCREEN_NODES = 64;
export const MAX_SCREEN_DEPTH = 4;
export const MAX_SCREEN_OPTIONS = 32;
export const MAX_SCREEN_FIELD_IDS = 16;
export const MAX_SCREEN_PARAMS = 8;
/**
 * The plugin UI vocabulary this build understands. A manifest may declare
 * `minMuxrVersion`; when it is higher, the host keeps the plugin listed and
 * says so instead of silently dropping contributions the app cannot render.
 * Bumped whenever a manifest can contain values an older phone cannot parse.
 */
export const MUXR_UI_VERSION = 13;
export const DYNAMIC_SCREEN_MIN_UI_VERSION = 13;
export const MAX_CHART_SERIES = 8;
export const MAX_CHART_LABEL_BYTES = 24;
/** Static list rows, and the render cap for a repeat expansion. */
export const MAX_SCREEN_LIST_ROWS = 32;
export const MAX_RPC_INPUT_BYTES = 8 * 1024;
export const MAX_RPC_STDOUT_BYTES = 64 * 1024;
export const MAX_RPC_STDERR_BYTES = 256 * 1024;
/** Per-string transport cap; ordinary text nodes apply the smaller display cap. */
export const MAX_RPC_RESULT_STRING_BYTES = MAX_RPC_STDOUT_BYTES;
export const MAX_RPC_DISPLAY_BYTES = 4 * 1024;
export const MAX_RPC_DISPLAY_DEPTH = 8;
export const MAX_RPC_ARRAY_ENTRIES = 256;
export const MAX_RPC_CONCURRENCY = 4;
export const MAX_RPC_PER_PLUGIN = 2;
export const MAX_RPC_PER_DEVICE = 3;
export const PLUGIN_CALL_DEADLINE_MS = 30_000;
export const PLUGIN_CALL_KILL_GRACE_MS = 2_000;
export const PLUGIN_CALL_CLIENT_TIMEOUT_MS = 40_000;

// A client must still be listening when the host deadline and hard-kill grace expire.
if (PLUGIN_CALL_CLIENT_TIMEOUT_MS <= PLUGIN_CALL_DEADLINE_MS + PLUGIN_CALL_KILL_GRACE_MS) {
    throw new Error('plugin call client timeout must exceed the host deadline and kill grace');
}

/**
 * Trim a display string to `maxBytes` of UTF-8, never splitting a code point.
 * Used by the host before RPC output reaches mobile and defensively in mobile
 * rendering (`bindText`/`displayText`). Pure JS so both sides can share it.
 */
export function capUtf8Bytes(text: string, maxBytes: number): string {
    if (maxBytes <= 0 || text.length === 0) return '';
    let bytes = 0;
    let index = 0;
    while (index < text.length) {
        const codePoint = text.codePointAt(index)!;
        const size = codePoint > 0xffff ? 4 : codePoint > 0x7ff ? 3 : codePoint > 0x7f ? 2 : 1;
        if (bytes + size > maxBytes) break;
        bytes += size;
        index += codePoint > 0xffff ? 2 : 1;
    }
    return text.slice(0, index);
}

// C0 controls (keeping tab/newline/carriage return), DEL, zero-width chars,
// bidi overrides, and the BOM. Strip before any untrusted text renders.
const DISPLAY_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200C\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function sanitizeDisplayText(text: string): string {
    return text.replace(DISPLAY_CONTROL, '');
}

/** v1 is deliberately tiny: one static surface and one context-bound action. */
export interface PluginManifestV1 {
    schemaVersion: 1;
    pluginId: string;
    /** Lowest native UI vocabulary version the phone must understand. */
    minMuxrVersion?: number;
    /** Semantic capability -> contribution id. Core surfaces never depend on plugin ids. */
    capabilities?: Record<string, string>;
    contributions: PluginContribution[];
}

/** A host may forward a newer manifest; the rendering phone is authoritative. */
export function pluginCompatibilityError(manifest: PluginManifestV1, supportedVersion = MUXR_UI_VERSION): string | undefined {
    const required = manifest.minMuxrVersion ?? 1;
    return required > supportedVersion
        ? `Plugin requires muxr UI ${required}; this app supports ${supportedVersion}. Update muxr to use it.`
        : undefined;
}

export interface PluginSummary {
    pluginId: string;
    name: string;
    version: string;
    description?: string;
    source: PluginSource;
    manifestHash?: string;
    approved: boolean;
    capabilities: Record<string, string>;
    hasBackend: boolean;
    warnings: string[];
}
