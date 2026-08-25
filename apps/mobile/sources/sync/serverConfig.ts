import { relayControlUrl } from '@muxr/contract';
import { DEFAULT_CONNECTION } from '../state/connectionSettings';

export function getServerUrl(): string {
    return relayControlUrl(DEFAULT_CONNECTION.relayUrl);
}
