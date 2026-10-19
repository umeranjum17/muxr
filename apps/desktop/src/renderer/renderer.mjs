/* The window: draws the pairing offer the running host mints and the settings toggles. */
const cards = {
    starting: document.getElementById('card-starting'),
    project: document.getElementById('card-project'),
    ready: document.getElementById('card-ready'),
    approval: document.getElementById('card-approval'),
    paired: document.getElementById('card-paired'),
    error: document.getElementById('card-error'),
    'already-running': document.getElementById('card-already-running'),
    note: document.getElementById('card-note'),
};
const herdrNotice = document.getElementById('herdr-notice');
const dot = document.getElementById('status-dot');
const title = document.getElementById('status-title');
const canvas = document.getElementById('qr');
const ctx = canvas.getContext('2d');
const qrWrap = document.getElementById('qr-wrap');
const readyHint = document.getElementById('ready-hint');
const expiry = document.getElementById('expiry');
const routeHint = document.getElementById('route-hint');
const copyButton = document.getElementById('copy-code');
const copyLabel = copyButton.querySelector('.copy-label');
const keepAwake = document.getElementById('keep-awake');
const autostart = document.getElementById('autostart');
const projectInput = document.getElementById('project-folder');
const projectNoRepo = document.getElementById('project-no-repo');
const projectError = document.getElementById('project-error');
const saveProjectButton = document.getElementById('save-project-folder');
let projectShown = false;

let currentCode = '';
let expiresAt = 0;

const TITLES = {
    starting: 'Starting…',
    online: 'Ready to pair',
    approval: 'Waiting for approval',
    paired: 'Paired',
    error: 'Needs attention',
    'already-running': 'Already running',
};

function show(which) {
    for (const [name, element] of Object.entries(cards)) if (name !== 'project') element.hidden = name !== which;
}

function drawQr(matrix) {
    const modules = matrix.length;
    const scale = Math.max(2, Math.floor(240 / modules));
    canvas.width = modules * scale;
    canvas.height = modules * scale;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < modules; y++) {
        for (let x = 0; x < modules; x++) {
            if (matrix[y][x]) ctx.fillRect(x * scale, y * scale, scale, scale);
        }
    }
}

function tickExpiry() {
    if (expiresAt === 0) { expiry.textContent = ''; return; }
    const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    expiry.textContent = seconds > 0
        ? `This code is fresh; it refreshes automatically. Expires in ${seconds}s.`
        : 'Refreshing the code…';
}

setInterval(tickExpiry, 1000);

const HERDR_MISSING_MESSAGE = "muxr runs your agents in Herdr, which isn't installed on this computer.";

// Herdr is said above the card, and pairing never waits for it. An approval or an
// error still speaks for itself, so the notice shows only where the pairing offer,
// the paired state or the already-running card is on screen.
function showHerdrNotice(herdr) {
    herdrNotice.hidden = herdr === undefined;
    if (herdr === undefined) return;
    const installing = herdr.status === 'installing';
    document.getElementById('herdr-spinner').hidden = !installing;
    const message = document.getElementById('herdr-message');
    message.className = herdr.status === 'failed' ? 'error' : 'muted';
    message.textContent = installing ? herdr.step : herdr.status === 'failed' ? herdr.message : HERDR_MISSING_MESSAGE;
    const button = document.getElementById('install-herdr');
    button.hidden = installing;
    button.textContent = herdr.status === 'failed' ? 'Try again' : 'Install Herdr';
}

window.muxr.onState((state) => {
    const herdr = state.herdr !== undefined && state.herdr.status !== 'ok' && ['starting', 'online', 'paired', 'already-running'].includes(state.phase) ? state.herdr : undefined;
    showHerdrNotice(herdr);
    dot.className = `dot ${herdr === undefined ? state.phase : herdr.status === 'installing' ? 'starting' : 'error'}`;
    title.textContent = herdr === undefined ? (TITLES[state.phase] ?? 'muxr') : herdr.status === 'installing' ? 'Setting up Herdr…' : 'Needs attention';
    // Setup's one folder question sits beside the pairing offer until it is saved.
    const askProject = state.needsProjectFolder === true;
    cards.project.hidden = !askProject;
    if (askProject) {
        if (!projectShown) {
            if (typeof state.projectFolderSuggestion === 'string') projectInput.value = state.projectFolderSuggestion;
            projectError.hidden = true;
        }
        projectNoRepo.hidden = state.projectFolderNoRepo !== true;
    }
    projectShown = askProject;
    if (state.phase === 'starting') { show('starting'); }
    else if (state.phase === 'online') {
        if (state.code !== undefined) {
            currentCode = state.code;
            expiresAt = state.expires ?? 0;
            if (state.qr !== undefined) {
                qrWrap.hidden = false;
                drawQr(state.qr);
                readyHint.textContent = 'On your phone, open muxr and add this computer. Scan the code below.';
            } else {
                qrWrap.hidden = true;
                readyHint.textContent = 'On your phone, open muxr and add this computer, then enter the pairing code below.';
            }
            tickExpiry();
            routeHint.hidden = state.routeHint === undefined;
            routeHint.textContent = state.routeHint === undefined ? '' : `Your phone reaches this computer only on this Wi-Fi. ${state.routeHint}`;
            show('ready');
        } else {
            document.getElementById('note-message').textContent = state.message ?? 'Preparing the pairing code…';
            show('note');
        }
    } else if (state.phase === 'approval') {
        document.getElementById('approval-name').textContent = state.deviceName ?? 'this phone';
        document.getElementById('words').textContent = state.words ?? '';
        show('approval');
    } else if (state.phase === 'paired') {
        document.getElementById('paired-name').textContent = state.deviceName ?? 'your phone';
        show('paired');
    } else if (state.phase === 'error') {
        document.getElementById('error-message').textContent = state.message ?? 'muxr could not start.';
        show('error');
    } else if (state.phase === 'already-running') {
        document.getElementById('already-running-message').textContent = state.message ?? 'muxr is already running on this computer from the command-line install.';
        document.getElementById('already-running-retry').hidden = state.canRetry !== true;
        show('already-running');
    }
});

window.muxr.onSettings((settings) => {
    keepAwake.checked = settings.keepAwake === true;
    autostart.checked = settings.autostart === true;
});

document.getElementById('approve').addEventListener('click', () => window.muxr.approve());
async function saveProjectFolder() {
    saveProjectButton.disabled = true;
    projectError.hidden = true;
    try {
        await window.muxr.setProjectFolder(projectInput.value);
    } catch (error) {
        projectError.textContent = error instanceof Error ? error.message : String(error);
        projectError.hidden = false;
    } finally {
        saveProjectButton.disabled = false;
    }
}
document.getElementById('save-project-folder').addEventListener('click', () => void saveProjectFolder());
projectInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') void saveProjectFolder(); });
document.getElementById('deny').addEventListener('click', () => window.muxr.deny());
document.getElementById('retry').addEventListener('click', () => window.muxr.retry());
document.getElementById('install-herdr').addEventListener('click', () => window.muxr.installHerdr());
document.getElementById('already-running-retry').addEventListener('click', () => window.muxr.retry());
document.getElementById('quit').addEventListener('click', () => window.muxr.quit());
keepAwake.addEventListener('change', () => window.muxr.setKeepAwake(keepAwake.checked));
autostart.addEventListener('change', () => window.muxr.setAutostart(autostart.checked));

copyButton.addEventListener('click', async () => {
    if (currentCode === '') return;
    await window.muxr.copyCode(currentCode);
    copyLabel.textContent = 'Copied';
    setTimeout(() => { copyLabel.textContent = 'Copy pairing code'; }, 1600);
});

window.muxr.getSettings().then((settings) => {
    keepAwake.checked = settings.keepAwake === true;
    autostart.checked = settings.autostart === true;
});
