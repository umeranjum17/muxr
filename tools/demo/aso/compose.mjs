#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const bg = path.join(here, 'codex/background.png');
const font = path.join(repo, 'apps/mobile/assets/fonts/BricolageGrotesque-Bold.ttf');
const mono = path.join(repo, 'apps/mobile/sources/assets/fonts/IBMPlexMono-Regular.ttf');

const shots = [
  ['01-herd.png', '01-agents.png', 'Every coding agent.\nOne pocket.', 2700],
  ['02-inbox.png', '02-alerts.png', 'Blocked?\nmuxr pings you.', 2150],
  ['03-approve.png', '03-approve.png', 'Approve work\nfrom anywhere.', 1140],
  ['04-diff.png', '04-diffs.png', 'See the diff.\nThen approve.', 1900],
  ['05-voice.png', '05-voice.png', 'Ask what changed\nwhile you’re out.', 2400],
  ['06-relay.png', '06-relay.png', 'Your relay.\nYour rules.', 2950],
];

const mockupDir = path.join(here, 'mockups');
await mkdir(mockupDir, { recursive: true });
const missing = [];
for (const [sourceName, , , frame] of shots) {
  try { await access(path.join(mockupDir, sourceName)); }
  catch { missing.push([sourceName, frame]); }
}
if (missing.length > 0) {
  await exec(process.execPath, [path.join(here, '../reel/render.mjs'), ...missing.map(([, frame]) => String(frame))], {
    cwd: path.resolve(here, '..'),
    env: { ...process.env, COMPOSITION: 'phone', RENDER_SCALE: '3' },
    maxBuffer: 10 * 1024 * 1024,
  });
  for (const [sourceName, frame] of missing) {
    await copyFile(
      path.join(here, '../review/stills', `f${String(frame).padStart(4, '0')}.png`),
      path.join(mockupDir, sourceName),
    );
  }
}

const targets = [
  { dir: path.join(repo, 'docs/play/store-assets/aso'), w: 1080, h: 1920, phoneW: 850, phoneY: 430, titleY: 120, titleSize: 82, radius: 52, frame: false },
  // Unframed UI avoids unofficial/mismatched Apple device imagery.
  { dir: path.join(repo, 'docs/app-store/screenshots'), w: 1320, h: 2868, phoneW: 1050, phoneY: 610, titleY: 210, titleSize: 108, radius: 78, frame: false },
  // muxr declares supportsTablet:true: this is a separate split-view tablet
  // composition, never a stretched iPhone screenshot.
  { dir: path.join(repo, 'docs/app-store/screenshots-ipad'), w: 2064, h: 2752, phoneW: 1000, phoneY: 610, titleY: 135, titleSize: 116, radius: 60, frame: false, tablet: true },
];

for (const target of targets) {
  await mkdir(target.dir, { recursive: true });
  for (const [sourceName, outputName, headline] of shots) {
    const source = path.join(here, 'mockups', sourceName);
    const output = path.join(target.dir, outputName);
    const phoneH = Math.round(target.phoneW * 2688 / 1209);
    const phoneX = target.tablet ? 870 : Math.round((target.w - target.phoneW) / 2);
    const titleW = target.w - 120;
    const titleH = target.phoneY - target.titleY - 30;
    const framePad = target.frame ? 12 : 0;

    const args = [bg,
      '-resize', `${target.w}x${target.h}^`, '-gravity', 'center', '-extent', `${target.w}x${target.h}`,
    ];

    if (target.tablet) {
      args.push(
        '-gravity', 'northwest', '-fill', '#050506', '-stroke', '#343438', '-strokewidth', '3',
        '-draw', 'roundrectangle 90,560 1974,2750 72,72',
        '-fill', '#111113', '-stroke', 'none', '-draw', 'roundrectangle 91,561 650,2749 70,70',
        '-fill', '#2e2e2e', '-draw', 'rectangle 648,561 650,2750',
        '-fill', '#242427', '-draw', 'roundrectangle 125,750 615,850 24,24',
        '-font', font, '-fill', '#ececec', '-pointsize', '48', '-annotate', '+155+680', 'muxr',
        '-font', font, '-pointsize', '38', '-fill', '#ececec', '-annotate', '+155+815', 'Herd',
        '-fill', '#9a9a9f', '-annotate', '+155+910', 'Inbox', '-annotate', '+155+1005', 'Changes',
        '-annotate', '+155+1100', 'Files', '-annotate', '+155+1195', 'Usage', '-annotate', '+155+1290', 'Settings',
        '-font', mono, '-pointsize', '25', '-fill', '#5a5a5f', '-annotate', '+155+1450', 'LIVE SESSIONS',
        '-fill', '#ececec', '-pointsize', '29', '-annotate', '+155+1540', 'auth-fix',
        '-fill', '#9a9a9f', '-annotate', '+155+1600', 'billing-refactor', '-annotate', '+155+1660', 'landing-copy',
      );
    }

    if (target.frame) {
      args.push('(', '-size', `${target.phoneW + framePad * 2}x${phoneH + framePad * 2}`, 'xc:none',
        '-fill', '#09090a', '-stroke', '#3a3a3e', '-strokewidth', '3',
        '-draw', `roundrectangle 1,1 ${target.phoneW + framePad * 2 - 2},${phoneH + framePad * 2 - 2} ${target.radius + framePad},${target.radius + framePad}`,
      ')', '-gravity', 'northwest', '-geometry', `+${phoneX - framePad}+${target.phoneY - framePad}`, '-composite');
    }

    args.push(
      '(', source, '-resize', `${target.phoneW}x${phoneH}!`, '-alpha', 'set',
        '(', '+clone', '-alpha', 'transparent', '-fill', 'white', '-draw', `roundrectangle 0,0 ${target.phoneW - 1},${phoneH - 1} ${target.radius},${target.radius}`,
        ')', '-compose', 'DstIn', '-composite',
      ')',
      '-gravity', 'northwest', '-geometry', `+${phoneX}+${target.phoneY}`, '-compose', 'over', '-composite',
      '(', '-background', 'none', '-fill', '#f4f4f5', '-stroke', 'none', '-font', font, '-pointsize', String(target.titleSize),
        '-size', `${titleW}x${titleH}`, '-gravity', 'northwest', `caption:${headline}`,
      ')', '-gravity', 'northwest', '-geometry', `+60+${target.titleY}`, '-composite',
      '-font', mono, '-pointsize', String(Math.round(target.titleSize * 0.24)), '-fill', '#9a9a9f',
      '-gravity', 'northwest', '-annotate', `+60+${target.titleY - Math.round(target.titleSize * 0.55)}`, 'muxr',
      '-fill', '#30D158', '-draw', `circle ${60 + Math.round(target.titleSize * 0.82)},${target.titleY - Math.round(target.titleSize * 0.62)} ${60 + Math.round(target.titleSize * 0.88)},${target.titleY - Math.round(target.titleSize * 0.62)}`,
      '-alpha', 'off', '-colorspace', 'sRGB', '-strip', `PNG24:${output}`);

    await exec('magick', args, { maxBuffer: 10 * 1024 * 1024 });
    console.log(path.relative(repo, output));
  }
}
