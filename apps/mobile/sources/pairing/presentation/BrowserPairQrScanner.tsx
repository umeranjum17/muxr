import type { BrowserPairingQr } from '../domain/pairingString';

export type BrowserPairQrScannerProps = {
    /** Launcher label, e.g. "Scan QR to pair". */
    title: string;
    onScanned: (qr: BrowserPairingQr) => void;
};

/** Native never scans here: the system scanner in usePairQrScanner owns it. */
export function canScanBrowserPairQr(): boolean {
    return false;
}

export function BrowserPairQrScanner(_props: BrowserPairQrScannerProps): null {
    return null;
}
