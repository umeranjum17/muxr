/**
 * XDG autostart for the desktop app: one .desktop entry under
 * `$XDG_CONFIG_HOME/autostart` (usually `~/.config/autostart`). On by default,
 * the person can turn it off; the tray and the window toggle it. When the app
 * runs as an AppImage, `$APPIMAGE` names the file to launch, because the mounted
 * `process.execPath` changes every run.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function autostartDir() {
    const configHome = process.env.XDG_CONFIG_HOME?.trim();
    return join(configHome !== undefined && configHome !== '' ? configHome : join(homedir(), '.config'), 'autostart');
}

export function autostartPath() {
    return join(autostartDir(), 'muxr-desktop.desktop');
}

export function autostartInstalled() {
    if (process.platform === 'darwin') return app.getLoginItemSettings().openAtLogin;
    return existsSync(autostartPath());
}

export function setAutostart(enabled, { execPath, appImage }) {
    if (process.platform === 'darwin') {
        app.setLoginItemSettings({ openAtLogin: enabled });
        return;
    }
    const path = autostartPath();
    if (!enabled) {
        rmSync(path, { force: true });
        return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    const command = appImage !== undefined && appImage.trim() !== '' ? appImage.trim() : execPath;
    writeFileSync(path, [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.0',
        'Name=muxr',
        'Comment=Control your Herdr coding agents from your phone',
        `Exec="${command}" --hidden`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
    ].join('\n'), 'utf8');
}
