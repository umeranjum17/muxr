/**
 * What the desktop engine crate needs from the machine before `cargo test` can
 * mean anything.
 *
 * The crate links libpipewire, xkbcommon and libwayland through pkg-config,
 * compiles `native/vpx_shim.c` against libvpx's headers, and builds the vendored
 * inputtino C project with cmake (linking libevdev). None of that is provisioned
 * by this repository, so the suite has to name the piece that is missing
 * instead of failing as though the engine's own code were broken.
 */
import { spawnSync } from 'node:child_process';

export const DESKTOP_ENGINE_PREREQUISITES = [
    {
        name: 'cargo',
        command: ['cargo', ['--version']],
        install: 'install Rust from https://rustup.rs, or your distribution\'s cargo package',
    },
    {
        name: 'cmake',
        command: ['cmake', ['--version']],
        install: 'apt-get install cmake · dnf install cmake · pacman -S cmake',
    },
    {
        name: 'cc',
        command: ['cc', ['--version']],
        install: 'apt-get install build-essential · dnf install gcc gcc-c++ · pacman -S base-devel',
    },
    {
        name: 'pkg-config',
        command: ['pkg-config', ['--version']],
        install: 'apt-get install pkg-config · dnf install pkgconf-pkg-config · pacman -S pkgconf',
    },
    {
        name: 'libvpx (vpx.pc)',
        command: ['pkg-config', ['--exists', 'vpx']],
        install: 'apt-get install libvpx-dev · dnf install libvpx-devel · pacman -S libvpx',
    },
    {
        name: 'libpipewire-0.3',
        command: ['pkg-config', ['--exists', 'libpipewire-0.3']],
        install: 'apt-get install libpipewire-0.3-dev · dnf install pipewire-devel · pacman -S pipewire',
    },
    {
        name: 'xkbcommon',
        command: ['pkg-config', ['--exists', 'xkbcommon']],
        install: 'apt-get install libxkbcommon-dev · dnf install libxkbcommon-devel · pacman -S libxkbcommon',
    },
    {
        name: 'wayland-client',
        command: ['pkg-config', ['--exists', 'wayland-client']],
        install: 'apt-get install libwayland-dev · dnf install wayland-devel · pacman -S wayland',
    },
    {
        name: 'libevdev',
        command: ['pkg-config', ['--exists', 'libevdev']],
        install: 'apt-get install libevdev-dev · dnf install libevdev-devel · pacman -S libevdev',
    },
];

function defaultRun(command, args) {
    return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

/** Every prerequisite this machine does not satisfy, in declaration order. */
export function missingDesktopEnginePrerequisites(run = defaultRun) {
    return DESKTOP_ENGINE_PREREQUISITES.filter((prerequisite) => !run(...prerequisite.command));
}

/**
 * A skip line that cannot be read as a pass: it names each missing prerequisite,
 * says how to install it, and states plainly that the engine was not tested.
 */
export function desktopEngineSkipMessage(missing) {
    const lines = [`SKIP  desktop engine tests  (missing: ${missing.map((item) => item.name).join(', ')})`];
    for (const item of missing) lines.push(`      ${item.name}: ${item.install}`);
    lines.push('      Nothing was compiled or tested — this is a skip, not a pass.');
    return `${lines.join('\n')}\n`;
}

/** Decide whether the cargo gate runs, and if not, the line to print. */
export function desktopEnginePlan(run = defaultRun) {
    const missing = missingDesktopEnginePrerequisites(run);
    return missing.length === 0 ? { run: true } : { run: false, message: desktopEngineSkipMessage(missing) };
}
