import { relayControlUrl } from '@muxr/contract';
import { DEFAULT_CONNECTION } from '@/connection';

export function getServerUrl(): string {
    return relayControlUrl(DEFAULT_CONNECTION.relayUrl);
}
