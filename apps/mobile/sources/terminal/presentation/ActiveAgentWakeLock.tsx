import { useKeepAwake } from 'expo-keep-awake';

/** Mounted only while the foreground terminal is watching live agent work. */
export function ActiveAgentWakeLock() {
    useKeepAwake();
    return null;
}
