const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discordFilter, pcmStereo, DiscordAudio } = require('../src/audio.cjs');
const waitFor = async predicate => { const deadline=Date.now()+1500; while(!predicate()){if(Date.now()>deadline)throw new Error('Recuperação não ocorreu.');await new Promise(resolve=>setTimeout(resolve,5));} };
const rows = pid => [{pid,parent:1,name:'Discord.exe'}];
function fakeRecorder() { return { events:[{type:4,sampleRate:48000,channelsPerFrame:2,bitsPerChannel:32,isFloat:true}],stops:0,startSystemAudio(options){this.options=options;},stop(){this.stops++;},processEvents(){const events=this.events;this.events=[];return events;}}; }
test('Windows identifica a árvore do Discord e recusa múltiplas raízes',()=>{
 assert.deepEqual(discordFilter([{pid:10,parent:1,name:'Discord.exe'},{pid:11,parent:10,name:'Discord.exe'}],'win32'),[10]);
 assert.throws(()=>discordFilter([...rows(10),...rows(20)],'win32'));
});
test('PCM estéreo mantém formato e rejeita formato incompatível',()=>{
 const data=Buffer.alloc(8);data.writeFloatLE(.25);data.writeFloatLE(-.5,4);
 assert.deepEqual([...pcmStereo(data,{sampleRate:48000,channelsPerFrame:2,bitsPerChannel:32,isFloat:true})],[.25,-.5]);
 assert.throws(()=>pcmStereo(data,{sampleRate:44100}));
});
test('mudança de processo reconecta o áudio mantendo a sessão pública e sem misturar a chamada',async()=>{
 let current=rows(10);const recorders=[],packets=[];
 const audio=new DiscordAudio({platform:'win32',factory:()=>{const r=fakeRecorder();recorders.push(r);return r;},processes:async()=>current,emit:p=>packets.push(p),monitorMs:5,retryMs:5});
 try { const started=await audio.start();current=rows(20);await waitFor(()=>recorders.length===2);assert.equal(audio.session,started.session);assert.deepEqual(recorders[0].options.excludeProcesses,[10]);assert.deepEqual(recorders[1].options.excludeProcesses,[20]);assert.equal(recorders[0].stops,1);assert.ok(packets.some(p=>p.state==='recovering'));assert.ok(packets.filter(p=>p.state==='ready').length>=2); }
 finally{audio.stop();}
});
test('erro nativo se recupera sem exigir reinício da transmissão',async()=>{
 const recorders=[];const audio=new DiscordAudio({platform:'win32',factory:()=>{const r=fakeRecorder();recorders.push(r);return r;},processes:async()=>rows(10),emit:()=>{},monitorMs:5,retryMs:5});
 try {await audio.start();recorders[0].events.push({type:3,message:'Dispositivo mudou'});await waitFor(()=>recorders.length===2);assert.equal(recorders[0].stops,1);assert.ok(audio.session);}
 finally{audio.stop();}
});
test('fonte travada é reaberta; parar cancela tentativas futuras',async()=>{
 let now=100000;const recorders=[];const audio=new DiscordAudio({platform:'win32',factory:()=>{const r=fakeRecorder();recorders.push(r);return r;},processes:async()=>rows(10),emit:()=>{},monitorMs:5,retryMs:10,stallMs:10,now:()=>now});
 await audio.start();now+=100;await waitFor(()=>recorders.length===2);audio.restart();audio.stop();const count=recorders.length;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(recorders.length,count);assert.equal(audio.session,null);
});
test('parar durante inicialização pendente não reabre o capturador',async()=>{
 let resolve;let opened=0;const audio=new DiscordAudio({platform:'win32',factory:()=>{opened++;return fakeRecorder();},processes:()=>new Promise(r=>resolve=r),emit:()=>{}});
 const starting=audio.start();audio.stop();resolve(rows(10));await assert.rejects(starting,/cancelada/);assert.equal(opened,0);
});
test('macOS ignora o próprio processo de captura ao detectar mudanças, evitando ciclo de reconexão',async()=>{
 let captureObject=10;const recorders=[];
 const audio=new DiscordAudio({platform:'darwin',factory:()=>{const r=fakeRecorder();recorders.push(r);return r;},processes:async()=>[{pid:99,parent:1,name:'/Applications/Discord.app/Contents/MacOS/Discord',audioObject:4},{pid:process.pid,parent:1,name:'/Applications/Local Live.app/Contents/MacOS/Local Live',audioObject:captureObject},{pid:88,parent:process.pid,name:'/Applications/Local Live.app/Contents/Frameworks/Local Live Helper.app/Contents/MacOS/Local Live Helper',audioObject:8}],emit:()=>{},monitorMs:5,retryMs:5});
 try{await audio.start();captureObject=20;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(recorders.length,1);assert.deepEqual(recorders[0].options.excludeProcesses,[88,99]);}finally{audio.stop();}
});
