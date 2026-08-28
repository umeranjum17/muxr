export { watchAgentLifecycle } from './application/watchAgentLifecycle';
export { reportAgentOutcome } from './application/reportAgentOutcome';
export {
    lifecycleIsBusy,
    lifecycleIsDeskFocus,
    lifecycleIsWorking,
    lifecycleIsRoutineVoice,
    lifecycleNeedsApproval,
    lifecycleNeedsHumanAlert,
    lifecycleSince,
    lifecycleWatchOutcome,
} from './domain/lifecycle';
export {
    parseVoiceReport,
    parseVoiceReportInput,
    sanitizePersistedVoiceReport,
    spokenNameIsTrusted,
    type VoiceAdmission,
    type VoiceReport,
    type VoiceReportParse,
} from './domain/voiceReport';
