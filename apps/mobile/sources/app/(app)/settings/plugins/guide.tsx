import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { openExternalUrl } from '@/utils/openExternalUrl';

export default function PluginGuide() {
    return <ItemList>
        <ItemGroup title="Where plugins live" footer="Plugins run on your computer through Herdr. Their muxr screens and controls appear after connection.">
            <Item title="Built-in categories" subtitle="Files, terminal, voice, and machine status" subtitleLines={0} showChevron={false} />
            <Item title="Installed extensions" subtitle="Extra Herdr plugins remain visible here even when disabled." subtitleLines={0} showChevron={false} />
        </ItemGroup>
        <ItemGroup title="Two controls" footer="Disabling in Herdr stops the plugin for the machine. Device approval controls whether its muxr UI and host calls can run on this device.">
            <Item title="Install or enable" subtitle="Manage the Herdr registration on the computer." subtitleLines={0} showChevron={false} />
            <Item title="Approve and configure" subtitle="Open a plugin detail here after connecting." subtitleLines={0} showChevron={false} />
        </ItemGroup>
        <ItemGroup title="Optional naming" footer="muxr displays names and titles supplied by Herdr. Naming extensions are installed and managed in Herdr on your computer.">
            <Item title="Herdr Renamer" subtitle="Optional third-party plugin for automatic task titles" subtitleLines={0} detail="GitHub" showChevron onPress={() => openExternalUrl('https://github.com/wyattjoh/herdr-plugin-renamer')} />
        </ItemGroup>
        <ItemGroup title="Learn more">
            <Item title="User guide" detail="Open" showChevron onPress={() => openExternalUrl('https://github.com/umeranjum17/muxr/blob/main/docs/USING-PLUGINS.md')} />
            <Item title="Build a plugin" detail="Developer guide" showChevron onPress={() => openExternalUrl('https://github.com/umeranjum17/muxr/blob/main/docs/PLUGINS.md')} />
        </ItemGroup>
    </ItemList>;
}
