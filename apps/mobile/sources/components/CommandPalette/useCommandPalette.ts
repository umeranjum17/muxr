import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { TextInput } from 'react-native';
import { Command, CommandCategory, CUSTOM_CATEGORY } from '@/components/CommandPalette/types';
import { t } from '@/text';

export function useCommandPalette(commands: Command[], onClose: () => void, quietLine?: string) {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<TextInput>(null);

    // Filter commands based on search query
    const filteredCategories = useMemo((): CommandCategory[] => {
        if (!searchQuery.trim()) {
            // Group commands by category
            const grouped = commands.reduce((acc, command) => {
                const category = command.category || 'General';
                if (!acc[category]) {
                    acc[category] = [];
                }
                acc[category].push(command);
                return acc;
            }, {} as Record<string, Command[]>);

            return Object.entries(grouped).map(([title, cmds]) => ({
                id: title.toLowerCase().replace(/\s+/g, '-'),
                title,
                commands: cmds
            }));
        }

        // Fuzzy search
        const query = searchQuery.toLowerCase();
        const filtered = commands.filter(command => {
            const titleMatch = command.title.toLowerCase().includes(query);
            const subtitleMatch = command.subtitle?.toLowerCase().includes(query);
            return titleMatch || subtitleMatch;
        });

        if (filtered.length === 0) {
            return [];
        }

        // Group filtered results
        const grouped = filtered.reduce((acc, command) => {
            const category = command.category || 'Results';
            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push(command);
            return acc;
        }, {} as Record<string, Command[]>);

        return Object.entries(grouped).map(([title, cmds]) => ({
            id: title.toLowerCase().replace(/\s+/g, '-'),
            title,
            commands: cmds
        }));
    }, [commands, searchQuery]);

    // The rows the palette shows: sections while browsing, one ranked list
    // under a query, and the Custom row kept visible when nothing matches.
    const { categories, quiet } = useMemo(() => {
        if (searchQuery.trim() === '') {
            return quietLine === undefined
                ? { categories: filteredCategories, quiet: undefined }
                : { categories: filteredCategories.map((category) => ({ ...category, title: '' })), quiet: quietLine };
        }
        const matches = filteredCategories.flatMap((category) => category.commands);
        if (matches.length > 0) return { categories: [{ id: 'results', title: '', commands: matches }], quiet: undefined };
        const custom = commands.filter((command) => command.category === CUSTOM_CATEGORY);
        return { categories: custom.map((command) => ({ id: CUSTOM_CATEGORY, title: '', commands: [command] })), quiet: t('commandPalette.noMatch') };
    }, [searchQuery, filteredCategories, commands, quietLine]);

    // Reset selection when search changes
    useEffect(() => {
        setSelectedIndex(0);
    }, [searchQuery]);

    // An action resolves to false to keep the palette open (a destructive
    // confirm the user walked away from); anything else closes it.
    const handleSelectCommand = useCallback((command: Command) => {
        void Promise.resolve(command.action()).then((result) => {
            if (result !== false) onClose();
        });
    }, [onClose]);
    const handleSecondaryCommand = useCallback((command: Command) => {
        command.secondaryAction?.();
        onClose();
    }, [onClose]);

    // Get flattened commands for keyboard navigation — the same rows on screen
    const allCommands = useMemo(() => {
        return categories.flatMap(cat => cat.commands);
    }, [categories]);

    const handleKeyPress = useCallback((key: string) => {
        switch(key) {
            case 'Escape':
                onClose();
                break;
            case 'ArrowDown':
                setSelectedIndex(prev => Math.max(0, Math.min(prev + 1, allCommands.length - 1)));
                break;
            case 'ArrowUp':
                setSelectedIndex(prev => Math.max(prev - 1, 0));
                break;
            case 'Enter':
                if (allCommands[selectedIndex]) {
                    handleSelectCommand(allCommands[selectedIndex]);
                }
                break;
        }
    }, [onClose, allCommands, selectedIndex, handleSelectCommand]);

    const handleSearchChange = useCallback((text: string) => {
        setSearchQuery(text);
    }, []);

    return {
        searchQuery,
        selectedIndex,
        categories,
        quiet,
        inputRef,
        handleSearchChange,
        handleSelectCommand,
        handleSecondaryCommand,
        handleKeyPress,
        setSelectedIndex,
    };
}
