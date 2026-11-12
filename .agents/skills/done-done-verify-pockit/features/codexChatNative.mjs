// A release APK on a task-owned emulator paired to the same real-Codex lab as the PWA.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAvd } from '../../../../perf/lib/androidEmulator.mjs';
import { approveLabOffer } from '../../../../scripts/diagnostics/application/linkLabClient.mjs';
const out = process.env.DONE_DONE_EVIDENCE_ROOT;
const phase = process.env.CODEX_CHAT_PHASE ?? 'after';
const root = process.env.MUXR_CODEX_LAB_ROOT;
const avdHome = process.env.MUXR_LAB_AVD_HOME;
const apk = process.env.MUXR_LAB_APK;
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk || !process.env.MUXR_MEMORY_GATE) throw Error('ANDROID_HOME and MUXR_MEMORY_GATE are required');
const port = Number(process.env.MUXR_CODEX_EMULATOR_PORT ?? 5588);
const serial = `emulator-${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], {encoding:'utf8',timeout:120_000});
const sh = cmd => adb('shell', cmd);
// adb refuses while the emulator is still coming up; that is the only failure a boot poll may treat as "not yet".
const booted = () => { try { return sh('getprop sys.boot_completed').trim()==='1' && sh('pm path android').includes('package:'); } catch (e) { if(typeof e.status!=='number') throw e; return false; } };
const dump = () => { sh('uiautomator dump /sdcard/codex-chat.xml >/dev/null'); return adb('exec-out','cat','/sdcard/codex-chat.xml'); };
async function tap(pattern) {
    for (let i=0;i<15;i++) {
        const node=(dump().match(/<node\b[^>]*>/g)??[]).find(n=>pattern.test(n));
        if (node) { const b=/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node).slice(1).map(Number); sh(`input tap ${(b[0]+b[2])/2|0} ${(b[1]+b[3])/2|0}`); return; }
        await sleep(1000);
    }
    throw Error(`control missing: ${pattern}`);
}
await ensureAvd({name:'codex-visibility',avdHome});
const emulator = spawn(process.env.MUXR_MEMORY_GATE,[join(sdk,'emulator/emulator'),'-avd','codex-visibility','-port',String(port),'-no-window','-gpu','swiftshader_indirect','-memory','2048','-cores','2','-no-audio','-no-boot-anim','-no-snapshot-save'],{env:{...process.env,ANDROID_AVD_HOME:avdHome},stdio:['ignore','pipe','pipe']});
let ownsEmulator=false;
let emulatorLog=''; emulator.stdout.on('data',b=>emulatorLog+=b); emulator.stderr.on('data',b=>emulatorLog+=b);
try {
    for(let i=0;;i++) {
        if(emulator.exitCode!==null) throw Error(`emulator exited: ${emulatorLog}`);
        if(booted()) { if(!adb('emu','avd','name').startsWith('codex-visibility')) throw Error('emulator identity mismatch'); ownsEmulator=true; break; }
        if(i===180) throw Error('emulator boot timeout');
        await sleep(2000);
    }
    const aapt=execFileSync('bash',['-c',`ls -1 ${sdk}/build-tools/*/aapt | tail -1`],{encoding:'utf8'}).trim();
    const pkg=/package: name='([^']+)'/.exec(execFileSync(aapt,['dump','badging',apk],{encoding:'utf8'}))[1];
    adb('install','-r',apk); sh(`pm clear ${pkg}`);
    const labPort=JSON.parse(readFileSync(join(root,'muxr/selfhost.json'))).relayPort;
    adb('reverse',`tcp:${labPort}`,`tcp:${labPort}`);
    await approveLabOffer(join(root,'host/pair.sock'),async offer=>{
        adb('shell','am','start','-n',`${pkg}/.MainActivity`,'-a','android.intent.action.VIEW','-d',`muxr://pair#${offer}`);
        await sleep(4000); await tap(/(?:text|content-desc)="Pair"/);
    });
    await sleep(3000);
    await tap(/(?:text|content-desc)="Open Check shipping output,/);
    await sleep(3000);
    for(const [name,density,font] of [['390',443,1],['270',640,1],['270-large',640,2]]) for(const theme of phase==='before'?['dark']:['dark','light']) {
        sh('wm size 1080x2376'); sh(`wm density ${density}`); sh(`settings put system font_scale ${font}`); sh(`cmd uimode night ${theme==='dark'?'yes':'no'}`);
        sh(`am force-stop ${pkg}`); sh(`am start -n ${pkg}/.MainActivity`); await sleep(4000);
        if(phase==='after') await tap(/content-desc="Chat view"/);
        await sleep(2000);
        writeFileSync(join(out,`${phase}-native-codex-${name}-${theme}.png`),execFileSync('adb',['-s',serial,'exec-out','screencap','-p']));
        writeFileSync(join(out,`${phase}-native-codex-${name}-${theme}.xml`),dump());
    }
    await tap(/content-desc="Terminal view"/); await sleep(2000);
    writeFileSync(join(out,`${phase}-native-codex-terminal.png`),execFileSync('adb',['-s',serial,'exec-out','screencap','-p']));
    writeFileSync(join(out,'steps.json'),JSON.stringify({target:{version:JSON.parse(readFileSync('package.json')).version},start:'Fresh emulator, release APK and private real-Codex host',steps:['Install and clear the owned emulator app','Pair to the private host','Open Check shipping output','Read at 390/270 dp and largest text','Switch to Terminal'],result:phase==='before'?'Terminal-only Codex conversation':'Markdown chat with folded tool output and a raw terminal fallback'}));
} finally {
    if(ownsEmulator) { try{adb('emu','kill');}catch{emulator.kill('SIGTERM');} } else emulator.kill('SIGTERM');
    await new Promise(resolve=>emulator.exitCode!==null?resolve():emulator.once('exit',resolve));
    writeFileSync(join(out,'emulator.log'),emulatorLog);
}
