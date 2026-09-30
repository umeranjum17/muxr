/**
 * What a new pane runs: the same agent list the home dock offers, Shell
 * first. Asks the host which agents it can start the first time it opens.
 */

import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { sync } from '@/catalog/sync';
import { resolveAgentCatalog, type AgentCatalogOption } from '@/catalog';
import { visibleDockAgents } from '@/spawn';

export function AgentPickerSheet(props: { visible: boolean; title: string; onSelect: (option: ModelMode) => void; onClose: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const [catalogCheck, setCatalogCheck] = React.useState(0);
    const [agents, setAgents] = React.useState<AgentCatalogOption[] | null>(null);
    const [more, setMore] = React.useState(false);
    React.useEffect(() => {
        if (!props.visible) { setMore(false); return; }
        let live = true;
        void sync.request('herdr.agentKinds', { refresh: catalogCheck > 0 }).then((result) => {
            if (live) setAgents(resolveAgentCatalog(result).options);
        }).catch(() => { if (live) setAgents([]); });
        return () => { live = false; };
    }, [props.visible, catalogCheck]);
    return (
        <OptionSheet
            visible={props.visible}
            title={props.title}
            options={visibleDockAgents(agents, more)}
            footer={<View style={{ gap: 12 }}><Pressable onPress={() => setMore((value) => !value)}><Text style={{ color: theme.colors.textLink }}>{more ? 'Installed agents' : `More agents (${visibleDockAgents(agents, true).length}) — install`}</Text></Pressable><Pressable onPress={() => setCatalogCheck((value) => value + 1)}><Text style={{ color: theme.colors.textLink }}>Check again</Text></Pressable></View>}
            emptyText="Checking which agents this computer can start…"
            onSelect={props.onSelect}
            onClose={props.onClose}
        />
    );
}
