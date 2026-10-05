import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEngine } from '@desklink/host';

import { authorityEntry, firstFreeDisplayNumber, onPath, removeDisplayFiles, waitForDisplaySocket } from './x11Display.js';

/**
 * A private screen for one agent pane.
 *
 * Every agent pane muxr launches through Herdr gets its own cookie-protected
 * Xvfb and the pinned engine's display keeper on it, so whatever the agent puts on
 * that screen — a headed browser, a windowed emulator — belongs to that pane.
 * The screen is the evidence that an agent is using a browser, not a claim made
 * by some tool's API, which is what makes it work for every browser tool.
 *
 * A pane whose screen cannot be made starts exactly as it does today: no
 * screen, no env, no diagnostic beyond one line. The host never shows a display
 * to a client either; it resolves a session to the screen it allocated here.
 */
const XVFB = 'Xvfb';
/** Kept clear of the host's own screen, which starts at 90. */
const FIRST_NUMBER = 110;
/** Screens one host keeps alive: past this, a pane gets today's behaviour. */
export const MAX_PANE_SCREENS = 16;
/** A desktop viewport; the phone fits it to width and zooms. */
const SCREEN_SIZE = '1280x800x24';
const START_TIMEOUT_MS = 5000;
/** How long the keeper must stay up before this host trusts it is installed. */
const KEEPER_PROBE_MS = 500;
/** How long the engine gets to answer the mode probe before it counts as unanswerable. */
const MODE_PROBE_TIMEOUT_MS = 2000;
/** The engine's display-keeper mode, listed in its own usage when it has one. */
const KEEPER_MODE = 'keep';
/**
 * Headed by default, off Wayland, and painting while occluded: the owner's own
 * browser flags force Wayland, and a background renderer throttles to ~2.5 fps.
 */
const AGENT_BROWSER_ARGS = [
    '--ozone-platform=x11',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--force-device-scale-factor=1',
].join(',');

/** One top-level window the keeper sees on a pane's screen.
 *
 * The keeper may report `class` as a string or array and `title` as nullable;
 * the presence tracker normalizes both. */
export interface ScreenWindow {
    id?: number;
    title?: string | null;
    class?: string[] | string | null;
    pid?: number;
    width?: number;
    height?: number;
}

/** An allocated screen: the display a pane runs on and the variables that pin it there. */
export interface PaneScreen {
    display: string;
    env: Record<string, string>;
}

export interface PaneScreensOptions {
    env?: NodeJS.ProcessEnv;
    socketDirectory?: string;
    stateDirectory?: string;
    /** A bounded line with no ids, paths or tokens. */
    onDiagnostic?: (line: string) => void;
}

interface LiveScreen extends PaneScreen {
    number: number;
    /** The cookie's own directory, removed with the screen so no stale env can read it. */
    authorityDirectory: string;
    server: ChildProcess;
    keeper?: ChildProcess;
    /** A JSON line can arrive split across two reads. */
    keeperBuffer: string;
    windows: ScreenWindow[];
    paneId?: string | undefined;
    /** When this screen was tied to its pane, so a stale tree cannot retire it. */
    boundAt?: number;
}

/** The variables that put a pane's processes on its own screen. */
function screenEnv(display: string, authorityFile: string): Record<string, string> {
    return {
        DISPLAY: display,
        XAUTHORITY: authorityFile,
        // A pane inherits the owner's session, so an empty Wayland name is what
        // keeps a headed browser off the owner's real desktop.
        WAYLAND_DISPLAY: '',
        XDG_SESSION_TYPE: 'x11',
        // agent-browser reads these itself: headed launch plus the args it forwards.
        AGENT_BROWSER_HEADED: '1',
        AGENT_BROWSER_ARGS,
    };
}

/**
 * Whether the installed engine's own usage lists the display keeper: its
 * `--help` output is the capability report. A later @desklink/host pin bump
 * can replace this probe with the package's startDisplayKeeper export.
 */
async function engineHasKeeperMode(command: string): Promise<boolean> {
    try {
        const usage = await new Promise<string>((resolve, reject) => {
            execFile(command, ['--help'], { encoding: 'utf8', timeout: MODE_PROBE_TIMEOUT_MS }, (error, stdout) => {
                if (error !== null) reject(error);
                else resolve(stdout);
            });
        });
        return /^\s*desklink-host\s+keep\s.*--display/m.test(usage);
    } catch {
        return false;
    }
}

export class PaneScreens {
    private readonly env: NodeJS.ProcessEnv;
    private readonly socketDirectory: string;
    private readonly stateDirectory: string;
    private readonly onDiagnostic: (line: string) => void;
    private readonly screens = new Map<string, LiveScreen>();
    /** Screens still starting, from the moment their server exists to registration. */
    private readonly pending = new Map<number, LiveScreen>();
    private readonly boundPaneByDisplay = new Map<string, string>();
    private readonly listeners = new Set<(paneId: string, windows: ScreenWindow[]) => void>();
    /** Undefined until the first keeper proves it works; false disables screens. */
    private keeperWorks: boolean | undefined;
    /** The engine's keeper command, decided once per host from its own reported modes. */
    private keeperProbe: Promise<{ command: string; args: string[] } | undefined> | undefined;

    constructor(options: PaneScreensOptions = {}) {
        this.env = options.env ?? process.env;
        this.socketDirectory = options.socketDirectory ?? '/tmp/.X11-unix';
        this.stateDirectory = options.stateDirectory ?? join(tmpdir(), `muxr-screens-${process.getuid?.() ?? 'user'}`);
        this.onDiagnostic = options.onDiagnostic ?? ((line) => process.stderr.write(`pane screen: ${line}\n`));
        process.once('exit', () => this.stop());
    }

    /**
     * A screen for a pane that is about to be created.
     *
     * Called before the Herdr create, because the env has to name the display;
     * `bind` then ties the screen to the pane id Herdr returns, and
     * `releaseScreen` hands it straight back when that create fails.
     */
    async allocate(): Promise<PaneScreen | undefined> {
        if (process.platform !== 'linux') return undefined;
        if (this.screens.size + this.pending.size >= MAX_PANE_SCREENS) {
            this.onDiagnostic(`all ${MAX_PANE_SCREENS} pane screens are in use; this pane has none`);
            return undefined;
        }
        const xvfb = onPath(XVFB, this.env);
        if (xvfb === undefined) return undefined;
        const keeper = await this.keeperCommand();
        if (keeper === undefined) return undefined;

        const number = firstFreeDisplayNumber(this.socketDirectory, FIRST_NUMBER, new Set([...this.numbers(), ...this.pending.keys()]));
        // A directory no other allocation has ever used: a pane left over from a
        // previous host run, whose env still names this display number, can
        // never resolve its stale cookie onto this screen.
        const authorityDirectory = join(this.stateDirectory, randomBytes(12).toString('hex'));
        let screen: LiveScreen;
        try {
            mkdirSync(authorityDirectory, { recursive: true, mode: 0o700 });
            const authorityFile = join(authorityDirectory, 'Xauthority');
            writeFileSync(authorityFile, authorityEntry(number, randomBytes(16)), { mode: 0o600 });
            const display = `:${number}`;
            const server = spawn(xvfb, [display, '-screen', '0', SCREEN_SIZE, '-nolisten', 'tcp', '-auth', authorityFile], { env: this.env, stdio: 'ignore' });
            screen = { display, number, authorityDirectory, env: screenEnv(display, authorityFile), server, keeperBuffer: '', windows: [] };
        } catch {
            rmSync(authorityDirectory, { recursive: true, force: true });
            this.onDiagnostic('a pane screen could not be prepared; this pane has none');
            return undefined;
        }
        this.pending.set(number, screen);
        try {
            await waitForDisplaySocket(this.socketDirectory, number, START_TIMEOUT_MS, () => screen.server.exitCode === null);
        } catch {
            this.discard(screen);
            this.onDiagnostic(`a pane screen on :${number} did not start`);
            return undefined;
        }

        const child = spawn(keeper.command, [...keeper.args, '--display', screen.display], {
            env: { ...this.env, DISPLAY: screen.display, XAUTHORITY: screen.env.XAUTHORITY, WAYLAND_DISPLAY: '' },
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        screen.keeper = child;
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => this.readKeeper(screen, chunk));
        child.once('exit', () => {
            // A keeper that stops later is a lost report, not a lost screen: the
            // agent keeps working on it. Never kill a display because of it.
            if (this.screens.has(screen.display)) this.onDiagnostic(`the keeper for :${number} stopped`);
        });
        if (this.keeperWorks !== true && !await this.keeperStays(child)) {
            this.keeperWorks = false;
            this.discard(screen);
            this.onDiagnostic('the pinned engine has no display keeper; agent panes keep today\'s behaviour');
            return undefined;
        }
        this.keeperWorks = true;
        this.screens.set(screen.display, screen);
        this.pending.delete(screen.number);
        return { display: screen.display, env: screen.env };
    }

    /** Tie an allocated screen to the pane Herdr created for it. */
    bind(screen: PaneScreen | undefined, paneId: string): void {
        if (screen === undefined) return;
        const live = this.screens.get(screen.display);
        if (live === undefined) return;
        live.paneId = paneId;
        live.boundAt = Date.now();
        this.boundPaneByDisplay.set(screen.display, paneId);
        // The keeper usually reports its first window during the probe, before
        // the pane id exists: the screen already knows, so say so now.
        if (live.windows.length > 0) this.publish(live);
    }

    /** Hand an allocated screen back because the pane it was for was never created. */
    releaseScreen(screen: PaneScreen | undefined): void {
        if (screen === undefined) return;
        const live = this.screens.get(screen.display);
        if (live !== undefined) this.discard(live);
    }

    /** The pane is gone: its screen goes with it. */
    release(paneId: string): void {
        for (const [display, bound] of this.boundPaneByDisplay) {
            if (bound !== paneId) continue;
            this.boundPaneByDisplay.delete(display);
            const live = this.screens.get(display);
            if (live !== undefined) this.discard(live);
            return;
        }
    }

    /**
     * Every screen whose pane is no longer in Herdr's tree.
     *
     * `treesSince` is when the tree the caller read was asked for: a screen
     * bound after that names a pane the tree cannot know about yet, so a
     * snapshot still in flight must not take it away.
     */
    releaseMissing(livePaneIds: ReadonlySet<string>, treesSince: number): void {
        for (const [display, paneId] of [...this.boundPaneByDisplay]) {
            if (livePaneIds.has(paneId)) continue;
            const live = this.screens.get(display);
            if (live?.boundAt !== undefined && live.boundAt >= treesSince) continue;
            this.release(paneId);
        }
    }

    /** The screen a pane runs on, for whoever later needs to watch it. */
    screenFor(paneId: string): PaneScreen | undefined {
        for (const live of this.screens.values()) {
            if (live.paneId === paneId) return { display: live.display, env: live.env };
        }
        return undefined;
    }

    /** The keeper's latest window list for a pane, empty when it has none. */
    windowsFor(paneId: string): ScreenWindow[] {
        for (const live of this.screens.values()) {
            if (live.paneId === paneId) return live.windows;
        }
        return [];
    }

    /** Every keeper report, as it changes. Returns the unsubscribe. */
    onWindows(listener: (paneId: string, windows: ScreenWindow[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Kill every screen, its keeper and its socket — registered or still starting. */
    stop(): void {
        for (const live of [...this.screens.values(), ...this.pending.values()]) this.discard(live);
        this.boundPaneByDisplay.clear();
    }

    private numbers(): number[] {
        return [...this.screens.values()].map((screen) => screen.number);
    }

    private async keeperCommand(): Promise<{ command: string; args: string[] } | undefined> {
        if (this.keeperWorks === false) return undefined;
        this.keeperProbe ??= this.probeKeeper();
        return this.keeperProbe;
    }

    /**
     * The engine binary the host runs. `DESKLINK_ENGINE` is the name
     * @desklink/host publishes; `MUXR_DESKLINK_ENGINE` is no longer read.
     * A stale old name fails loudly instead of silently picking another
     * engine: `false` means the configured path must not be used at all.
     */
    private enginePath(): string | undefined | false {
        const legacy = this.env.MUXR_DESKLINK_ENGINE;
        if (legacy !== undefined && legacy.trim() !== '') {
            this.onDiagnostic(
                'MUXR_DESKLINK_ENGINE is no longer read; set DESKLINK_ENGINE to the desktop engine binary instead.',
            );
            const configured = this.env.DESKLINK_ENGINE;
            if (configured === undefined || configured.trim() === '') return false;
        }
        return this.env.DESKLINK_ENGINE;
    }

    /** Asked once per host: the engine's own usage must list the keeper mode. */
    private async probeKeeper(): Promise<{ command: string; args: string[] } | undefined> {
        const configured = this.enginePath();
        if (configured === false) return undefined;
        const resolved = resolveEngine(configured);
        if (resolved !== null && await engineHasKeeperMode(resolved.command)) {
            return { command: resolved.command, args: [...resolved.args.filter((arg) => arg !== 'serve'), KEEPER_MODE] };
        }
        this.onDiagnostic('pane screens unavailable: installed desktop engine has no keeper');
        return undefined;
    }

    /** Resolves true once the keeper has outlived the probe. */
    private async keeperStays(child: ChildProcess): Promise<boolean> {
        await new Promise((resolve) => setTimeout(resolve, KEEPER_PROBE_MS));
        return child.exitCode === null && child.signalCode === null;
    }

    private readKeeper(screen: LiveScreen, chunk: string): void {
        screen.keeperBuffer += chunk;
        const lines = screen.keeperBuffer.split('\n');
        screen.keeperBuffer = lines.pop() ?? '';
        for (const line of lines) {
            if (line.trim() === '') continue;
            let windows: unknown;
            try {
                windows = (JSON.parse(line) as { windows?: unknown }).windows;
            } catch {
                continue;
            }
            if (!Array.isArray(windows)) continue;
            screen.windows = windows.filter((window): window is ScreenWindow => window !== null && typeof window === 'object');
            this.publish(screen);
        }
    }

    private publish(screen: LiveScreen): void {
        if (screen.paneId === undefined) return;
        for (const listener of this.listeners) listener(screen.paneId, screen.windows);
    }

    private discard(screen: LiveScreen): void {
        this.screens.delete(screen.display);
        this.boundPaneByDisplay.delete(screen.display);
        this.pending.delete(screen.number);
        screen.paneId = undefined;
        if (screen.keeper !== undefined && screen.keeper.exitCode === null) screen.keeper.kill('SIGTERM');
        if (screen.server.exitCode === null && screen.server.signalCode === null) screen.server.kill('SIGTERM');
        removeDisplayFiles(this.socketDirectory, screen.number);
        rmSync(screen.authorityDirectory, { recursive: true, force: true });
    }
}
