import { shownUsage } from '../application/freshnessWindow';
import { vitalsFacts } from '../domain/usageModel';
import { t } from '@/text';

/** The figures behind Home's one word, for a tap on the computer's name: memory,
 *  disk, load and uptime, each in plain words. Empty until a read has shown vitals. */
export function hostVitalsDetails(): string[] {
    const display = shownUsage('');
    const vitals = display === undefined ? undefined
        : display.status === 'figures' ? display.figures.vitals : display.vitals;
    const facts = vitals === undefined ? undefined : vitalsFacts(vitals);
    if (facts === undefined) return [];
    const { memoryPercent, diskPercent, load, uptime } = facts;
    return [
        `${t('plugins.rightNow.memory')} ${memoryPercent}%`,
        ...(diskPercent === undefined ? [] : [`${t('plugins.rightNow.disk')} ${diskPercent}%`]),
        `${t('plugins.rightNow.load')} ${load}`,
        `${t('plugins.rightNow.up')} ${uptime}`,
    ];
}
