/* The window: draws the pairing offer the running host mints and the settings toggles. */
const cards = {
    starting: document.getElementById('card-starting'),
    ready: document.getElementById('card-ready'),
    approval: document.getElementById('card-approval'),
    paired: document.getElementById('card-paired'),
    error: document.getElementById('card-error'),
    note: document.getElementById('card-note'),
};
const dot = document.getElementById('status-dot');
const title = document.getElementById('status-title');
const canvas = document.getElementById('qr');
const ctx = canvas.getContext('2d');
const expiry = document.getElementById('expiry');
const copyButton = document.getElementById('copy-code');
const copyLabel = copyButton.querySelector('.copy-label');
const keepAwake = document.getElementById('keep-awake');
const autostart = document.getElementById('autostart');

let currentCode = '';
let expiresAt = 0;

const TITLES = {
    starting: 'Starting…',
    online: 'Ready to pair',
    approval: 'Waiting for approval',
    paired: 'Paired',
    error: 'Needs attention',
};

function show(which) {
    for (const [name, element] of Object.entries(cards)) element.hidden = name !== which;
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

window.muxr.onState((state) => {
    dot.className = `dot ${state.phase}`;
    title.textContent = TITLES[state.phase] ?? 'muxr';
    if (state.phase === 'starting') { show('starting'); }
    else if (state.phase === 'online') {
        if (state.qr !== undefined && state.code !== undefined) {
            currentCode = state.code;
            expiresAt = state.expires ?? 0;
            drawQr(state.qr);
            tickExpiry();
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
    }
});

window.muxr.onSettings((settings) => {
    keepAwake.checked = settings.keepAwake === true;
    autostart.checked = settings.autostart === true;
});

document.getElementById('approve').addEventListener('click', () => window.muxr.approve());
document.getElementById('deny').addEventListener('click', () => window.muxr.deny());
document.getElementById('retry').addEventListener('click', () => window.muxr.retry());
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
