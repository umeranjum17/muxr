/**
 * Full iOS simulator load run using real host/relay and the shared fake Herdr.
 * Run from the source root in a visible shell pane. Never builds/installs native
 * code or clears the app container. Missing Android metrics make equivalence
 * incomplete; RSS and whole-process CPU have no invented pass thresholds.
 *
 * node perf/iosReleaseGate.mjs --udid UDID --app /path/muxr.app --record /path/run.json
 * Optional --start-file PATH pauses after pairing for preflight review.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pairingCodeHash, openPairingCodePayload } from '../packages/crypto/dist/index.js';
import { CommandScope, useCommandScope } from './lib/commands.mjs';
import { startFakeStack } from './lib/fakeStack.mjs';
import { IosControls, appPid, command, crashFiles, hostLoad, processSample, reduceSamples, sha256, simctl, sleep, unavailable } from './lib/iosSignals.mjs';

export const LOAD = { panes:100, agents:30, titleChurnHz:2, terminalBytesPerSecond:4096, graphicsFrameHz:4 };
export const PHASES = [
    { name:'idle on the herd', seconds:120, drive:'idle' },
    { name:'herd strip and tree soak', seconds:120, drive:'soak' },
    { name:'agent terminal and plugin navigation', seconds:120, drive:'navigate' },
    { name:'herd tree fling', seconds:30, drive:'tree' },
    { name:'herd strip paging', seconds:20, drive:'strip' },
    { name:'document scroll and swipe', seconds:30, drive:'document' },
    { name:'terminal text fling', seconds:30, drive:'terminal' },
    { name:'graphics pane scroll', seconds:90, drive:'graphics' },
    { name:'zoom tap navigate', seconds:60, drive:'zoom' },
];
const args=process.argv.slice(2);
const flag=(name)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const udid=flag('--udid'), app=flag('--app'), record=flag('--record');
if(!udid||!app||!record)throw new Error('Required: --udid UDID --app retained.app --record report.json');
const evidence=join(dirname(resolve(record)),`${record.split('/').at(-1).replace(/\.json$/,'')}-evidence`);
mkdirSync(evidence,{recursive:true});
const scope=new CommandScope();useCommandScope(scope);
const ui=new IosControls(udid), bundle='com.trymuxr.app';
const started=Date.now(), failures=[], journal=new Map();
const report={startedAt:new Date(started).toISOString(),load:LOAD,warmupSeconds:30,phasePlan:PHASES,phases:[],failures,
    platform:'iOS simulator',androidGateEquivalent:false,unsupported:unavailable,limits:null,
    deviations:['Existing app container retained to preserve pairing; fresh load-host handshake required instead of Android pm clear.',
        'AX/simctl gesture injection replaces ADB/Maestro; command elapsed time is not app input latency.',
        'Reviewed bundled plugins explicitly registered; disposable README expanded for meaningful document scroll.']};
let stack, initialPid, finished=false;
const log=(text)=>process.stdout.write(`${new Date().toISOString()} ${text}\n`);
const persist=()=>writeFileSync(record,JSON.stringify(report,null,2)+'\n');
const fail=(text)=>{failures.push(text);log(`FAIL ${text}`);persist();};
function jsonl(path){try{return readFileSync(path,'utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}}
function collectJournal(){
    if(!stack)return;
    try{for(const event of JSON.parse(readFileSync(stack.journalPath,'utf8')).events??[])journal.set(JSON.stringify(event),event);}
    catch{report.journalReadFailures=(report.journalReadFailures??0)+1;}
}
async function shot(name){const path=join(evidence,name+'.png');await ui.screenshot(path);return path;}
async function sampleWindow(seconds, destination){
    const start=Date.now(), deadline=start+seconds*1000;let previous;
    do{
        const sample=await processSample(initialPid);
        if(previous&&sample.alive&&previous.alive){const dt=(Date.parse(sample.at)-Date.parse(previous.at))/1000;sample.processCpuIntervalPercent=dt>0?100*(sample.cpuSeconds-previous.cpuSeconds)/dt:null;}
        previous=sample;destination.push(sample);collectJournal();
        if(!sample.alive&&!failures.includes('App process exited during load'))fail('App process exited during load');
        await sleep(Math.max(0,Math.min(1000,deadline-Date.now())));
    }while(Date.now()<deadline);
    return {measuredSeconds:(Date.now()-start)/1000,...reduceSamples(destination)};
}
async function pair(){
    const minted=await stack.mintPairing();
    if(!minted.code)throw new Error('Load host did not mint pairing code');
    try{
        const locator=new URL(minted.code), shortCode=locator.searchParams.get('pair');
        if(!shortCode)throw new Error('Minted pairing locator has no code');
        locator.protocol=locator.protocol==='wss:'?'https:':'http:';locator.pathname='/v1/selfhost/pair-code';locator.search='';
        const response=await fetch(locator,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code_hash:pairingCodeHash(shortCode)})});
        if(!response.ok)throw new Error('Fresh pairing payload lookup failed');
        const payload=await response.json();
        const compact=openPairingCodePayload(payload.payload,shortCode);
        await ui.open('pair?v=2&payload='+encodeURIComponent(compact));
        await ui.waitFor(/THIS PHONE WILL BE ABLE TO|^Pair$/);
        if(!await ui.tapMatch(/^Pair$/,{optional:true})){await ui.swipe(200,720,200,350,.4);await ui.tapMatch(/^Pair$/);}
        await ui.waitFor(/^(LIVE|SPACES|Machine)$/,90_000);
        report.pairingTransport='Fresh short-code resolved with shared crypto, normal QR deep-link consent and app handshake; no manual-input coverage claimed';
    }finally{minted.release();}
}

async function terminal(){await ui.waitFor(/^Control$|^Enter$|^Show terminal controls$/);}
function firstRoute(){
    const agent=stack.world.agents.find(a=>a.pane_id===stack.world.panes[0].pane_id);
    const routes=JSON.parse(readFileSync(join(stack.dataDir,'herdr-routes.json'),'utf8')).bindings;
    const binding=routes.find(row=>['source','agent','kind','value'].every(key=>row.agentSession[key]===agent?.agent_session[key]));
    if(!binding?.route)throw new Error('Missing persisted first agent route'); return binding.route;
}
async function proveAttach(paneId,since){
    const deadline=Date.now()+10000;
    const agent=stack.world.agents.find(a=>a.pane_id===paneId);
    do {
        collectJournal();
        const attaches=jsonl(stack.attachJsonl).filter(row=>row.pane_id===paneId&&Date.parse(row.at)>=since);
        const requests=[...journal.values()].filter(row=>row.event==='client.request'&&row.request==='terminal.attach'&&row.outcome==='ok'&&Date.parse(row.at)>=since);
        const nodes=await ui.ui();
        const current=nodes.find(n=>ui.visible(n)&&/^Current /.test(n.AXLabel??''));
        const headerMatches=agent ? current?.AXLabel.includes(`${agent.agent}/${agent.name}`) : nodes.some(n=>ui.visible(n)&&/^(Enter|Control)$/.test(n.AXLabel??''));
        const resizes=jsonl(stack.cellMetricsJsonl).filter(row=>row.pane_id===paneId&&Date.parse(row.at)>=since&&[row.cols,row.rows,row.cellWidthPx,row.cellHeightPx].every(v=>Number.isFinite(v)&&v>0));
        const hellos=jsonl(stack.graphicsInputJsonl).filter(row=>row.source==='graphics.ClientHello'&&[row.cols,row.rows,row.cellWidthPx,row.cellHeightPx].every(v=>Number.isFinite(v)&&v>0));
        if(attaches.length&&requests.length&&headerMatches&&(!agent||resizes.length||hellos.length))return {paneId,since,attaches,requests,header:current?.AXLabel??'shell terminal controls',resizes,hellos:hellos.slice(-1),helloFresh:hellos.some(row=>Date.parse(row.at)>=since),geometryScope:'latest connection hello plus fresh selected-route attach and current header'};
        await sleep(300);
    }while(Date.now()<deadline); throw new Error('Fresh selected-pane attachment/header/native graphics evidence absent');
}
async function firstAgent(){await ui.home();const since=Date.now();await ui.open(`session/${encodeURIComponent(firstRoute())}`);await terminal();return proveAttach(stack.world.panes[0].pane_id,since);}
async function shell(pane){const since=Date.now();await ui.open(`session/${encodeURIComponent('shell:'+pane.pane_id)}`);await terminal();return proveAttach(pane.pane_id,since);}
async function document(){
    await ui.home();await ui.tapMatch(/^Files$/);await ui.waitFor(/README.md|All Files|Changes|project|fake-herdr/);
    if(!await ui.tapMatch(/^README.md$/,{optional:true})){await ui.tapMatch(/^(project|fake-herdr|muxr)$/);await ui.waitFor(/README.md/);await ui.tapMatch(/README.md/);}
    await ui.waitFor(/README.md/);
}
async function drive(phase, end, entry){
    const step=async(name,fn)=>{const at=Date.now();try{await fn();entry.actions.push({name,at:new Date(at).toISOString(),elapsedMs:Date.now()-at,ok:true,completedAt:new Date().toISOString()});}
        catch(error){entry.actions.push({name,at:new Date(at).toISOString(),elapsedMs:Date.now()-at,ok:false,error:error.message});throw error;}};
    const agentIds=new Set(stack.world.agents.map(a=>a.pane_id));
    const firstShell=stack.world.panes.find(p=>!agentIds.has(p.pane_id));
    if(['idle','soak','navigate','tree','strip'].includes(phase.drive))await step('verify herd',()=>ui.home());
    if(phase.drive==='document')await step('open actual document',document);
    if(phase.drive==='terminal')await step('open text shell',()=>shell(firstShell));
    if(['graphics','zoom'].includes(phase.drive)){
        await step('open graphics agent',firstAgent);
        entry.graphicsTargetSeen=true; // firstAgent requires fresh native metrics for the persisted route
        if(!entry.graphicsTargetSeen)throw new Error('Graphics fixture pane attach not proven');
    }
    entry.screenSetupVerified=true;entry.beforeScreenshot=await shot(`${phase.drive}-before`);
    while(Date.now()<end){
        if(phase.drive==='idle'){await sleep(Math.min(3000,end-Date.now()));continue;}
        if(phase.drive==='soak'){await step('strip pair',()=>ui.stripPair());await step('tree scroll pair',()=>ui.scrollPair(.3));}
        if(phase.drive==='navigate'){
            await step('open agent terminal',firstAgent);
            for(let i=0;i<8&&Date.now()<end;i++)await step('agent scroll pair',()=>ui.scrollPair(.09));
            await step('return herd',()=>ui.home());
            for(const label of ['Usage','Files']){if(Date.now()>=end)break;await step('plugin '+label,async()=>{await ui.tapMatch(new RegExp('^'+label+'$'));await sleep(500);const nodes=await ui.ui();if(!nodes.some(n=>ui.visible(n)&&(label==='Files'?/Repositories|repositories|All files|No git repositories/:/Today|This week|Usage by|Total|tokens|No usage|Cost/).test(n.AXLabel??'')))throw new Error('Plugin-specific content absent: '+label);await ui.home();});}
            if(Date.now()<end)await step('background foreground',async()=>{await ui.background();await ui.foreground();await ui.waitFor(/^(LIVE|SPACES|Machine)$/);});
        }
        if(['tree','terminal','graphics'].includes(phase.drive))await step('scroll pair',()=>ui.scrollPair(.12));
        if(phase.drive==='strip')await step('strip paging',()=>ui.stripPair());
        if(phase.drive==='document'){
            await step('document vertical scroll',()=>ui.scrollPair(.25));
            if(end-Date.now()<10_000)await step('document horizontal navigation',()=>ui.swipe(320,440,80,440,.3));
        }
        if(phase.drive==='zoom'){
            await step('zoom controls',async()=>{await ui.tapMatch(/^Show terminal controls$/,{optional:true});await ui.tapMatch(/^Zoom in$/);await sleep(450);await ui.tapMatch(/^Zoom out$/);await sleep(450);await ui.tapMatch(/^Reset zoom$/);});
            await step('graphics tap and navigate',async()=>{await ui.tap(160,300);await ui.scrollPair(.12);await ui.swipe(300,440,100,440,.3);});
        }
    }
    entry.requiredScreenVerified=entry.screenSetupVerified&&(phase.drive==='idle'||entry.actions.some(a=>a.ok&&Date.parse(a.completedAt)<=end&&!/^(verify|open actual|open text|open graphics)/.test(a.name)));
    if(!entry.requiredScreenVerified)throw new Error('No completed workload action during phase');
}
async function tour(){
    const agents=new Set(stack.world.agents.map(a=>a.pane_id));const all=stack.world.panes.filter(p=>!agents.has(p.pane_id));const selected=all.slice(0,40);
    const result={totalShells:all.length,selected:selected.length,settleMs:3500,scrollPairsPerVisit:5,backSettleMs:600,visits:[]};report.tour=result;
    for(const [index,pane] of selected.entries()){
        const visit={index:index+1,paneId:pane.pane_id,startedAt:new Date().toISOString(),opened:false};result.visits.push(visit);
        try{visit.nativeAttaches=await shell(pane);await sleep(3500);visit.opened=true;
            for(let n=0;n<5;n++)await ui.scrollPair(.12);
            visit.sample=await processSample(initialPid);collectJournal();await ui.back();
        }catch(error){visit.error=error.message;fail(`Tour visit ${index+1}: ${error.message}`);await ui.home().catch(()=>{});}
        visit.finishedAt=new Date().toISOString();persist();log(`tour ${index+1}/${selected.length} ${visit.opened?'mounted':'failed'}`);
    }
    result.opened=result.visits.filter(v=>v.opened).length;
    result.memory=reduceSamples(result.visits.flatMap(v=>v.sample?[v.sample]:[]));
}
async function finish(){
    if(finished)return;finished=true;collectJournal();
    report.finishedAt=new Date().toISOString();report.hostLoadAfter=hostLoad();report.crashes=crashFiles(started,udid);
    if(report.crashes.length)fail('New muxr crash report(s) detected');
    report.hostEvents=[...journal.values()];report.graphics=report.hostEvents.filter(e=>e.event==='graphics.pipeline');
    report.hostRequests=report.hostEvents.filter(e=>e.event==='client.request');
    if(stack){for(const [key,path] of Object.entries({attaches:stack.attachJsonl,graphicsInput:stack.graphicsInputJsonl,terminalInput:stack.inputJsonl,cellMetrics:stack.cellMetricsJsonl})){
        report[key]=jsonl(path);if(existsSync(path))copyFileSync(path,join(evidence,key+'.jsonl'));}
        writeFileSync(join(evidence,'host.log'),stack.hostLog());writeFileSync(join(evidence,'relay.log'),stack.relayLog());
        report.catalog={panes:stack.world.panes.length,agents:stack.world.agents.length};
    }
    report.pipelinePresent=report.hostRequests.length>0&&report.graphics.length>0&&(report.cellMetrics?.some(row=>row.cellWidthPx>0&&row.cellHeightPx>0)||report.graphicsInput?.some(row=>row.source==='graphics.ClientHello'&&row.cellWidthPx>0&&row.cellHeightPx>0));
    report.observedRunComplete=report.pipelinePresent&&report.phases.length===9&&report.phases.every(p=>p.requiredScreenVerified&&p.measuredSeconds>=p.seconds&&!p.error)&&report.tour?.opened===40;
    report.observedStabilityPassed=failures.length===0&&report.observedRunComplete;
    report.verdict=failures.length?'FAILED_OBSERVATIONS':report.observedRunComplete?'COMPLETED_WITH_METRIC_LIMITATIONS':'INCOMPLETE';
    persist();await scope.close();scope.cleanup();log(`result ${report.verdict}; evidence ${record}`);
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{fail('Interrupted by '+signal);void finish().then(()=>process.exit(130));});
try{
    if(process.platform!=='darwin')throw new Error('iOS simulator runner requires macOS');
    report.source=(await command('git',['rev-parse','HEAD'])).trim();report.hostLoadBefore=hostLoad();
    report.app={path:resolve(app),binarySha256:sha256(join(app,'muxr')),jsSha256:sha256(join(app,'main.jsbundle'))};
    const installed=(await simctl('get_app_container',udid,bundle,'app')).trim();
    report.installedApp={path:installed,binarySha256:sha256(join(installed,'muxr')),jsSha256:sha256(join(installed,'main.jsbundle'))};
    if(report.installedApp.binarySha256!==report.app.binarySha256||report.installedApp.jsSha256!==report.app.jsSha256)throw new Error('Installed app differs from retained input');
    const root=(await ui.ui()).find(n=>n.type==='Application'&&n.frame);
    if(!root||root.frame.width!==402||root.frame.height!==874)throw new Error('Runner requires verified 402x874 simulator AX root');
    if(root.AXLabel!=='muxr')throw new Error('Runner requires retained muxr app display name');
    report.controlGeometry=root.frame;
    report.simulator=JSON.parse(await simctl('list','devices','booted','--json'));report.xcode=await command('xcodebuild',['-version']);
    initialPid=await appPid(udid,bundle);if(!initialPid)throw new Error('Retained normal app must already be running');report.initialPid=initialPid;
    stack=await startFakeStack({...LOAD,sourceRoot:process.cwd(),transport:'loopback',pluginsRoot:join(process.cwd(),'plugins')});
    if(stack.world.panes.length!==100||stack.world.agents.length!==30)throw new Error('Load world differs from100 panes/30 agents');
    const documentText='# iOS load document\n\n'+Array.from({length:2000},(_,i)=>`Line ${i+1}: deterministic document scrolling under full herd load.\n`).join('');
    const doc=join(stack.world.cwd,'README.md');writeFileSync(doc,documentText);report.documentFixture={lines:documentText.split('\n').length,sha256:sha256(doc)};
    await command('git',['-C',stack.world.cwd,'init','-q']);await command('git',['-C',stack.world.cwd,'add','README.md','notes.txt']);
    await command('git',['-C',stack.world.cwd,'-c','user.name=Perf fixture','-c','user.email=perf@example.invalid','commit','-qm','Seed deterministic load document']);
    report.documentFixture.gitTree=(await command('git',['-C',stack.world.cwd,'rev-parse','HEAD^{tree}'])).trim();
    log('pairing fresh isolated host');const pairingAt=Date.now();await pair();report.pairing={freshHost:true,herdVisibleMs:Date.now()-pairingAt};await shot('paired-herd');
    if(args.includes('--verify-controls')){
        log('control preflight strip');await ui.home();await ui.stripPair();
        log('control preflight agent twice');report.controlPreflight={strip:true,agent:await firstAgent()};report.controlPreflight.agentReopen=await firstAgent();
        log('control preflight shell');await ui.home();const ids=new Set(stack.world.agents.map(a=>a.pane_id));report.controlPreflight.shell=await shell(stack.world.panes.find(p=>!ids.has(p.pane_id)));
        await ui.home();await shot('verified-controls');persist();
    }
    report.preflightReadyAt=new Date().toISOString();persist();log('paired; full workload ready');
    const startFile=flag('--start-file');if(startFile){log('waiting for start-file after runner review');while(!existsSync(startFile))await sleep(1000);}
    report.warmup=await sampleWindow(30,[]);persist();
    for(const phase of PHASES){
        const entry={...phase,startedAt:new Date().toISOString(),actions:[],requiredScreenVerified:false};report.phases.push(entry);log('phase '+phase.name);
        const end=Date.now()+phase.seconds*1000;
        const driving=drive(phase,end,entry).catch(error=>{entry.error=error.message;fail(phase.name+': '+error.message);});
        Object.assign(entry,await sampleWindow(phase.seconds,[]));await driving;
        entry.afterScreenshot=await shot(phase.drive+'-after').catch(()=>null);entry.finishedAt=new Date().toISOString();collectJournal();persist();
    }
    await tour();await shot('final');
}catch(error){fail(error.message);}
finally{await finish();}
process.exitCode=failures.length?1:0;
