import { MUXR_UI_VERSION, pluginCompatibilityError } from '@muxr/contract';
import { Item } from '@/components/Item';
import type { PluginCatalogEntry } from '../application/pluginStore';

export const BUILTIN_GROUPS = [
    { title: 'Browse & files', ids: ['muxr.browser', 'muxr.code', 'muxr.attachments'] },
    { title: 'Terminal & layout', ids: ['muxr.panes', 'muxr.control', 'muxr.workspace-hierarchy', 'muxr.terminal-keys'] },
    { title: 'Voice & input', ids: ['muxr.voice', 'muxr.dictation'] },
    { title: 'Usage & machine', ids: ['muxr.status'] },
] as const;

export const BUILTIN_IDS = new Set<string>(BUILTIN_GROUPS.flatMap((group) => [...group.ids]));

export function pluginDisplayName(pluginId: string, registeredName?: string): string {
    return pluginId === 'muxr.code' ? 'Code' : registeredName ?? pluginId;
}

const DESCRIPTIONS: Record<string, string> = {
    'muxr.browser': 'Open web pages and agent browser sessions',
    'muxr.code': 'Browse files, diffs, and git history',
    'muxr.attachments': 'Open shared files and images',
    'muxr.panes': 'Open shells and plugin tools',
    'muxr.control': 'Control panes and tabs',
    'muxr.workspace-hierarchy': 'Browse workspaces, tabs, and agents',
    'muxr.terminal-keys': 'Extra keys above the phone keyboard',
    'muxr.voice': 'Live speech-to-speech with an agent',
    'muxr.dictation': 'Speak a prompt on your device',
    'muxr.status': 'Usage, limits, and machine health',
    'animal-namer': 'Gives unnamed agents animal identities',
    'auto-namer': 'Names agents, panes, tabs, and workspaces',
    'herdr-plugin-renamer': 'Names tasks, panes, and generated worktrees',
    'zenbu-labs.terminal-browser': 'Older split-pane launcher; use Browser',
    'zenbu-labs.tode': 'Older split-pane launcher; use Code',
};

export function pluginDescription(pluginId: string, registeredDescription?: string): string {
    return DESCRIPTIONS[pluginId] ?? registeredDescription ?? 'Herdr extension';
}

export function PluginCatalogRow({ entry, connected, effective, onPress }: {
    entry: PluginCatalogEntry;
    connected: boolean;
    effective?: string;
    onPress: () => void;
}) {
    const { summary, manifest } = entry;
    const incompatible = manifest === undefined ? undefined : pluginCompatibilityError(manifest, MUXR_UI_VERSION);
    const state = !connected ? 'Offline'
        : summary.enabled === false ? 'Off in Herdr'
        : incompatible !== undefined ? 'Update muxr'
        : summary.manifestHash !== undefined && !summary.approved ? 'Approve'
        : summary.warnings.length > 0 ? 'Unavailable'
        : 'On';
    let value = state;
    if (state === 'On' && effective) value = effective.replace(' (experimental)', '');
    const description = pluginDescription(summary.pluginId, summary.description);
    return <Item title={pluginDisplayName(summary.pluginId, summary.name)} subtitle={`${value}\n${description}`} subtitleLines={3}
        style={{ paddingVertical: 10 }} showChevron onPress={onPress} />;
}
