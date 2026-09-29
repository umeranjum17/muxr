import type { PluginNativeContribution, PluginNativeSlot } from '@trymuxr/contract';
import type { PluginSlotContexts } from './slotTypes';

export type PrimitiveProps = {
    pluginId: string;
    manifestHash: string;
    contribution: PluginNativeContribution;
    context: PluginSlotContexts[PluginNativeSlot];
};
