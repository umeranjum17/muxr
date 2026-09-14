import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { openExternalUrl } from '@/utils/openExternalUrl';

export default function PluginGuide() {
    return <ItemList>
        <ItemGroup title="Where plugins live" footer="Plugins run on your computer through Herdr. Their muxr screens and controls appear after connection.">
            <Item title="Built-in categories" subtitle="Agent workflow, files, terminal, voice, and machine status" showChevron={false} />
            <Item title="Installed extensions" subtitle="Extra Herdr plugins remain visible here even when disabled." showChevron={false} />
        </ItemGroup>
        <ItemGroup title="Two controls" footer="Disabling in Herdr stops the plugin for the machine. Device approval controls whether its muxr UI and host calls can run on this device.">
            <Item title="Install or enable" subtitle="Manage the Herdr registration on the computer." showChevron={false} />
            <Item title="Approve and configure" subtitle="Open a plugin detail here after connecting." showChevron={false} />
        </ItemGroup>
        <ItemGroup title="Task titles" footer="Task titles name the work. Agent identity names who is doing it. Manual renames always win.">
            <Item title="Another title writer active?" subtitle="Use Switch in Task titles, or keep the existing writer. Restore it later from the same detail." showChevron={false} />
            <Item title="Offline or unsure?" subtitle="Existing titles stay. Preview is read-only and can explain rejected samples." showChevron={false} />
        </ItemGroup>
        <ItemGroup title="Learn more">
            <Item title="User guide" detail="Open" showChevron onPress={() => openExternalUrl('https://github.com/umeranjum17/muxr/blob/main/docs/USING-PLUGINS.md')} />
            <Item title="Build a plugin" detail="Developer guide" showChevron onPress={() => openExternalUrl('https://github.com/umeranjum17/muxr/blob/main/docs/PLUGINS.md')} />
        </ItemGroup>
    </ItemList>;
}
