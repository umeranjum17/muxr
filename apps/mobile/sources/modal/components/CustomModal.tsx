import React from 'react';
import { BaseModal } from '@/modal/components/BaseModal';
import { CustomModalConfig } from '@/modal/types';
import { CommandPaletteModal } from '@/components/CommandPalette/CommandPaletteModal';
import { CommandPalette } from '@/components/CommandPalette';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
}

export function CustomModal({ config, onClose }: CustomModalProps) {
    const Component = config.component;
    
    // Use special modal wrapper for CommandPalette with animation support
    if (Component === CommandPalette) {
        return <CommandPaletteWithAnimation config={config} onClose={onClose} />;
    }
    
    // Only BaseModal's own close (backdrop, hardware back) means the user walked
    // away. Being covered by a second modal unmounts this without going through
    // here, so a dialog waiting on an answer must not treat that as a dismissal.
    const handleDismiss = () => {
        config.props?.onDismiss?.();
        onClose();
    };

    return (
        <BaseModal
            visible={true}
            onClose={handleDismiss}
            closeOnBackdrop={config.closeOnBackdrop !== false}
            align={config.align ?? 'center'}
        >
            <Component {...config.props} onClose={onClose} />
        </BaseModal>
    );
}

// Helper component to manage CommandPalette animation state
function CommandPaletteWithAnimation({ config, onClose }: CustomModalProps) {
    const [isClosing, setIsClosing] = React.useState(false);
    
    const handleClose = React.useCallback(() => {
        setIsClosing(true);
        // Wait for animation to complete before unmounting
        setTimeout(onClose, 200);
    }, [onClose]);
    
    return (
        <CommandPaletteModal visible={!isClosing} onClose={onClose}>
            <CommandPalette {...config.props} onClose={handleClose} />
        </CommandPaletteModal>
    );
}