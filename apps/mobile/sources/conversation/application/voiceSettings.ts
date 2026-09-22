import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type RequestParams, type RequestResult } from '@muxr/contract';
import { sync } from '@/catalog/sync';

/**
 * Realtime voice, as product code.
 *
 * The provider adapters are internal host modules, so these are typed host
 * methods rather than plugin capabilities: there is no plugin catalog, no
 * manifest hash, and no per-device plugin approval anywhere in this path.
 */
async function call<T extends 'voice.status' | 'voice.provider.list' | 'voice.provider.set' | 'voice.provider.describe' | 'voice.key.set' | 'voice.key.clear' | 'voice.report'>(
    type: T,
    params: RequestParams<T>,
): Promise<RequestResult<T>> {
    return sync.request<T>(type, params, PLUGIN_CALL_CLIENT_TIMEOUT_MS);
}

export function voiceStatus() {
    return call('voice.status', {});
}

export function voiceProviderList() {
    return call('voice.provider.list', {});
}

export function voiceProviderSet(providerId: string) {
    return call('voice.provider.set', { providerId });
}

export function voiceProviderDescribe(providerId?: string) {
    return call('voice.provider.describe', { ...(providerId === undefined ? {} : { providerId }) });
}

export function voiceKeySet(key: string, providerId?: string) {
    return call('voice.key.set', { key, ...(providerId === undefined ? {} : { provider: providerId }) });
}

export function voiceKeyClear(providerId?: string) {
    return call('voice.key.clear', { ...(providerId === undefined ? {} : { provider: providerId }) });
}

/** Speak one bounded agent-stop outcome. The sentence is derived by the host. */
export function voiceReport(params: RequestParams<'voice.report'>) {
    return call('voice.report', params);
}
