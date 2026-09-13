import * as React from 'react';
import { ScopedTheme } from 'react-native-unistyles';
import { create } from 'zustand';

export type SurfaceThemeName = 'light' | 'dark';

/**
 * Unistyles' ScopedTheme is a render-order marker, not React context: it
 * themes only what renders in the same pass as itself. Anything that mounts
 * from a state update below it — a Modal's content, a list row that arrives
 * later, a plugin list resolving — reads the app theme instead, and stays
 * pinned to it. SurfaceTheme carries the surface's theme in context so such
 * a late mount can re-apply it exactly where it mounts.
 *
 * `<SurfaceTheme name="dark">` names a surface at its root;
 * `<SurfaceTheme>` inside a late mount re-applies the surface it sits in,
 * and is a no-op outside any named surface.
 */
const SurfaceThemeContext = React.createContext<SurfaceThemeName | undefined>(undefined);

/**
 * The named surfaces currently mounted, innermost last, for dialogs that a
 * static call opens at the app root (Modal.confirm) with no context to read.
 */
// ponytail: one stack for the whole app; a tablet split showing a dark and a
// light surface at once would make its dialogs follow the last one mounted.
// Give ModalConfig a surface hint if that ever matters.
const useMountedSurfaces = create<{ names: SurfaceThemeName[] }>(() => ({ names: [] }));

export function useActiveSurfaceTheme(): SurfaceThemeName | undefined {
    return useMountedSurfaces((state) => state.names[state.names.length - 1]);
}

export function SurfaceTheme({ name, children }: { name?: SurfaceThemeName; children: React.ReactNode }) {
    const inherited = React.useContext(SurfaceThemeContext);
    const surface = name ?? inherited;
    React.useEffect(() => {
        if (name === undefined) return;
        useMountedSurfaces.setState((state) => ({ names: [...state.names, name] }));
        return () => useMountedSurfaces.setState((state) => {
            const index = state.names.lastIndexOf(name);
            return index === -1 ? state : { names: state.names.filter((_, at) => at !== index) };
        });
    }, [name]);
    if (surface === undefined) return <>{children}</>;
    return (
        <SurfaceThemeContext.Provider value={surface}>
            <ScopedTheme name={surface}>{children}</ScopedTheme>
        </SurfaceThemeContext.Provider>
    );
}
