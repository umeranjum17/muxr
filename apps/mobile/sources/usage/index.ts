/** Usage and machine health: product surfaces behind the host's typed
 *  usage.report / usage.now methods. Screens live in `./ui`. */
export { RightNowCard } from './presentation/RightNowCard';
export { UsageScreen } from './presentation/UsageScreen';
export { ScreenLimits, presentedVerdict, runOut, VERDICT_KEYS, verdictTone } from './presentation/ScreenLimits';
export { ScreenChart } from './presentation/ScreenCharts';
export { ScreenWidthProvider, useScreenContentWidth } from './presentation/screenWidth';
export { toneColor } from './domain/usageTone';
export * from './domain/chartModel';
export * from './domain/limitsModel';
export { useUsageNow } from './application/useUsageNow';
export { vitalsFacts, type VitalsFacts } from './domain/usageModel';
