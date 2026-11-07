const {_electron}=require('playwright'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const root=path.resolve(__dirname,'..');
execFileSync(process.execPath,['scripts/build.cjs'],{cwd:root,env:{...process.env,ENTRETELAS_TEST:'1'}});
(async()=>{const temp=fs.mkdtempSync(path.join(os.tmpdir(),'local-live-audio-recovery-'));let app;
try{app=await _electron.launch({args:[root],env:{...process.env,ENTRETELAS_TEST:'1',ENTRETELAS_TEST_DATA:temp},timeout:30000});const page=await app.firstWindow();await page.waitForFunction(()=>!!window.__test);
await page.evaluate(async()=>{
 let listener,sample=0;window.__replaced=0;window.__statuses=[];window.__stopped=0;
 const desktop={onAudio:fn=>{listener=fn;return()=>listener=null;},audioStart:async()=>({session:'synthetic',state:'ready'}),audioStop:async()=>window.__stopped++,audioRepair:async()=>{}};
 const graph=await window.__test.filteredAudio(status=>window.__statuses.push(status),()=>window.__replaced++,desktop);window.__graph=graph;
 window.__pcmTimer=setInterval(()=>{const data=new Float32Array(1920);for(let i=0;i<960;i++){const s=Math.sin(sample++*2*Math.PI*440/48000)*.25;data[i*2]=data[i*2+1]=s;}listener?.({type:'pcm',session:'synthetic',samples:data});},20);
 window.__attachMeter=async()=>{const context=new AudioContext({sinkId:{type:'none'}}),meter=context.createAnalyser(),source=context.createMediaStreamSource(new MediaStream([graph.track])),mute=context.createGain();mute.gain.value=1;source.connect(meter);meter.connect(mute);mute.connect(context.destination);await context.resume();window.__energy=()=>{const values=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(values);return values.some(v=>Math.abs(v)>.02);};};await window.__attachMeter();
});
await page.waitForFunction(()=>window.__energy());
await page.evaluate(()=>window.__graph.context().suspend());await page.waitForFunction(()=>window.__graph.context().state==='running');await page.waitForFunction(()=>window.__energy());console.log('PASS: AudioContext suspenso retoma automaticamente e volta a emitir áudio.');
await page.evaluate(()=>window.__graph.context().close());await page.waitForFunction(()=>window.__replaced===1);await page.evaluate(()=>window.__attachMeter());await page.waitForFunction(()=>window.__energy());console.log('PASS: AudioContext encerrado é reconstruído e entrega nova faixa audível.');
await page.evaluate(()=>{const context=window.__graph.context(),frozen=context.currentTime;Object.defineProperty(context,'currentTime',{configurable:true,get:()=>frozen});});await page.waitForFunction(()=>window.__replaced===2,null,{timeout:15000});await page.evaluate(()=>window.__attachMeter());await page.waitForFunction(()=>window.__energy());console.log('PASS: relógio parado mesmo com estado running é detectado e o áudio é reconstruído.');
await page.evaluate(()=>{window.__graph.cleanup();clearInterval(window.__pcmTimer);});assert.equal(await page.evaluate(()=>window.__graph.track.readyState),'ended');
}finally{await app?.close();fs.rmSync(temp,{recursive:true,force:true});execFileSync(process.execPath,['scripts/build.cjs'],{cwd:root,env:{...process.env,ENTRETELAS_TEST:''}});}})().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
