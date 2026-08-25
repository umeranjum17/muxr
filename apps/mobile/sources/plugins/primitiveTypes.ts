import type { PluginNativeContribution, PluginNativeSlot } from '@muxr/contract';
import type { PluginSlotContexts } from './slotTypes';

export type PrimitiveProps = {
    pluginId: string;
    manifestHash: string;
    contribution: PluginNativeContribution;
    context: PluginSlotContexts[PluginNativeSlot];
};
