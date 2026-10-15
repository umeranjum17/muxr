/**
 * The muxr desktop app's Electron main process.
 *
 * It owns one small window and one tray icon, supervises the muxr runtime
 * (relay + host, from the repo, unchanged), and draws the pairing offer the
 * running host mints. Every state is said in plain words: Starting, Ready to
 * pair, Paired, or Offline/Error with a retry.
 */
import { app, BrowserWindow, clipboard, Menu, Tray, ipcMain, nativeImage, powerSaveBlocker, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrMatrix } from '@byokit/ui-core/link';
import { autostartInstalled, setAutostart } from './autostart.mjs';
import { openPairingSocket } from './pairClient.mjs';
import { MuxrRuntime, RelayOwnedError } from './runtime.mjs';
import { createHerdrSetup, wireHerdrToRuntime } from './herdrSetup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const HOST_ENTRY = app.isPackaged ? join(here, 'host.mjs') : join(repoRoot, 'apps', 'host', 'dist', 'main.js');
const RELAY_ENTRY = app.isPackaged ? join(here, 'relay.mjs') : join(repoRoot, 'apps', 'relay', 'dist', 'main.js');
const rendererDir = app.isPackaged ? join(here, '..', 'src', 'renderer') : join(here, 'renderer');
const asset = (name) => join(here, '..', 'build', name);

const MUXR_HOME = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
const RELAY_PORT = Number(process.env.MUXR_RELAY_PORT?.trim() || 8792);
const startHidden = process.argv.includes('--hidden');

const settingsPath = join(app.getPath('userData'), 'settings.json');
function readSettings() {
    try { return JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch { return {}; }
}
function writeSettings(next) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
function settingsFailure(what, error) {
    process.stderr.write(`desktop: ${what} failed: ${error instanceof Error ? error.message : String(error)}\n`);
}

let win;
let tray;
let runtime;
let pairing;
let reopenTimer;
let retrying = false;
let blockerId = null;
let settings = { keepAwake: false, autostart: true };
// The state the window shows; kept so a window opened later paints immediately.
let state = { phase: 'starting' };
// Herdr is said beside the runtime phase, because pairing still works without it.
const herdr = createHerdrSetup(() => send(state));

// The window says one plain sentence and what Try again does. The raw runtime
// detail (which host/relay exited and why) goes to the log, never to the window.
const START_FAILED_MESSAGE = 'muxr could not start on this computer. Choose Try again to start it again.';
const RUNTIME_EXIT_MESSAGE = 'muxr stopped unexpectedly. Choose Try again to start it again.';
const STALLED_MESSAGE = 'muxr is taking longer than usual to start on this computer. Choose Try again to start it again.';
function reportFailure(what, error, message) {
    process.stderr.write(`desktop: ${what}: ${error instanceof Error ? error.message : String(error)}\n`);
    send({ phase: 'error', message });
}

function send(next) {
    state = next;
    if (win !== undefined && !win.isDestroyed()) win.webContents.send('muxr:state', { ...state, herdr: herdr.state });
    updateTray();
}

function settingsForRenderer() {
    return { keepAwake: settings.keepAwake, autostart: autostartInstalled() };
}

function applyKeepAwake(on) {
    try {
        if (on && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
        else if (!on && blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
    } catch (error) { settingsFailure('keep awake', error); }
}

function applyAutostart(on) {
    try { setAutostart(on, { execPath: process.execPath, appImage: process.env.APPIMAGE }); }
    catch (error) { settingsFailure('start at login', error); }
}

function updateTray() {
    if (tray === undefined) return;
    const labels = { starting: 'Starting…', online: 'Ready to pair', approval: 'Waiting for approval', paired: 'Paired', error: 'Needs attention', 'already-running': 'Already running' };
    tray.setToolTip(`muxr — ${labels[state.phase] ?? 'muxr'}`);
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: labels[state.phase] ?? 'muxr', enabled: false },
        { type: 'separator' },
        { label: 'Open muxr', click: showWindow },
        { label: state.deviceName === undefined ? 'Pair a phone' : `Paired with ${state.deviceName}`, enabled: false },
        { type: 'separator' },
        { label: 'Keep this computer awake', type: 'checkbox', checked: settings.keepAwake, click: (item) => setKeepAwake(item.checked) },
        { label: 'Start at login', type: 'checkbox', checked: autostartInstalled(), click: (item) => setStartAtLogin(item.checked) },
        { type: 'separator' },
        { label: 'Quit muxr', click: () => app.quit() },
    ]));
}

function showWindow() {
    if (win === undefined || win.isDestroyed()) createWindow(true);
    else { win.show(); win.focus(); }
}

function createWindow(show = !startHidden || tray === undefined) {
    win = new BrowserWindow({
        width: 440,
        height: 660,
        minWidth: 380,
        minHeight: 520,
        title: 'muxr',
        backgroundColor: '#1a1a1a',
        show: false,
        autoHideMenuBar: true,
        icon: asset('icon.png'),
        webPreferences: {
            preload: join(here, 'preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    win.removeMenu();
    win.loadFile(join(rendererDir, 'index.html'));
    win.once('ready-to-show', () => {
        win.webContents.send('muxr:state', { ...state, herdr: herdr.state });
        win.webContents.send('muxr:settings', settingsForRenderer());
        if (show) win.show();
    });
    win.on('closed', () => { win = undefined; });
    win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
}

// The window's QR canvas is 210 CSS px wide; a matrix this tall still leaves
// each module at least two pixels, the smallest a phone camera scans cleanly.
const QR_MODULE_LIMIT = 105;

function offerState(offer) {
    const full = { text: offer.text, expires: offer.expires };
    const compact = typeof offer.compactText === 'string'
        ? { text: offer.compactText, expires: offer.compactExpires ?? offer.expires }
        : undefined;
    for (const candidate of [full, compact]) {
        if (candidate === undefined) continue;
        try {
            const qr = qrMatrix(candidate.text, { border: 3 });
            if (qr.length <= QR_MODULE_LIMIT) return { phase: 'online', code: candidate.text, expires: candidate.expires, qr };
        } catch { /* the next, smaller offer text may still render */ }
    }
    const shown = compact ?? full;
    return { phase: 'online', code: shown.text, expires: shown.expires };
}

const PAIRING_REOPEN_MS = 3_000;

// One shared timer: a completed or failed session and the socket's own close
// never both mint a fresh offer, and only the newest session re-opens.
function reopenPairingSoon() {
    if (reopenTimer !== undefined) clearTimeout(reopenTimer);
    reopenTimer = setTimeout(() => {
        reopenTimer = undefined;
        if (runtime !== undefined) startPairing();
    }, PAIRING_REOPEN_MS);
}

// Pairing runs only while the host is up: a stopped or killed host leaves
// pair.sock behind, and dialing it again would only be refused.
function stopPairing() {
    if (reopenTimer !== undefined) { clearTimeout(reopenTimer); reopenTimer = undefined; }
    const previous = pairing;
    pairing = undefined;
    previous?.close();
}

// Called once the runtime is online, which already waited for the host's own
// report that pair.sock is listening.
function startPairing() {
    stopPairing();
    const client = openPairingSocket(runtime.pairSocketPath, {
        onOffer: (offer) => send(offerState(offer)),
        onApproval: (approval) => send({ phase: 'approval', deviceName: approval.name, words: approval.words }),
        onPaired: (record) => { send({ phase: 'paired', deviceName: record?.name ?? 'your phone' }); reopenPairingSoon(); },
        onError: (message) => { send({ phase: 'error', message }); reopenPairingSoon(); },
        onLost: (error) => process.stderr.write(`desktop: pairing socket: ${error.message}\n`),
        onClosed: () => { if (pairing === client) reopenPairingSoon(); },
    });
    pairing = client;
}

async function startRuntime() {
    send({ phase: 'starting' });
    runtime = new MuxrRuntime({ home: MUXR_HOME, node: process.execPath, relayEntry: RELAY_ENTRY, hostEntry: HOST_ENTRY, port: RELAY_PORT });
    // The one place Herdr is read and started: launch check plus every status below.
    wireHerdrToRuntime(runtime, herdr);
    runtime.on('status', (event) => {
        // The Herdr forwarding lives in wireHerdrToRuntime above; only the pairing stop rides along here.
        if (event.phase === 'error') { stopPairing(); reportFailure('runtime error', event.message, RUNTIME_EXIT_MESSAGE); }
        else if (event.phase === 'starting') send({ phase: 'starting' });
        else if (event.phase === 'stalled') reportFailure('host still starting', 'no online report yet', STALLED_MESSAGE);
        else if (event.phase === 'already-running') send({ phase: 'already-running', message: event.message, canRetry: event.canRetry === true });
        else if (event.phase === 'online') { send({ phase: 'online', message: 'Ready to pair' }); startPairing(); }
    });
    runtime.on('log', (_label, chunk) => process.stdout.write(chunk));
    try { await runtime.start(); }
    catch (error) {
        if (error instanceof RelayOwnedError) return;
        reportFailure('start failed', error, START_FAILED_MESSAGE);
    }
}

function setKeepAwake(on) {
    settings = { ...settings, keepAwake: on };
    try { writeSettings(settings); } catch (error) { settingsFailure('saving settings', error); }
    applyKeepAwake(on);
    if (win !== undefined && !win.isDestroyed()) win.webContents.send('muxr:settings', settingsForRenderer());
    updateTray();
}

function setStartAtLogin(on) {
    settings = { ...settings, autostart: on };
    try { writeSettings(settings); } catch (error) { settingsFailure('saving settings', error); }
    applyAutostart(on);
    if (win !== undefined && !win.isDestroyed()) win.webContents.send('muxr:settings', settingsForRenderer());
    updateTray();
}

// A second launch (including the autostart entry) wakes the running one instead
// of starting a second host.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());

    app.whenReady().then(async () => {
        settings = { keepAwake: false, autostart: true, ...readSettings() };
        applyKeepAwake(settings.keepAwake);
        if (process.env.MUXR_DESKTOP_AUTOSTART !== 'skip') applyAutostart(settings.autostart);
        try { tray = new Tray(nativeImage.createFromPath(asset('tray.png'))); tray.on('click', showWindow); updateTray(); }
        catch (error) { process.stderr.write(`tray unavailable: ${error instanceof Error ? error.message : String(error)}\n`); }
        createWindow();
        await startRuntime();
    });

    app.on('activate', () => showWindow());
    app.on('window-all-closed', () => { if (tray === undefined) app.quit(); });
    app.on('before-quit', () => {
        stopPairing();
        runtime?.stop();
        if (blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
    });

    ipcMain.handle('muxr:settings', () => settingsForRenderer());
    ipcMain.handle('muxr:approve', () => { pairing?.approve(true); send({ phase: 'online', message: 'Finishing pairing…' }); });
    ipcMain.handle('muxr:deny', () => { pairing?.approve(false); send({ phase: 'online', message: 'Pairing declined' }); });
    ipcMain.handle('muxr:retry', async () => {
        if (retrying) return;
        retrying = true;
        try {
            stopPairing();
            await runtime?.stop();
            runtime = undefined;
            await startRuntime();
        } finally { retrying = false; }
    });
    ipcMain.handle('muxr:install-herdr', () => herdr.install());
    ipcMain.handle('muxr:set-keep-awake', (_event, on) => setKeepAwake(Boolean(on)));
    ipcMain.handle('muxr:set-autostart', (_event, on) => setStartAtLogin(Boolean(on)));
    ipcMain.handle('muxr:copy', (_event, text) => { clipboard.writeText(String(text)); });
    ipcMain.handle('muxr:quit', () => app.quit());
}

process.on('uncaughtException', (error) => process.stderr.write(`desktop: ${error.stack ?? error.message}\n`));
