import type { AgentLifecycle } from './sessionState.js';
import type {
    PluginAction,
    PluginContribution,
    PluginDataCard,
    PluginEventAction,
    PluginEventTrigger,
    PluginShortcut,
    PluginManifestV1,
    PluginNativeSlot,
    PluginText,
    PluginRpcMode,
    PluginContextRequest,
    PluginScreenButtonNode,
    PluginScreenContribution,
    PluginScreenNode,
    PluginScreenRowAction,
    PluginScreenRowNode,
    PluginScreenTone,
} from './plugins.js';
import {
    MAX_RPC_INPUT_BYTES,
    MAX_SCREEN_DEPTH,
    MAX_SCREEN_FIELD_IDS,
    MAX_SCREEN_NODES,
    MAX_SCREEN_OPTIONS,
    MAX_SCREEN_PARAMS,
    MAX_SCREEN_LIST_ROWS as MAX_ROWS,
    DATA_CARD_SLOTS,
    NATIVE_SLOTS,
    NATIVE_SLOT_CONTEXT_KEYS,
    PRIMITIVES,
    PRIMITIVE_SPECS,
    PLUGIN_CONTEXT_REQUESTS,
    MAX_PLUGIN_LOCALE_TAG_LENGTH,
    MAX_PLUGIN_TEXT_LOCALES,
    PLUGIN_TEXT_MIN_UI_VERSION,
    DYNAMIC_SCREEN_MIN_UI_VERSION,
    sanitizeDisplayText,
} from './plugins.js';

/**
 * Single source of truth for manifest parsing and validation. The host catalog
 * (`apps/host`) and the CLI (`scripts/plugin.mjs`) both call this so
 * `muxr plugin check` accepts and rejects exactly what the runtime does.
 *
 * Unknown slots/types/nodes are skipped, not fatal; known shapes with invalid
 * fields throw. All cross-references (data cards, screens, navigation items,
 * capabilities) are resolved here.
 */

const MAX_CONTRIBUTIONS = 24;
const MAX_TEXT = 200;
const SCREEN_TONES = new Set(['primary', 'secondary', 'positive', 'warning', 'danger']);
const SCREEN_FIELD_KINDS = new Set(['text', 'switch', 'select']);
const SCREEN_BUTTON_VARIANTS = new Set(['primary', 'secondary', 'danger']);
const NATIVE_SLOT_SET = new Set<string>(NATIVE_SLOTS);
const PRIMITIVE_SET = new Set<string>(PRIMITIVES);
const DATA_CARD_SLOT_SET = new Set<string>(DATA_CARD_SLOTS);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function id(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error('invalid plugin id');
    return value;
}
function presentation(value: unknown): 'card' | 'sheet' {
    if (value !== 'card' && value !== 'sheet') throw new Error('invalid data-card presentation');
    return value;
}

function text(value: unknown, max: number): string {
    if (typeof value !== 'string') throw new Error('invalid plugin text');
    const clean = sanitizeDisplayText(value).replace(/[\0-\x1F\x7F]/g, '').trim();
    if (clean.length === 0 || clean.length > max || new TextEncoder().encode(clean).length > max * 4) throw new Error('invalid plugin text length');
    return clean;
}

const LOCALE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

function pluginText(value: unknown, max: number): PluginText {
    if (typeof value === 'string') return text(value, max);
    if (!isRecord(value) || Object.keys(value).some((key) => key !== 'default' && key !== 'translations')) {
        throw new Error('invalid localized plugin text');
    }
    if (!isRecord(value.translations)) throw new Error('invalid localized plugin translations');
    const entries = Object.entries(value.translations);
    if (entries.length === 0 || entries.length > MAX_PLUGIN_TEXT_LOCALES) throw new Error('invalid localized plugin translation count');
    const seen = new Set<string>();
    const translations = Object.fromEntries(entries.map(([locale, translated]) => {
        const folded = locale.toLowerCase();
        if (locale.length > MAX_PLUGIN_LOCALE_TAG_LENGTH || !LOCALE_TAG.test(locale) || seen.has(folded)) {
            throw new Error('invalid localized plugin locale');
        }
        seen.add(folded);
        return [locale, text(translated, max)];
    }));
    return { default: text(value.default, max), translations };
}

function defaultText(value: PluginText): string {
    return typeof value === 'string' ? value : value.default;
}
function keySequence(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 16) throw new Error('invalid terminal key sequence');
    const code = value.length === 1 ? value.charCodeAt(0) : -1;
    const singleControl = code >= 0 && (code <= 0x1f || code === 0x7f);
    const csi = /^\x1b\[[0-9;]*[A-Za-z~]$/.test(value) && value !== '\x1b[200~' && value !== '\x1b[201~';
    const ss3 = /^\x1bO[A-Za-z]$/.test(value);
    if (!singleControl && !csi && !ss3) throw new Error('invalid terminal key sequence');
    return value;
}
function tone(value: unknown): PluginScreenTone {
    if (typeof value !== 'string' || !SCREEN_TONES.has(value)) throw new Error('invalid plugin screen tone');
    return value as PluginScreenTone;
}
function variant(value: unknown): 'primary' | 'secondary' | 'danger' {
    if (typeof value !== 'string' || !SCREEN_BUTTON_VARIANTS.has(value)) throw new Error('invalid plugin screen button variant');
    return value as 'primary' | 'secondary' | 'danger';
}
function number(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid plugin screen number');
    return value;
}
function ids(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error('invalid plugin screen ids');
    const result = value.map((entry) => id(entry));
    if (new Set(result).size !== result.length) throw new Error('duplicate plugin screen id');
    return result;
}

const AGENT_LIFECYCLE = ['idle', 'working', 'blocked', 'done', 'unknown'] as const;

function lifecycle(value: unknown): AgentLifecycle {
    if (typeof value !== 'string' || !(AGENT_LIFECYCLE as readonly string[]).includes(value)) throw new Error('invalid agent status');
    return value as AgentLifecycle;
}

const MAX_SHORTCUT_SYNONYMS = 8;

function parseShortcut(item: Record<string, unknown>): PluginShortcut {
    const synonyms = Array.isArray(item.synonyms) ? item.synonyms.map((value) => pluginText(value, 40)) : [];
    if (synonyms.length === 0 || synonyms.length > MAX_SHORTCUT_SYNONYMS) throw new Error('invalid plugin shortcut synonyms');
    return {
        slot: 'shortcuts',
        id: id(item.id),
        label: pluginText(item.label, 40),
        ...(item.longLabel === undefined ? {} : { longLabel: pluginText(item.longLabel, 80) }),
        synonyms,
        action: parseEventAction(item.action),
    };
}

function parseEventAction(value: unknown): PluginEventAction {
    if (!isRecord(value)) throw new Error('unknown plugin event action');
    if (value.include !== undefined && value.include !== 'pane') throw new Error('invalid plugin event include');
    const include = value.include === undefined ? {} : { include: 'pane' as const };
    if (value.type === 'capability') return { type: 'capability', name: id(value.name), ...include };
    if (value.type === 'plugin.call') return { type: 'plugin.call', contributionId: id(value.contributionId), ...include };
    throw new Error('unknown plugin event action');
}

function parseEventTrigger(item: Record<string, unknown>): PluginEventTrigger {
    if (item.on !== 'agent.status') throw new Error('unknown plugin event source');
    const to = Array.isArray(item.to) ? item.to.map(lifecycle) : [lifecycle(item.to)];
    if (to.length === 0) throw new Error('plugin event needs a target status');
    return { slot: 'events', id: id(item.id), on: 'agent.status', from: lifecycle(item.from), to, action: parseEventAction(item.action) };
}

function parseScreenContribution(item: Record<string, unknown>): PluginScreenContribution {
    if (!Array.isArray(item.children)) throw new Error('invalid plugin screen children');
    const budget = { nodes: 0 };
    const children = parseScreenNodes(item.children, 1, budget);
    const fieldIds: string[] = [];
    collectScreenFieldIds(children, fieldIds);
    if (fieldIds.length > MAX_SCREEN_FIELD_IDS) throw new Error('too many plugin screen fields');
    if (new Set(fieldIds).size !== fieldIds.length) throw new Error('duplicate plugin screen field id');
    for (const button of screenButtons(children)) {
        if (button.fields === undefined) continue;
        if (button.fields.length === 0 || button.fields.length > 8) throw new Error('invalid plugin screen button fields');
        for (const fieldId of button.fields) {
            if (!fieldIds.includes(fieldId)) throw new Error(`plugin screen button references an unknown field: ${fieldId}`);
        }
    }
    for (const fieldId of screenTreeSelectionFields(children)) {
        if (!fieldIds.includes(fieldId)) throw new Error(`plugin screen tree references an unknown field: ${fieldId}`);
    }
    return {
        slot: 'navigation.content',
        id: id(item.id),
        type: 'screen',
        ...(item.title === undefined ? {} : { title: pluginText(item.title, 80) }),
        ...(item.data === undefined ? {} : {
            data: isRecord(item.data) && item.data.type === 'plugin.call'
                ? { type: 'plugin.call' as const, contributionId: id(item.data.contributionId) }
                : (() => { throw new Error('invalid plugin screen data'); })(),
        }),
        children,
    };
}

function parseScreenNodes(value: unknown, depth: number, budget: { nodes: number }): PluginScreenNode[] {
    if (!Array.isArray(value)) throw new Error('invalid plugin screen children');
    if (depth > MAX_SCREEN_DEPTH) throw new Error('plugin screen nesting is too deep');
    const nodes: PluginScreenNode[] = [];
    for (const item of value) {
        if (!isRecord(item) || typeof item.type !== 'string') continue;
        const node = parseScreenNode(item, depth, budget);
        if (node === undefined) continue;
        budget.nodes += 1;
        if (budget.nodes > MAX_SCREEN_NODES) throw new Error('too many plugin screen nodes');
        nodes.push(node);
    }
    return nodes;
}

/** Returns undefined for unknown node types; known types with bad fields throw. */
function parseScreenNode(item: Record<string, unknown>, depth: number, budget: { nodes: number }): PluginScreenNode | undefined {
    switch (item.type) {
        case 'text':
            return { type: 'text', text: pluginText(item.text, MAX_TEXT), ...(item.tone === undefined ? {} : { tone: tone(item.tone) }) };
        case 'row':
            return parseScreenRow(item);
        case 'diff':
            return { type: 'diff', path: bindingPath(item.path) };
        case 'code':
            return {
                type: 'code', path: bindingPath(item.path),
                ...(item.language === undefined ? {} : { language: text(item.language, 32) }),
                ...(item.fileNamePath === undefined ? {} : { fileNamePath: bindingPath(item.fileNamePath) }),
            };
        case 'metric':
            return { type: 'metric', label: pluginText(item.label, 80), value: pluginText(item.value, MAX_TEXT) };
        case 'badge':
            return { type: 'badge', label: pluginText(item.label, 40), ...(item.tone === undefined ? {} : { tone: tone(item.tone) }) };
        case 'progress': {
            const hasValue = item.value !== undefined;
            const hasPath = item.path !== undefined;
            if (hasValue === hasPath) throw new Error('plugin screen progress requires exactly one of value or path');
            const value = hasValue ? number(item.value) : undefined;
            const path = hasPath ? bindingPath(item.path) : undefined;
            const max = item.max === undefined ? 100 : number(item.max);
            if (value !== undefined && (value < 0 || value > max * 1_000_000) || max <= 0) throw new Error('invalid plugin screen progress');
            return {
                type: 'progress',
                ...(value === undefined ? {} : { value }),
                ...(path === undefined ? {} : { path }),
                ...(item.max === undefined ? {} : { max }),
                ...(item.label === undefined ? {} : { label: pluginText(item.label, 80) }),
                ...(item.valueLabel === undefined ? {} : { valueLabel: pluginText(item.valueLabel, 80) }),
                ...(item.tone === undefined ? {} : { tone: tone(item.tone) }),
            };
        }
        case 'chart':
            if (item.variant !== 'bar' && item.variant !== 'ring') throw new Error('invalid plugin screen chart variant');
            return {
                type: 'chart', variant: item.variant, path: bindingPath(item.path),
                ...(item.title === undefined ? {} : { title: pluginText(item.title, 80) }),
                ...(item.emptyText === undefined ? {} : { emptyText: pluginText(item.emptyText, 120) }),
            };
        case 'divider':
            return { type: 'divider' };
        case 'empty':
            return { type: 'empty', ...(item.title === undefined ? {} : { title: pluginText(item.title, 80) }), ...(item.message === undefined ? {} : { message: pluginText(item.message, MAX_TEXT) }) };
        case 'field':
            return parseScreenField(item);
        case 'button': {
            const action = parsePluginAction(item.action);
            const fields = item.fields === undefined ? undefined : ids(item.fields);
            if (fields !== undefined && action.type !== 'plugin.call') throw new Error('plugin screen button fields require plugin.call');
            if (action.type === 'plugin.call' && action.input !== undefined) throw new Error('plugin screen button input comes from fields and screen params');
            return { type: 'button', label: pluginText(item.label, 40), action, ...(fields === undefined ? {} : { fields }), ...(item.variant === undefined ? {} : { variant: variant(item.variant) }) };
        }
        case 'section': {
            const columns = item.columns === undefined ? undefined : number(item.columns);
            if (columns !== undefined && columns !== 2 && columns !== 3) throw new Error('plugin screen section columns must be 2 or 3');
            const children = parseScreenNodes(item.children, depth + 1, budget);
            if (columns !== undefined && children.some((child) => ['field', 'button', 'tree', 'list', 'code', 'diff'].includes(child.type))) {
                throw new Error('plugin screen section columns only support summary nodes');
            }
            return { type: 'section', ...(item.title === undefined ? {} : { title: pluginText(item.title, 80) }), ...(columns === undefined ? {} : { columns: columns as 2 | 3 }), children };
        }
        case 'tree':
            return {
                type: 'tree', path: bindingPath(item.path),
                ...(item.title === undefined ? {} : { title: pluginText(item.title, 80) }),
                ...(item.emptyText === undefined ? {} : { emptyText: pluginText(item.emptyText, 120) }),
                ...(item.selectionField === undefined ? {} : { selectionField: id(item.selectionField) }),
                ...(item.source === undefined ? {} : {
                    source: isRecord(item.source) && item.source.type === 'plugin.call'
                        ? { type: 'plugin.call' as const, contributionId: id(item.source.contributionId) }
                        : (() => { throw new Error('invalid plugin screen tree source'); })(),
                }),
                ...(item.action === undefined ? {} : { action: parseScreenRowAction(item.action) }),
            };
        case 'list': {
            if (!Array.isArray(item.rows) || item.rows.length > MAX_ROWS) throw new Error('invalid plugin screen list rows');
            const rows = item.rows.flatMap((row) => (isRecord(row) && row.type === 'row' ? [parseScreenRow(row)] : []));
            // List rows are rendered children, so they count toward the node
            // budget (the outer loop counts the list node itself). A repeat can
            // expand to MAX_ROWS at render time, so it is charged in full here.
            budget.nodes += rows.length;
            let repeat;
            if (item.repeat !== undefined) {
                if (!isRecord(item.repeat) || !isRecord(item.repeat.template) || item.repeat.template.type !== 'row') throw new Error('invalid plugin screen list repeat');
                repeat = { path: bindingPath(item.repeat.path), template: parseScreenRow(item.repeat.template) };
                budget.nodes += MAX_ROWS;
            }
            return { type: 'list', ...(item.title === undefined ? {} : { title: pluginText(item.title, 80) }), ...(item.emptyText === undefined ? {} : { emptyText: pluginText(item.emptyText, 120) }), rows, ...(repeat === undefined ? {} : { repeat }) };
        }
        default:
            return undefined;
    }
}

/** Dotted binding path: `data.files` or `item.path`. No expressions, no wildcards. */
function bindingPath(value: unknown): string {
    if (typeof value !== 'string' || !/^(data|item)(\.[A-Za-z0-9_-]+){1,8}$/.test(value)) throw new Error('invalid plugin screen binding path');
    return value;
}

function parseScreenRow(row: Record<string, unknown>): PluginScreenRowNode {
    return {
        type: 'row',
        title: pluginText(row.title, 80),
        ...(row.subtitle === undefined ? {} : { subtitle: pluginText(row.subtitle, MAX_TEXT) }),
        ...(row.value === undefined ? {} : { value: pluginText(row.value, MAX_TEXT) }),
        ...(row.action === undefined ? {} : { action: parseScreenRowAction(row.action) }),
    };
}

function parseScreenRowAction(value: unknown): PluginScreenRowAction {
    return parsePluginAction(value);
}

function actionString(value: unknown, max: number, label: string): string {
    if (typeof value !== 'string') throw new Error(`invalid plugin action ${label}`);
    const clean = sanitizeDisplayText(value).trim();
    if (clean.length === 0 || clean.length > max || /[\x00-\x1F\x7F]/.test(clean)) throw new Error(`invalid plugin action ${label}`);
    return clean;
}

function httpsUrl(value: unknown): string {
    const raw = actionString(value, 2048, 'URL');
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new Error('plugin action URL must be HTTPS'); }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') throw new Error('plugin action URL must be HTTPS');
    return parsed.toString();
}

function actionInput(value: unknown): unknown {
    assertFiniteNumbers(value);
    let encoded: string;
    try { encoded = JSON.stringify(value); } catch { throw new Error('invalid plugin action input'); }
    if (encoded === undefined || new TextEncoder().encode(encoded).length > MAX_RPC_INPUT_BYTES) throw new Error('plugin action input is too large');
    return value;
}

export function parsePluginScreenParams(value: unknown): Record<string, string> {
    if (!isRecord(value) || Object.keys(value).length > MAX_SCREEN_PARAMS) throw new Error('invalid plugin screen action params');
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [id(key), text(entry, MAX_TEXT)]));
}

/** Shared structural validator for manifest actions and untrusted RPC results. */
export function parsePluginAction(value: unknown): PluginAction {
    if (!isRecord(value) || typeof value.type !== 'string') throw new Error('unknown plugin action');
    if (value.type === 'screen') {
        const params = value.params === undefined ? undefined : parsePluginScreenParams(value.params);
        return { type: 'screen', contributionId: id(value.contributionId), ...(params === undefined ? {} : { params }) };
    }
    if (value.type === 'kernel.navigate') {
        if (value.target === 'session') return { type: 'kernel.navigate', target: 'session', sessionId: actionString(value.sessionId, 128, 'session id') };
        if (value.target === 'file') {
            const path = actionString(value.path, 1024, 'path');
            if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw new Error('plugin file action needs a filesystem path, not a URL');
            return { type: 'kernel.navigate', target: 'file', path };
        }
        if (value.target === 'web-view') return { type: 'kernel.navigate', target: 'web-view', url: httpsUrl(value.url) };
        if (value.target === 'preview') {
            if (typeof value.port !== 'number' || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
                throw new Error('invalid plugin preview port');
            }
            return { type: 'kernel.navigate', target: 'preview', port: value.port };
        }
        throw new Error('unknown plugin navigation target');
    }
    if (value.type === 'open-url') return { type: 'open-url', url: httpsUrl(value.url) };
    if (value.type === 'attachment') {
        const size = number(value.size);
        if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024 * 1024) throw new Error('invalid plugin attachment size');
        return {
            type: 'attachment', id: (() => {
                const attachmentId = actionString(value.id, 255, 'attachment id');
                if (attachmentId === '..' || attachmentId.includes('/') || attachmentId.includes('\\')) throw new Error('invalid plugin action attachment id');
                return attachmentId;
            })(), name: actionString(value.name, 255, 'attachment name'), size,
            ...(value.mimeType === undefined ? {} : { mimeType: actionString(value.mimeType, 120, 'attachment MIME type') }),
        };
    }
    if (value.type === 'capability') return { type: 'capability', name: id(value.name) };
    if (value.type === 'plugin.call') return {
        type: 'plugin.call', contributionId: id(value.contributionId),
        ...(value.input === undefined ? {} : { input: actionInput(value.input) }),
    };
    if (value.type === 'secure-prompt') {
        const submit = parsePluginAction(value.submit);
        if (submit.type !== 'plugin.call' || submit.input !== undefined) throw new Error('secure prompt must submit to plugin.call without embedded input');
        return {
            type: 'secure-prompt', title: pluginText(value.title, 60), message: pluginText(value.message, 200),
            ...(value.placeholder === undefined ? {} : { placeholder: pluginText(value.placeholder, 80) }),
            inputKey: id(value.inputKey), submit,
        };
    }
    if (value.type === 'confirm') {
        const action = parsePluginAction(value.action);
        if (action.type !== 'plugin.call') throw new Error('confirmation must wrap plugin.call');
        if (value.destructive !== undefined && value.destructive !== true) throw new Error('invalid destructive confirmation');
        return {
            type: 'confirm', title: pluginText(value.title, 60), message: pluginText(value.message, 200), confirmLabel: pluginText(value.confirmLabel, 40),
            ...(value.destructive === true ? { destructive: true } : {}), action,
        };
    }
    throw new Error('unknown plugin action');
}

function parseScreenField(item: Record<string, unknown>): PluginScreenNode {
    const kind = item.kind;
    if (typeof kind !== 'string' || !SCREEN_FIELD_KINDS.has(kind)) throw new Error('invalid plugin screen field kind');
    if (kind === 'select') {
        if (!Array.isArray(item.options) || item.options.length === 0 || item.options.length > MAX_SCREEN_OPTIONS) throw new Error('invalid plugin screen select options');
        const options = item.options.map((option) => pluginText(option, 80));
        const optionValues = options.map(defaultText);
        if (new Set(optionValues).size !== optionValues.length) throw new Error('duplicate plugin screen select option');
        if (item.value !== undefined && !optionValues.includes(text(item.value, 80))) throw new Error('plugin screen select value is not an option');
        return { type: 'field', kind: 'select', id: id(item.id), label: pluginText(item.label, 60), ...(item.placeholder === undefined ? {} : { placeholder: pluginText(item.placeholder, 80) }), ...(item.value === undefined ? {} : { value: text(item.value, 80) }), options };
    }
    if (kind === 'switch') {
        if (item.value !== undefined && item.value !== 'true' && item.value !== 'false') throw new Error('invalid plugin screen switch value');
        return { type: 'field', kind: 'switch', id: id(item.id), label: pluginText(item.label, 60), ...(item.value === undefined ? {} : { value: item.value as 'true' | 'false' }) };
    }
    return { type: 'field', kind: 'text', id: id(item.id), label: pluginText(item.label, 60), ...(item.placeholder === undefined ? {} : { placeholder: pluginText(item.placeholder, 80) }), ...(item.value === undefined ? {} : { value: text(item.value, 80) }) };
}

function collectScreenFieldIds(nodes: PluginScreenNode[], fieldIds: string[]): void {
    for (const node of nodes) {
        if (node.type === 'field') fieldIds.push(node.id);
        else if (node.type === 'section') collectScreenFieldIds(node.children, fieldIds);
    }
}
function screenButtons(nodes: PluginScreenNode[]): PluginScreenButtonNode[] {
    return nodes.flatMap((node) => node.type === 'button' ? [node] : node.type === 'section' ? screenButtons(node.children) : []);
}
function screenTreeSelectionFields(nodes: PluginScreenNode[]): string[] {
    return nodes.flatMap((node) => node.type === 'tree' && node.selectionField !== undefined
        ? [node.selectionField]
        : node.type === 'section' ? screenTreeSelectionFields(node.children) : []);
}

function parseCapabilities(value: unknown): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || Object.keys(value).length > 16) throw new Error('invalid plugin capabilities');
    return Object.fromEntries(Object.entries(value).map(([capability, contributionId]) => [id(capability), id(contributionId)]));
}

function containsLocalizedText(value: unknown, parentKey?: string): boolean {
    if (parentKey === 'input') return false;
    if (Array.isArray(value)) return value.some((entry) => containsLocalizedText(entry));
    if (!isRecord(value)) return false;
    if (typeof value.default === 'string' && isRecord(value.translations)
        && Object.keys(value).every((key) => key === 'default' || key === 'translations')) return true;
    return Object.entries(value).some(([key, entry]) => containsLocalizedText(entry, key));
}

function usesDynamicScreenNodes(nodes: PluginScreenNode[]): boolean {
    return nodes.some((node) => node.type === 'chart'
        || node.type === 'progress' && node.path !== undefined
        || node.type === 'section' && (node.columns !== undefined || usesDynamicScreenNodes(node.children)));
}

function assertFiniteNumbers(value: unknown): void {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('invalid muxr plugin manifest number');
        return;
    }
    if (Array.isArray(value)) {
        for (const entry of value) assertFiniteNumbers(entry);
        return;
    }
    if (isRecord(value)) {
        for (const entry of Object.values(value)) assertFiniteNumbers(entry);
    }
}

export { MAX_PLUGIN_CONTEXT_BYTES, MAX_RPC_INPUT_BYTES, MAX_RPC_STDOUT_BYTES } from './plugins.js';

export function parseManifest(value: unknown): PluginManifestV1 {
    assertFiniteNumbers(value);
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.pluginId !== 'string' || !Array.isArray(value.contributions)) {
        throw new Error('invalid muxr plugin manifest');
    }
    const pluginId = id(value.pluginId);
    const minMuxrVersion = value.minMuxrVersion;
    if (minMuxrVersion !== undefined
        && (typeof minMuxrVersion !== 'number' || !Number.isInteger(minMuxrVersion) || minMuxrVersion < 1)) {
        throw new Error('invalid minMuxrVersion');
    }
    const capabilities = parseCapabilities(value.capabilities);
    if (value.contributions.length > MAX_CONTRIBUTIONS) throw new Error('too many plugin contributions');
    const contributions: PluginContribution[] = [];
    const contributionIds = new Set<string>();
    const rpcModes = new Map<string, PluginRpcMode>();
    for (const item of value.contributions) {
        if (!isRecord(item)) continue;
        if (item.slot === 'settings.sections') {
            if (!Array.isArray(item.children) || item.children.length > MAX_ROWS) throw new Error('invalid plugin settings rows');
            contributions.push({
                slot: 'settings.sections', id: id(item.id), title: pluginText(item.title, 80),
                children: item.children.flatMap((child) => {
                    if (!isRecord(child) || child.type !== 'row') return [];
                    return [{ type: 'row' as const, title: pluginText(child.title, 80), ...(child.subtitle === undefined ? {} : { subtitle: pluginText(child.subtitle, MAX_TEXT) }) }];
                }),
            });
            continue;
        }
        if (item.slot === 'session.toolbar' && item.type === 'button' && isRecord(item.action) && item.action.type === 'plugin.invoke') {
            contributions.push({ slot: 'session.toolbar', id: id(item.id), type: 'button', label: pluginText(item.label, 40), action: { type: 'plugin.invoke', actionId: id(item.action.actionId) } });
            continue;
        }
        if (item.slot === 'host.stream' && item.type === 'stream') {
            const entry = text(item.entry, 80);
            if (!/^[a-zA-Z0-9._-]+\.mjs$/.test(entry)) throw new Error('invalid plugin stream entry');
            contributions.push({ slot: 'host.stream', id: id(item.id), type: 'stream', entry });
            continue;
        }
        if (item.slot === 'host.rpc' && item.type === 'rpc') {
            const entry = text(item.entry, 80);
            if (!/^[a-zA-Z0-9._-]+\.mjs$/.test(entry)) throw new Error('invalid plugin RPC entry');
            let mode: PluginRpcMode;
            if (item.mode === 'write') mode = 'write';
            else if (item.mode === undefined || item.mode === 'read') mode = 'read';
            else throw new Error('invalid plugin RPC mode');
            let context: PluginContextRequest[] | undefined;
            if (item.context !== undefined) {
                if (!Array.isArray(item.context) || item.context.length === 0 || item.context.length > PLUGIN_CONTEXT_REQUESTS.length) {
                    throw new Error('invalid plugin RPC context');
                }
                context = item.context.map((entry) => {
                    if (typeof entry !== 'string' || !(PLUGIN_CONTEXT_REQUESTS as readonly string[]).includes(entry)) {
                        throw new Error('unknown plugin RPC context');
                    }
                    return entry as PluginContextRequest;
                });
                if (new Set(context).size !== context.length) throw new Error('duplicate plugin RPC context');
            }
            contributions.push({ slot: 'host.rpc', id: id(item.id), type: 'rpc', method: id(item.method), entry, mode, ...(context === undefined ? {} : { context }) });
            continue;
        }
        if (item.type === 'native' && typeof item.slot === 'string' && NATIVE_SLOT_SET.has(item.slot)) {
            const primitive = typeof item.primitive === 'string' ? item.primitive : undefined;
            if (primitive === undefined || !PRIMITIVE_SET.has(primitive)) continue;
            const spec = PRIMITIVE_SPECS[primitive as keyof typeof PRIMITIVE_SPECS];
            if (!(spec.slots as readonly string[]).includes(item.slot)) {
                throw new Error(`plugin primitive ${primitive} is not available in slot ${item.slot}`);
            }
            for (const required of spec.requires) {
                if (!(NATIVE_SLOT_CONTEXT_KEYS[item.slot as PluginNativeSlot] as readonly string[]).includes(required)) {
                    throw new Error(`plugin primitive ${primitive} requires ${required}, unavailable in slot ${item.slot}`);
                }
            }
            if (item.source !== undefined || item.capability !== undefined || item.title !== undefined) {
                throw new Error(`plugin primitive ${primitive} parameters must be under params`);
            }
            const params = item.params === undefined ? {} : item.params;
            if (!isRecord(params)) throw new Error(`invalid params for plugin primitive ${primitive}`);
            for (const name of Object.keys(params)) {
                if (!(name in spec.params)) throw new Error(`unknown parameter ${name} for plugin primitive ${primitive}`);
            }
            let title: PluginText | undefined;
            let emptyTitle: PluginText | undefined;
            let emptyMessage: PluginText | undefined;
            let source: { type: 'plugin.call'; contributionId: string } | undefined;
            let capability: string | undefined;
            let icon: string | undefined;
            let accessibilityLabel: PluginText | undefined;
            let refreshIntervalMs: number | undefined;
            let indicator: 'realtime-session' | undefined;
            for (const [name, rule] of Object.entries(spec.params)) {
                const raw = params[name];
                if (raw === undefined) {
                    if (rule.required === true) throw new Error(`plugin primitive ${primitive} requires ${name}`);
                    continue;
                }
                if (rule.type === 'text') {
                    const parsed = pluginText(raw, rule.maxLength);
                    if (name === 'title') title = parsed;
                    else if (name === 'emptyTitle') emptyTitle = parsed;
                    else if (name === 'emptyMessage') emptyMessage = parsed;
                    else if (name === 'accessibilityLabel') accessibilityLabel = parsed;
                    else throw new Error(`unsupported text parameter ${name} for plugin primitive ${primitive}`);
                } else if (rule.type === 'id') {
                    const parsed = id(raw);
                    if (name === 'icon') icon = parsed;
                    else throw new Error(`unsupported id parameter ${name} for plugin primitive ${primitive}`);
                } else if (rule.type === 'enum') {
                    if (typeof raw !== 'string' || !(rule.values as readonly string[]).includes(raw)) throw new Error(`invalid ${name} for plugin primitive ${primitive}`);
                    if (name === 'indicator' && raw === 'realtime-session') indicator = raw;
                    else throw new Error(`unsupported enum parameter ${name} for plugin primitive ${primitive}`);
                } else if (rule.type === 'integer') {
                    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < rule.min || raw > rule.max) {
                        throw new Error(`invalid ${name} for plugin primitive ${primitive}`);
                    }
                    if (name === 'refreshIntervalMs') refreshIntervalMs = raw;
                    else throw new Error(`unsupported integer parameter ${name} for plugin primitive ${primitive}`);
                } else if (rule.type === 'capability') capability = id(raw);
                else {
                    if (!isRecord(raw) || raw.type !== 'plugin.call') throw new Error(`invalid ${name} for plugin primitive ${primitive}`);
                    source = { type: 'plugin.call', contributionId: id(raw.contributionId) };
                }
            }
            contributions.push({
                slot: item.slot as PluginNativeSlot,
                id: id(item.id),
                type: 'native',
                primitive: primitive as typeof PRIMITIVES[number],
                ...(title === undefined ? {} : { title }),
                ...(emptyTitle === undefined ? {} : { emptyTitle }),
                ...(emptyMessage === undefined ? {} : { emptyMessage }),
                ...(source === undefined ? {} : { source }),
                ...(capability === undefined ? {} : { capability }),
                ...(icon === undefined ? {} : { icon }),
                ...(accessibilityLabel === undefined ? {} : { accessibilityLabel }),
                ...(refreshIntervalMs === undefined ? {} : { refreshIntervalMs }),
                ...(indicator === undefined ? {} : { indicator }),
            });
            continue;
        }
        if (item.slot === 'terminal.key-row' && item.type === 'key-row' && Array.isArray(item.keys) && item.keys.length <= 16) {
            contributions.push({ slot: 'terminal.key-row', id: id(item.id), type: 'key-row', keys: item.keys.map((key) => {
                if (!isRecord(key)) throw new Error('invalid terminal key');
                return {
                    label: pluginText(key.label, 8), accessibilityLabel: pluginText(key.accessibilityLabel, 40), send: keySequence(key.send),
                    ...(key.ctrl === undefined ? {} : { ctrl: keySequence(key.ctrl) }),
                    ...(key.shift === undefined ? {} : { shift: keySequence(key.shift) }),
                    ...(key.ctrlShift === undefined ? {} : { ctrlShift: keySequence(key.ctrlShift) }),
                };
            }) });
            continue;
        }
        if (typeof item.slot === 'string' && DATA_CARD_SLOT_SET.has(item.slot) && item.type === 'data-card' && isRecord(item.source) && item.source.type === 'plugin.call') {
            contributions.push({ slot: item.slot as PluginDataCard['slot'], id: id(item.id), type: 'data-card', title: pluginText(item.title, 80), source: { type: 'plugin.call', contributionId: id(item.source.contributionId) }, ...(item.emptyText === undefined ? {} : { emptyText: pluginText(item.emptyText, 120) }), ...(item.presentation === undefined ? {} : { presentation: presentation(item.presentation) }), ...(item.icon === undefined ? {} : { icon: id(item.icon) }) });
            continue;
        }
        if (item.slot === 'session.header.trailing' && item.type === 'screen-button') {
            contributions.push({ slot: 'session.header.trailing', id: id(item.id), type: 'screen-button', title: pluginText(item.title, 40), icon: id(item.icon), contentContributionId: id(item.contentContributionId) });
            continue;
        }
        if (item.slot === 'shortcuts') {
            contributions.push(parseShortcut(item));
            continue;
        }
        if (item.slot === 'events') {
            contributions.push(parseEventTrigger(item));
            continue;
        }
        if (item.slot === 'navigation.content' && item.type === 'screen') {
            contributions.push(parseScreenContribution(item));
            continue;
        }
        if (item.slot === 'navigation.primary' && item.type === 'navigation-item') {
            const badge = item.badge === undefined ? undefined : (() => {
                if (!isRecord(item.badge) || item.badge.type !== 'plugin.call') throw new Error('invalid navigation badge source');
                return { type: 'plugin.call' as const, contributionId: id(item.badge.contributionId) };
            })();
            contributions.push({ slot: 'navigation.primary', id: id(item.id), type: 'navigation-item', label: pluginText(item.label, 40), icon: id(item.icon), contentContributionId: id(item.contentContributionId), ...(badge === undefined ? {} : { badge }) });
            continue;
        }
        if (item.slot === 'settings.items' && item.type === 'settings-item') {
            contributions.push({ slot: 'settings.items', id: id(item.id), type: 'settings-item', label: pluginText(item.label, 60), ...(item.subtitle === undefined ? {} : { subtitle: pluginText(item.subtitle, 160) }), icon: id(item.icon), action: parsePluginAction(item.action) });
        }
    }

    for (const contribution of contributions) {
        if (contributionIds.has(contribution.id)) throw new Error(`duplicate plugin contribution id: ${contribution.id}`);
        contributionIds.add(contribution.id);
        if (contribution.slot === 'host.rpc') rpcModes.set(contribution.id, contribution.mode);
    }
    for (const contribution of contributions) {
        if ((contribution.slot === 'events' || contribution.slot === 'shortcuts')
            && contribution.action.type === 'plugin.call') {
            const mode = rpcModes.get(contribution.action.contributionId);
            if (mode === undefined) throw new Error(`plugin event RPC is not declared: ${contribution.action.contributionId}`);
            if (mode !== 'read') throw new Error(`plugin event RPC must be read mode: ${contribution.action.contributionId}`);
        }
        if (!('type' in contribution)) continue;
        if (contribution.type === 'data-card') {
            const mode = rpcModes.get(contribution.source.contributionId);
            if (mode === undefined) throw new Error(`data card source is not declared: ${contribution.source.contributionId}`);
            if (mode !== 'read') throw new Error(`data card source must be read mode: ${contribution.source.contributionId}`);
        }
        if (contribution.type === 'native' && contribution.source !== undefined) {
            const mode = rpcModes.get(contribution.source.contributionId);
            if (mode === undefined) throw new Error(`native source is not declared: ${contribution.source.contributionId}`);
            if (mode !== 'read') throw new Error(`native source must be read mode: ${contribution.source.contributionId}`);
        }
        if (contribution.type === 'screen') {
            if (contribution.data !== undefined) {
                const mode = rpcModes.get(contribution.data.contributionId);
                if (mode === undefined) throw new Error(`screen RPC is not declared: ${contribution.data.contributionId}`);
                if (mode !== 'read') throw new Error(`screen data RPC must be read mode: ${contribution.data.contributionId}`);
            }
            for (const source of screenTreeSources(contribution.children)) {
                const mode = rpcModes.get(source.contributionId);
                if (mode === undefined) throw new Error(`screen tree source is not declared: ${source.contributionId}`);
                if (mode !== 'read') throw new Error(`screen tree source must be read mode: ${source.contributionId}`);
            }
            for (const action of screenActions(contribution)) validateActionReferences(action, contributions, rpcModes, 'screen');
        }
        if (contribution.type === 'screen-button' && !contributions.some((candidate) =>
            'type' in candidate && candidate.slot === 'navigation.content' && candidate.type === 'screen'
            && candidate.id === contribution.contentContributionId)) {
            throw new Error(`header button screen is not declared: ${contribution.contentContributionId}`);
        }
        if (contribution.type === 'settings-item') validateActionReferences(contribution.action, contributions, rpcModes, 'settings item');
        if (contribution.type === 'navigation-item') {
            if (!contributions.some((candidate) =>
                'type' in candidate && candidate.slot === 'navigation.content'
                && (candidate.type === 'native' || candidate.type === 'screen')
                && candidate.id === contribution.contentContributionId)) {
                throw new Error(`navigation content is not declared: ${contribution.contentContributionId}`);
            }
            if (contribution.badge !== undefined) {
                const mode = rpcModes.get(contribution.badge.contributionId);
                if (mode === undefined) throw new Error(`navigation badge source is not declared: ${contribution.badge.contributionId}`);
                if (mode !== 'read') throw new Error(`navigation badge source must be read mode: ${contribution.badge.contributionId}`);
            }
        }
    }
    for (const [capability, contributionId] of Object.entries(capabilities ?? {})) {
        if (!contributionIds.has(contributionId)) throw new Error(`plugin capability ${capability} names an unknown contribution`);
    }
    if (contributions.some((contribution) => containsLocalizedText(contribution))
        && (minMuxrVersion ?? 1) < PLUGIN_TEXT_MIN_UI_VERSION) {
        throw new Error(`localized plugin text requires minMuxrVersion ${PLUGIN_TEXT_MIN_UI_VERSION}`);
    }
    if (contributions.some((contribution) => 'type' in contribution && contribution.type === 'screen' && usesDynamicScreenNodes(contribution.children))
        && (minMuxrVersion ?? 1) < DYNAMIC_SCREEN_MIN_UI_VERSION) {
        throw new Error(`dynamic plugin screen nodes require minMuxrVersion ${DYNAMIC_SCREEN_MIN_UI_VERSION}`);
    }
    return { schemaVersion: 1, pluginId, ...(minMuxrVersion === undefined ? {} : { minMuxrVersion }), ...(capabilities === undefined ? {} : { capabilities }), contributions };
}

function screenTreeSources(nodes: PluginScreenNode[]): Array<{ contributionId: string }> {
    return nodes.flatMap((node) => node.type === 'tree' && node.source !== undefined
        ? [node.source]
        : node.type === 'section' ? screenTreeSources(node.children) : []);
}

/** Actions declared by rows/buttons, including repeat templates. */
function screenActions(screen: PluginScreenContribution): PluginAction[] {
    const walk = (nodes: PluginScreenNode[]): PluginAction[] => nodes.flatMap((node) => {
        if (node.type === 'row') return node.action === undefined ? [] : [node.action];
        if (node.type === 'button') return [node.action];
        if (node.type === 'tree') return node.action === undefined ? [] : [node.action];
        if (node.type === 'section') return walk(node.children);
        if (node.type === 'list') return [...walk(node.rows), ...(node.repeat === undefined ? [] : walk([node.repeat.template]))];
        return [];
    });
    return walk(screen.children);
}

function validateActionReferences(action: PluginAction, contributions: PluginContribution[], rpcModes: Map<string, PluginRpcMode>, surface: string): void {
    if (action.type === 'screen' && !contributions.some((candidate) =>
        'type' in candidate && candidate.type === 'screen' && candidate.id === action.contributionId)) {
        throw new Error(`${surface} action targets an unknown screen: ${action.contributionId}`);
    }
    const call = action.type === 'plugin.call' ? action
        : action.type === 'secure-prompt' ? action.submit
        : action.type === 'confirm' ? action.action
        : undefined;
    if (call !== undefined) {
        const mode = rpcModes.get(call.contributionId);
        if (mode === undefined) throw new Error(`${surface} action RPC is not declared: ${call.contributionId}`);
        if ((action.type === 'secure-prompt' || action.type === 'confirm') && mode !== 'write') {
            throw new Error(`${surface} ${action.type} RPC must be write mode: ${call.contributionId}`);
        }
    }
}
