// Real Boat lifecycle from Settings: create one, list/status, stable reconnect order,
// switch both ways, terminal command + independent readback, forget, provider delete.
// No desktop input; no real credential enters the app or evidence.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { boat } from '@byokit/cloud';
import { dismissPrompts, dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';
import { setAndroidSerial } from '../../../../perf/lib/deviceTarget.mjs';
import { linkHerdrLab } from '../../../../scripts/diagnostics/application/linkHerdrLab.mjs';
import { parseOffer } from '@byokit/pair';
import { sha256, sourceIdentity } from '../../../../perf/lib/provenance.mjs';

// Run only after explicit spend approval, under the phone keeper lock and a
// provisioned non-default Herdr lab. The upstream proxy alone reads the key.
const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, port: { type: 'string' },
    upstream: { type: 'string' }, 'key-file': { type: 'string' },
} });
for (const key of ['apk', 'evidence', 'port', 'upstream', 'key-file']) {
    if (!opts[key]) throw new Error(`--${key} is required`);
}
if (!process.env.MX_LIVE_ROOT || !process.env.HERDR_LAB_HELPER ||
    !process.env.HERDR_LAB_SESSION || process.env.HERDR_LAB_PREPROVISIONED !== '1') {
    throw new Error('A private MX_LIVE_ROOT and provisioned Herdr lab are required');
}
const PKG = 'com.trymuxr.app';
const EVIDENCE = resolve(opts.evidence);
mkdirSync(EVIDENCE, { recursive: true });
if (opts.apk) {
    const source = sourceIdentity();
    const build = JSON.parse(readFileSync(`${opts.apk}.json`, 'utf8'));
    const wrongSource = source.dirty || build.revision !== source.revision || build.mobileSha256 !== source.mobileSha256;
    if (wrongSource || build.dirty || build.apkSha256 !== sha256(opts.apk)) {
        throw new Error('Cloud proof requires a clean candidate and its matching release APK');
    }
    writeFileSync(join(EVIDENCE, 'apk-source.json'), JSON.stringify({ source, build }, null, 2));
}
const exec = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => { const out = `${new Date().toISOString()} ${line}`; console.log(out); appendFileSync(join(EVIDENCE, 'journey.log'), `${out}\n`); };
let serial = '';
const adb = async (args, timeout = 60_000) => (await exec('adb', ['-s', serial, ...args], { timeout, maxBuffer: 64 << 20 })).stdout;
const sh = (cmd) => adb(['shell', cmd]);
const shot = async (name) => {
    writeFileSync(join(EVIDENCE, `${name}.png`), (await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 << 20, timeout: 30_000 })).stdout);
    say(`shot ${name}.png`);
};

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
async function screen() {
    const xml = await dumpUiXml(30_000).catch(() => '');
    return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
        const get = (key) => unescape(tag.match(new RegExp(` ${key}="([^"]*)"`))?.[1] ?? '');
        const box = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)?.slice(1).map(Number) ?? [0, 0, 0, 0];
        return { klass: get('class'), text: get('text'), desc: get('content-desc'), pkg: get('package'), box };
    });
}
const find = (found, test) => found.find((n) => test(n.text) || test(n.desc));
// A loaded host can make the emulator's own System UI stop answering; that dialog is Android's, not muxr's: wait it out.
async function answerAnr(found) {
    const wait = find(found, (v) => v === 'Wait');
    if (!wait || !find(found, (v) => /isn.t responding/.test(v))) return false;
    say('Android showed a not-responding dialog; tapping Wait');
    await sh(`input tap ${Math.round((wait.box[0] + wait.box[2]) / 2)} ${Math.round((wait.box[1] + wait.box[3]) / 2)}`);
    await sleep(1500);
    return true;
}
async function waitFor(what, test, seconds = 90) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        const found = await screen();
        if (test(found)) return found;
        await answerAnr(found);
        await sleep(1500);
    }
    await shot(`missing-${what.replace(/\W+/g, '-')}`).catch(() => undefined);
    throw new Error(`${what} never appeared within ${seconds}s`);
}
async function tap(what, test, seconds = 90) {
    const [l, t, r, b] = find(await waitFor(what, (found) => find(found, test) !== undefined, seconds), test).box;
    say(`tap ${what}`);
    await sh(`input tap ${Math.round((l + r) / 2)} ${Math.round((t + b) / 2)}`);
    await sleep(1500);
}
let activity = '';
const bringMuxrBack = async () => { await sh(`am start -n ${activity}`); await sleep(2000); };

const account = boat({baseUrl:`http://127.0.0.1:${opts.port}/api/v1`, label:'Boat',prices:[],key:async()=>'boat-claimed-key'});
const createdFile=join(EVIDENCE,'boat-created.json');
let lab, desk, originalPhoneSettings;
let created=0, cloudName='', failure;
const reversePorts=new Set([String(opts.port)]);
const go=async(route)=>{await sh(`am start -W -a android.intent.action.VIEW -d 'muxr://${route}' -n ${activity}`);await sleep(2500);};
const view=async(dp,font,theme)=>{
 await sh(`wm density ${Math.round(1080*160/Number(dp))}`);
 await sh(`settings put system font_scale ${font}`);
 await sh(`cmd uimode night ${theme==='dark'?'yes':'no'}`);
 say(`view: ${dp} dp, font ${font}, ${theme}`);
};
async function cells(prefix){
 for(const [dp,font] of [[360,'1.0'],[390,'1.0'],[393,'2.0']]){
  for(const theme of ['light','dark']){
   // The bound action/list still captures 390/light once; do not photograph it twice.
   if (dp === 390 && font === '1.0' && theme === 'light') continue;
   await view(dp,font,theme); await sh(`am force-stop ${PKG}`);await go('settings');
   await waitFor('Settings Machines',ns=>find(ns,v=>v==='Add a cloud machine'),60);
   await shot(`${prefix}-${dp}-${font}-${theme}`);
  }
 }
 await view(390,'1.0','light');await sh(`am force-stop ${PKG}`);await go('settings');
}
try{
 lab=spawn(process.execPath,['.agents/skills/done-done-verify-pockit/features/boatSignInLab.mjs',opts.port],{env:{...process.env,BOAT_LAB_UPSTREAM:opts.upstream,BOAT_LAB_KEY_FILE:resolve(opts['key-file']),BOAT_LAB_CREATED_FILE:createdFile},stdio:['ignore','pipe','pipe']});
 let labOut='';lab.stdout.on('data',x=>{labOut+=x;appendFileSync(join(EVIDENCE,'boat-lab.log'),x);});lab.stderr.on('data',x=>appendFileSync(join(EVIDENCE,'boat-lab.log'),x));
 say(`credential proxy pid ${lab.pid}; real key read only in upstream request step, never delivered to app`);
 for(let i=0;!labOut.includes('boat lab listening');i++){if(lab.exitCode!==null||i>150)throw Error('credential proxy did not become ready');await sleep(200);}
 serial='a4b93ea2';setAndroidSerial(serial);
 if((await adb(['get-state'])).trim()!=='device')throw Error('keeper-owned test phone unavailable');
 originalPhoneSettings={density:(await sh('wm density')).trim(),font:(await sh('settings get system font_scale')).trim(),night:(await sh('cmd uimode night')).trim(),touches:(await sh('settings get system show_touches')).trim()};
 writeFileSync(join(EVIDENCE,'phone-settings-before.json'),JSON.stringify(originalPhoneSettings));
 await view(390,'1.0','light');
 await adb(['reverse',`tcp:${opts.port}`,`tcp:${opts.port}`]);
 // Reinstall alone can restore saved app data; reset grants, updates and onboarding explicitly.
 await adb(['uninstall',PKG],120000).catch(()=>{});
 await adb(['install',opts.apk],300000);
 const reset=await sh(`pm clear ${PKG}`);
 if(reset.trim()!=='Success')throw Error('Fresh-state setup failed: muxr app data was not cleared');
 say('fresh-state setup: installed task APK and cleared muxr app data');
 await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(()=>{});
 activity=(await sh(`cmd package resolve-activity --brief ${PKG}`)).trim().split('\n').pop();
 await bringMuxrBack();await dismissPrompts().catch(()=>{});
 await waitFor('fresh muxr Connect a machine',ns=>ns.some(n=>n.pkg===PKG)&&find(ns,v=>v==='Connect a machine'),180);
 say('fresh-state setup ready: muxr first-run Connect a machine is visible; starting the user flow');
 process.env.MUXR_LAB_MACHINE_NAME='Desk';
 desk=await linkHerdrLab(resolve(process.env.MX_LIVE_ROOT),'mx-cloud-machine-add1',undefined,undefined,{},async offer=>{
  for(const port of new Set(parseOffer(offer,0).urls.map(u=>new URL(u).port).filter(Boolean))){
   if(['8790','8791','8792','8793','8443'].includes(port))throw Error('forbidden relay port');
   await adb(['reverse',`tcp:${port}`,`tcp:${port}`]);reversePorts.add(port);
  }
  await go(`pair#${offer}`);await tap('Pair Desk',v=>v==='Pair');
 });
 say(`Desk host/relay pids ${desk.pids().join(', ')}`);
 writeFileSync(join(EVIDENCE,'owned-pids.json'),JSON.stringify({proxy:lab.pid,desk:desk.pids()}));
 await waitFor('Desk connected',ns=>find(ns,v=>v==='Desk')&&find(ns,v=>v==='connected'),180);
 await cells('machines');
 await shot('live-05-settings-action');
 const cloudRow=find(await screen(),v=>v==='Add a cloud machine');if(!cloudRow)throw Error('Settings cloud row missing');
 const cx=Math.round((cloudRow.box[0]+cloudRow.box[2])/2),cy=Math.round((cloudRow.box[1]+cloudRow.box[3])/2);
 await sh('settings put system show_touches 1');
 const touchAt=new Date().toISOString();say('one stationary native touch on Add a cloud machine; no intermediate screen');
 const touch=spawn('adb',['-s',serial,'shell','input','swipe',String(cx),String(cy),String(cx),String(cy),'450'],{stdio:'ignore'});
 const touchDone=new Promise((resolve,reject)=>{touch.once('error',reject);touch.once('exit',code=>code===0?resolve():reject(Error('native touch exit '+code)));});
 await sleep(120);await shot('live-05-native-touch');await touchDone;await sleep(1500);
 writeFileSync(join(EVIDENCE,'native-linkage.json'),JSON.stringify({at:touchAt,action:'one stationary touchscreen press and release',x:cx,y:cy,durationMs:450,intermediateScreens:0,disclosure:'A still frame cannot show a touch transition; tap linkage is proven by the driven journey and disclosed, not photographed.'},null,2));
 const emailNodes=await waitFor('Boat email EditText',ns=>ns.some(n=>n.klass==='android.widget.EditText'&&(n.desc==='Boat account email'||n.text==='Email address')),60);
 const emailEdit=emailNodes.find(n=>n.klass==='android.widget.EditText'&&(n.desc==='Boat account email'||n.text==='Email address'));
 await shot('live-06-boat-entry');await sh(`settings put system show_touches ${originalPhoneSettings.touches}`);
 say('tap actual Boat email EditText (not static label)');
 await sh(`input tap ${Math.round((emailEdit.box[0]+emailEdit.box[2])/2)} ${Math.round((emailEdit.box[1]+emailEdit.box[3])/2)}`);await sleep(1500);
 for(const chunk of 'umer@example.com'.match(/.{1,4}/g)){await sh(`input text '${chunk}'`);await sleep(300);}
 if(!find(await screen(),v=>v==='umer@example.com'))throw Error('email field did not hold full synthetic claim address');
 await sh('input keyevent KEYCODE_ESCAPE');
 await tap('Connect Boat account',v=>v==='Connect Boat account');
 await tap('Sign in to Boat',v=>v==='Sign in to Boat');
 await sleep(4000);await bringMuxrBack();
 await waitFor('Pick a size',ns=>find(ns,v=>v==='Pick a size'),90);
 await shot('01-size-and-price');
 const pricing=await screen();writeFileSync(join(EVIDENCE,'pricing-ui.json'),JSON.stringify(pricing,null,2));
 if(!find(pricing,v=>v.includes('$0.036 an hour while on')))throw Error('expected small size price not visible; no spend permitted');
 const before=(await account.list()).map(r=>r.id);
 writeFileSync(join(EVIDENCE,'before-machine-ids.json'),JSON.stringify(before));
 created=Date.now();
 await tap('Create cloud machine',v=>v==='Create cloud machine');
 say('single authorized creation submitted; no retry or plan change');
 const deadline=created+600000;
 let connected=false, flowCaptured=false;
 while(Date.now()<deadline){
  const ns=await screen();
  if(!flowCaptured&&find(ns,v=>v==='Installing muxr on your cloud machine.'||v==='Setting up muxr on your cloud machine.'||v==='Connecting this phone to your cloud machine over a private SSH link.')){
   await shot('live-06-boat-create-flow');flowCaptured=true;
  }
  if(find(ns,v=>v==='Try again'))throw Error('cloud setup failed: '+ns.filter(n=>n.text).map(n=>n.text).join(' | '));
  if(find(ns,v=>v==='connected')&&!find(ns,v=>v==='Create and pair')){connected=true;break;}
  await sleep(1500);
 }
 if(!connected)throw Error('cloud did not connect within 10 minutes');
 const ownedReady=new Set(JSON.parse(readFileSync(createdFile,'utf8')));
 const realRef=(await account.list()).find(r=>ownedReady.has(r.id));
 if(!realRef)throw Error('owned cloud machine missing before readiness check');
 const readiness=[];
 for(;;){
  const state=await account.status(realRef);readiness.push({at:new Date().toISOString(),machineId:realRef.id,state});
  if(state==='on')break;
  if(['failed','gone','host-key-changed'].includes(state)||Date.now()>created+600000)throw Error('owned cloud machine not ready: '+state);
  await sleep(1500);
 }
 writeFileSync(join(EVIDENCE,'live-provider-readiness.json'),JSON.stringify(readiness,null,2));
 await go('settings');
 const ns=await screen(), cloudForget=ns.find(n=>n.desc.startsWith('Forget ')&&n.desc!=='Forget Desk');
 if(!cloudForget)throw Error('cloud row missing beside Desk');
 cloudName=cloudForget.desc.slice(7);say(`cloud displayed name: ${cloudName}`);
 await shot('live-07-cloud-listed');await cells('machines-cloud-listed');
 // One reconnect on the same real machine; record persisted and live row order,
 // without a provider restart or a second create.
 await sh(`am force-stop ${PKG}`);
 await sh(`am start -W -a android.intent.action.VIEW -d 'muxr://settings' -n ${activity}`);
 const firstRows=await waitFor('saved machine rows after restart',ns=>find(ns,v=>v==='Desk')&&find(ns,v=>v===cloudName),120);
 const rowData=nodes=>['Desk',cloudName].map(name=>({name,...find(nodes,v=>v===name)}));
 // Reconnect evidence is row geometry, not redundant captures of the same static screen.
 const onlineRows=await waitFor('real cloud online after reconnect',ns=>ns.some(n=>n.desc.includes(cloudName)&&n.desc.includes('online')),180);
 const beforeOrder=rowData(firstRows).sort((a,b)=>a.box[1]-b.box[1]).map(r=>r.name);
 const afterOrder=rowData(onlineRows).sort((a,b)=>a.box[1]-b.box[1]).map(r=>r.name);
 writeFileSync(join(EVIDENCE,'live-reconnect-order.json'),JSON.stringify({first:rowData(firstRows),online:rowData(onlineRows),firstCloudStatus:firstRows.find(n=>n.desc.includes(cloudName)&&!n.desc.startsWith('Forget '))?.desc,beforeOrder,afterOrder,providerMachineId:realRef.id},null,2));
 if(JSON.stringify(beforeOrder)!==JSON.stringify(afterOrder))throw Error('paired machine row order changed while reconnecting');
 await tap('Desk machine',v=>v==='Desk');await tap('Switch to Desk',v=>v==='Switch');await go('');
 await waitFor('Desk connected after cloud',ns=>find(ns,v=>v==='Desk')&&find(ns,v=>v==='connected'),120);
 await shot('live-08-desk-switched');await go('settings');
 await tap('real cloud machine',v=>v===cloudName);await tap('Switch to cloud',v=>v==='Switch');await go('');
 await waitFor('real cloud connected',ns=>find(ns,v=>v===cloudName)&&find(ns,v=>v==='connected'),120);
 await shot('live-09-cloud-switched-back');
 await tap('Choose an agent',v=>v==='Choose an agent',60);
 await tap('Shell',v=>v.startsWith('Shell (no agent),'),30);
 await tap('Start Shell',v=>v.startsWith('Start Shell (no agent) in'),30);
 await sleep(5000);await shot('live-10-terminal-open');
 const input=(await screen()).find(n=>n.klass==='android.widget.EditText');
 if(!input)throw Error('terminal composer missing');
 await sh(`input tap ${Math.round((input.box[0]+input.box[2])/2)} ${Math.round((input.box[1]+input.box[3])/2)}`);
 const command='echo MUXR_BOAT_REAL_TERMINAL | tee /tmp/mxca1-terminal';
 for(const chunk of command.match(/.{1,4}/g)){await sh(`input text '${chunk.replaceAll(' ','%s')}'`);await sleep(150);}
 await tap('Send',v=>v==='Send');
 const owned=new Set(JSON.parse(readFileSync(createdFile,'utf8')));
 const ref=(await account.list()).find(r=>owned.has(r.id));if(!ref)throw Error('owned machine missing');
 let answer;
 for(let i=0;i<30;i++){answer=await account.exec(ref,['cat','/tmp/mxca1-terminal'],{timeoutMs:10000});if(answer.code===0&&answer.stdout.includes('MUXR_BOAT_REAL_TERMINAL'))break;await sleep(1000);}
 writeFileSync(join(EVIDENCE,'live-terminal-receipt.json'),JSON.stringify({machineId:ref.id,phoneCommand:command,readbackCommand:['cat','/tmp/mxca1-terminal'],readbackTransport:'independent Boat exec, not muxr terminal',...answer},null,2));
 if(answer.code!==0||!answer.stdout.includes('MUXR_BOAT_REAL_TERMINAL'))throw Error('phone command not received in real cloud shell');
 await sh('input keyevent KEYCODE_ESCAPE');await sleep(2000);await shot('live-11-terminal-output');await go('settings');
 await tap('Forget cloud machine',v=>v===`Forget ${cloudName}`);await tap('Confirm forget',v=>v==='Forget');
 await waitFor('cloud forgotten',ns=>find(ns,v=>v==='Desk')&&!find(ns,v=>v===cloudName),120);
 await shot('live-12-cloud-forgotten');
 if(!flowCaptured)throw Error('actual Boat Create and pair frame was not captured');
 writeFileSync(join(EVIDENCE,'steps.json'),JSON.stringify({target:{version:JSON.parse(readFileSync('package.json')).version},start:'fresh final-round release APK on keeper-owned phone a4b93ea2; paired Desk to private guarded Herdr lab; synthetic claim through authorized real-key proxy',steps:['Settings > Add a cloud machine: single direct stationary touch, real pressed state captured; no intermediate screen','claim synthetic account through authorized upstream proxy','create ONE real Boat small machine at $0.036/hour','list cloud beside Desk with status','switch Desk then cloud','Choose an agent > Shell (no agent) > Start Shell','type echo command and Send through muxr terminal','read marker from real cloud over independent Boat exec','Forget cloud and verify absent'],result:'real machine listed, switched, terminal echoed, forgotten; finally deletes owned provider machine. A still frame cannot show a touch transition: linkage is proven by the driven journey and disclosed, not photographed.'},null,2));
 say('PASS: create, list/status, switch, terminal transport, forget; provider deletion follows.');
}catch(error){failure=error;say('FAIL: '+error.message);process.exitCode=1;}
finally{
 // Delete before lengthy capture/phone cleanup, scoped strictly to creation receipts.
 try{
  // Receipt errors must reach the cleanup failure handler; unknown ownership is not an empty account.
  const ids=JSON.parse(readFileSync(createdFile,'utf8'));
  const owned=new Set(ids);
  if(owned.size>1)throw Error('one-machine ceiling breached');
  const listing=await account.list();
  const usage=[];
  const queryUsage=async(ref,phase)=>{try{const value=await Promise.race([account.usage(ref,new Date(created).toISOString()),new Promise((_,reject)=>{setTimeout(()=>reject(Error('usage deadline')),2500).unref();})]);usage.push({phase,reported:true,...value});}catch(error){usage.push({phase,reported:false,code:error.code??error.name});}};
  for(const ref of listing){if(!owned.has(ref.id))continue;await queryUsage(ref,'before deletion');await account.remove(ref,ref.id);say(`deleted owned machine ${ref.id}`);await queryUsage(ref,'after deletion');}
  const remaining=(await account.list()).map(r=>r.id);
  const elapsedSeconds=created?(Date.now()-created)/1000:0;
  const record={createdIds:ids,remainingOwned:remaining.filter(id=>owned.has(id)),remainingAccount:remaining.length,providerUsage:usage,elapsedSeconds,rateUsdPerHour:0.036,estimatedMachineUsd:elapsedSeconds*0.036/3600,budgetUsd:1,estimatedNotInvoice:true,failed:failure?.message??null};
  writeFileSync(join(EVIDENCE,'live-deletion.json'),JSON.stringify(record,null,2));
  if(record.remainingOwned.length)throw Error('owned machine remains');
 }catch(error){say('MACHINE REMOVAL FAILED: '+error.message);process.exitCode=1;}
 if(desk){const pids=desk.pids();await desk.stop();say(`stopped Desk pids ${pids}`);}
 if(serial){
  await sh(`am force-stop ${PKG}`).catch(()=>{});
  for(const p of reversePorts)await adb(['reverse','--remove',`tcp:${p}`]).catch(()=>{});
  if(originalPhoneSettings){
   const density=originalPhoneSettings.density.match(/Override density: (\d+)/)?.[1];
   await sh(`wm density ${density??'reset'}`);
   await sh(`settings put system font_scale ${originalPhoneSettings.font}`);await sh(`settings put system show_touches ${originalPhoneSettings.touches}`);
   const mode=originalPhoneSettings.night.match(/Night mode: (\w+)/)?.[1];if(mode)await sh(`cmd uimode night ${mode}`);
  }
 }
 if(lab){lab.kill('SIGTERM');await new Promise(done=>lab.exitCode!==null?done():lab.once('exit',done));say(`stopped proxy ${lab.pid}`);}
}
