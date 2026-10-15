import { Platform } from 'react-native';
import { Modal } from '@/modal';

/**
 * Shows the SSH host-fingerprint confirmation and resolves with the user's
 * answer. A stray backdrop tap or the hardware back button counts as a
 * decline, so silence can never pin a key: only Fingerprint matches approves.
 *
 * Web and iOS keep the platform-styled confirm. Android shows the in-app
 * dialog from `./SshFingerprintDialog`, imported lazily so it never joins
 * the web eager payload: web never renders it.
 */
export async function confirmSshFingerprint(fingerprint: string): Promise<boolean> {
    if (Platform.OS !== 'android') {
        return Modal.confirm('Check SSH fingerprint', `Compare this fingerprint with your provider console before continuing.\n\n${fingerprint}\n\nNo login details have been sent.`, {
            confirmText: 'Fingerprint matches', cancelText: 'Cancel',
        });
    }
    const { SshFingerprintDialog } = await import('./SshFingerprintDialog');
    return new Promise((resolve) => {
        let settled = false;
        let id = '';
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            if (id !== '') Modal.hide(id);
            resolve(value);
        };
        id = Modal.show({
            component: SshFingerprintDialog,
            props: {
                fingerprint,
                onConfirm: () => finish(true),
                onCancel: () => finish(false),
                onDismiss: () => finish(false),
            },
            closeOnBackdrop: false,
        });
    });
}
