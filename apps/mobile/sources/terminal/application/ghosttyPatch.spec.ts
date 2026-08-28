import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../../../../');
const patch = join(root, 'patches/expo-libghostty+0.8.1.patch');
const view = join(root, 'node_modules/expo-libghostty/android/src/main/java/expo/modules/libghostty/ExpoLibghosttyView.kt');
const terminal = join(root, 'node_modules/expo-libghostty/android/src/main/java/expo/modules/libghostty/GhosttyTerminalView.kt');
const iosModule = join(root, 'node_modules/expo-libghostty/ios/ExpoLibghosttyModule.swift');
const iosView = join(root, 'node_modules/expo-libghostty/ios/ExpoLibghosttyView.swift');
const iosTerminalView = join(root, 'node_modules/expo-libghostty/ios/vendor/GhosttyTerminal/Platform/UIKit/UITerminalView.swift');

/**
 * These invariants have silently vanished before: regenerating the patch for
 * one of them dropped the others, and the accessory bar came back in a
 * shipped build. Assert the patch carries all three, and that they are
 * actually applied to the installed native files.
 */
describe('expo-libghostty patch', () => {
    const contents = readFileSync(patch, 'utf8');

    it('hides the accessory bar, which we replace with our own key toolbar', () => {
        expect(contents).toContain('accessoryBar.visibility = GONE');
        expect(readFileSync(view, 'utf8')).toContain('accessoryBar.visibility = GONE');
    });

    it('leaves JS (TerminalScreen) the sole keyboard-avoidance owner: the native IME-overlap padding must stay out of both the patch and the applied file', () => {
        // The patch may only carry the padding as removed (-) lines; any added
        // (+) or context line means the double-owner bug is back.
        expect(contents).not.toMatch(/^\+.*(setPadding\(0, 0, 0, overlap\)|imeBottom)/m);
        const applied = readFileSync(view, 'utf8');
        expect(applied).not.toContain('setPadding(0, 0, 0, overlap)');
        expect(applied).not.toContain('imeBottom');
    });

    it('forwards scrolling on both native platforms, since herdr owns the scrollback', () => {
        expect(contents).toContain('onScrollRows');
        expect(readFileSync(terminal, 'utf8')).toContain('onScrollRows');
        expect(readFileSync(view, 'utf8')).toContain('onScroll');
        expect(readFileSync(iosModule, 'utf8')).toContain('Events("onInput", "onResize", "onScroll")');
        expect(readFileSync(iosView, 'utf8')).toContain('terminalView.hostScrollHandler');
        expect(readFileSync(iosTerminalView, 'utf8')).toContain('hostScrollHandler');
    });
});
