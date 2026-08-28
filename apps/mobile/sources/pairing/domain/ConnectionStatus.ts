export type SocketStatusName = 'connected' | 'connecting' | 'disconnected' | 'error' | string;

export type ConnectionStatusCopy = {
    kind: 'connected' | 'connecting' | 'disconnected' | 'error' | 'unknown';
    textKey: 'connected' | 'connecting' | 'disconnected' | 'pairingIssue' | 'error' | 'empty';
    pulsing: boolean;
};

export class ConnectionStatus {
    constructor(
        readonly status: SocketStatusName,
        readonly error?: string | null,
    ) {}

    presentation(): ConnectionStatusCopy {
        switch (this.status) {
            case 'connected':
                return { kind: 'connected', textKey: 'connected', pulsing: false };
            case 'connecting':
                return { kind: 'connecting', textKey: 'connecting', pulsing: true };
            case 'disconnected':
                return { kind: 'disconnected', textKey: 'disconnected', pulsing: false };
            case 'error':
                return {
                    kind: 'error',
                    textKey: this.error !== null && this.error !== undefined ? 'pairingIssue' : 'error',
                    pulsing: false,
                };
            default:
                return { kind: 'unknown', textKey: 'empty', pulsing: false };
        }
    }
}
