const { _electron } = require('playwright');
const { PeerServer } = require('peer');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), apps = [], temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-live-rooms-'));
execFileSync(process.execPath, ['scripts/build.cjs'], { cwd: root, env: { ...process.env, ENTRETELAS_TEST: '1' } });
let server;
const wait = (page, fn) => page.waitForFunction(fn, null, { timeout: 30000 });
async function launch(name) {
 const app = await _electron.launch({ args: [root], env: { ...process.env, ENTRETELAS_TEST: '1', ENTRETELAS_TEST_DATA: path.join(temp, name) }, timeout: 30000 }); apps.push(app);
 const page = await app.firstWindow(); page.on('pageerror', e => console.error('PAGE', name, e.message)); await wait(page, () => !!window.__test); return page;
}
async function publish(page, height = 720, fps = 30) {
 await page.evaluate(async ({height,fps}) => {
  const width=height===720?1280:1920,canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');let i=0;
  const timer=setInterval(()=>{ctx.fillStyle=i++%2?'#245ea0':'#397fb2';ctx.fillRect(0,0,width,height);},33);
  let listener,sample=0;const backend={onAudio:fn=>{listener=fn;return()=>listener=null;},audioStart:async()=>({session:'pcm-test',state:'ready'}),audioStop:async()=>{},audioRepair:async()=>{}};
  const audio=await window.__test.filteredAudio(()=>{},track=>window.__test.room.replaceAudio(track),backend);
  const pcm=setInterval(()=>{const samples=new Float32Array(1920);for(let n=0;n<960;n++){const v=Math.sin(sample++*2*Math.PI*440/48000)*.3;samples[n*2]=samples[n*2+1]=v;}listener?.({type:'pcm',session:'pcm-test',samples});},20);
  const stream=canvas.captureStream(fps);stream.addTrack(audio.track);window.__audio=audio.context();window.__stream=stream;window.__audioGraph=audio;
  window.__test.room.setBroadcast(stream,{width,height,fps},30);
  window.__test.room.addEventListener('broadcast',e=>{if(!e.detail.active){clearInterval(timer);clearInterval(pcm);audio.cleanup();}},{once:true});
 },{height,fps});
}
(async()=>{try{
 await new Promise(resolve=>PeerServer({host:'127.0.0.1',port:19091,path:'/'},s=>{server=s;resolve();}));
 const a=await launch('owner'), b=await launch('friend'), c=await launch('third');
 await a.locator('#my-name').fill('Pedro'); await a.click('#create-card'); await a.locator('#new-room-name').fill('Noite de jogos'); await a.click('#create-room'); await wait(a,()=>window.__test.room.active&&!!window.__test.room.peer?.open);
 const invite=await a.evaluate(()=>window.__test.room.invite); assert.match(invite,/^locallive:\/\/sala\//);
 let joined=1; for(const [page,name] of [[b,'Marina'],[c,'Rafael']]){await page.locator('#my-name').fill(name); await page.click('#join-card');await page.locator('#join-invite').fill(invite);await page.click('#join-room'); joined++; await page.waitForFunction(count=>window.__test.room.members.size===count,joined,{timeout:30000});}
 await wait(a,()=>window.__test.room.members.size===3); console.log('PASS: sala nomeada e três participantes, entrada direta sem aprovação.');
 await publish(a); await wait(a,()=>document.getElementById('viewer-stage').dataset.mode==='local'&&document.getElementById('remote').videoWidth===1280); await wait(b,()=>document.getElementById('remote').videoWidth===1280); await wait(c,()=>document.getElementById('remote').videoWidth===1280);
 assert.equal(await b.locator('#remote').getAttribute('controls'),null);
 assert.deepEqual(await b.locator('#watch-fps option').evaluateAll(rows=>rows.map(r=>r.value)),['15','30']);
 assert.deepEqual(await b.locator('#watch-height option').evaluateAll(rows=>rows.map(r=>r.value)),['480','720']);
 await b.selectOption('#watch-height','480'); await wait(a,()=>[...window.__test.room.watchers.values()].some(w=>w.quality.height===480)); await wait(b,()=>document.getElementById('remote').videoHeight===480);
 await b.locator('#volume').fill('25'); await b.locator('#volume').dispatchEvent('input'); assert.equal(await b.evaluate(()=>document.getElementById('remote-audio').volume),.25);
 console.log('PASS: vídeo/áudio recebidos, volume e qualidade/FPS limitados à transmissão; sem botão de pausa.');
 await b.evaluate(async()=>{const context=new AudioContext({sinkId:{type:'none'}}), source=context.createMediaStreamSource(window.__test.room.remoteStream), meter=context.createAnalyser(),mute=context.createGain();mute.gain.value=1;source.connect(meter);meter.connect(mute);mute.connect(context.destination);await context.resume(); window.__meter=meter;window.__hasAudio=()=>{const v=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(v);return v.some(n=>Math.abs(n)>.01);};}); try{await b.waitForFunction(()=>window.__hasAudio(),null,{timeout:8000});}catch(error){console.log('AUDIO SOURCE',JSON.stringify(await a.evaluate(()=>({state:window.__audio.state,time:window.__audio.currentTime,sampleRate:window.__audio.sampleRate,tracks:window.__stream.getAudioTracks().map(t=>({enabled:t.enabled,state:t.readyState})), pcs:[...window.__test.room.watchers.values()].map(w=>({id:w.id,senders:w.call.peerConnection.getSenders().map(s=>({kind:s.track?.kind,ready:s.track?.readyState})),sdp:w.call.peerConnection.localDescription.sdp.split('\r\n').filter(line=>/^m=|^a=(sendrecv|sendonly|recvonly|inactive)/.test(line))}))})),null,2));console.log('AUDIO RECEIVE',await b.evaluate(async()=>{let audio;const stats=await window.__test.room.call.peerConnection.getStats();stats.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='audio')audio={bytes:s.bytesReceived,level:s.audioLevel,energy:s.totalAudioEnergy};});return{audio,tracks:window.__test.room.remoteStream.getAudioTracks().map(t=>({enabled:t.enabled,muted:t.muted,state:t.readyState})),context:window.__meter.context.state,sdp:window.__test.room.call.peerConnection.localDescription.sdp.split('\r\n').filter(line=>/^m=|^a=(sendrecv|sendonly|recvonly|inactive)/.test(line)),element:{tracks:document.getElementById('remote-audio').srcObject?.getTracks().length,state:document.getElementById('remote-audio').readyState}};}));throw error;}
 await publish(b,1080,60); await wait(a,()=>document.getElementById('remote').videoWidth===1920); assert.equal(await a.evaluate(()=>!!window.__test.room.stream),true); console.log('PASS: quem assiste também transmite na mesma sala; duas telas simultâneas.');
 await a.evaluate(()=>window.__test.room.stopBroadcast()); await wait(b,()=>window.__test.room.members.get(window.__test.room.identity.id)?.caps===null); assert.equal(await b.evaluate(()=>!!window.__test.room.stream),true);assert.equal(await a.evaluate(()=>window.__test.room.active),true); await wait(c,()=>window.__test.room.watching!==window.__test.room.identity.id);console.log('PASS: encerrar apenas uma tela mantém sala e outra transmissão.'); await wait(b,()=>document.getElementById('viewer-stage').dataset.mode==='local'&&document.getElementById('remote').videoWidth===1920); assert.equal(await b.locator('#remote-empty').isVisible(),false); console.log('PASS: quando resta só sua transmissão, a prévia ocupa o centro automaticamente.');
 await a.evaluate(async()=>{const context=new AudioContext({sinkId:{type:'none'}}),source=context.createMediaStreamSource(window.__test.room.remoteStream),meter=context.createAnalyser(),mute=context.createGain();meter.fftSize=4096;mute.gain.value=1;source.connect(meter);meter.connect(mute);mute.connect(context.destination);await context.resume();window.__sameCall=window.__test.room.call;window.__frequency=()=>{const v=new Float32Array(meter.frequencyBinCount);meter.getFloatFrequencyData(v);let index=0;for(let i=1;i<v.length;i++)if(v[i]>v[index])index=i;return index*context.sampleRate/meter.fftSize;};});
 await b.evaluate(async()=>{let listener,sample=0;const backend={onAudio:fn=>{listener=fn;return()=>listener=null;},audioStart:async()=>({session:'replacement',state:'ready'}),audioStop:async()=>{},audioRepair:async()=>{}};const graph=await window.__test.filteredAudio(()=>{},()=>{},backend);window.__replacement=graph;window.__replacementPCM=setInterval(()=>{const samples=new Float32Array(1920);for(let i=0;i<960;i++){const v=Math.sin(sample++*2*Math.PI*700/48000)*.3;samples[i*2]=samples[i*2+1]=v;}listener?.({type:'pcm',session:'replacement',samples});},20);await window.__test.room.replaceAudio(graph.track);});
 await wait(a,()=>window.__frequency()>650&&window.__frequency()<750);assert.equal(await a.evaluate(()=>window.__sameCall===window.__test.room.call),true);console.log('PASS: substituição de áudio preserva a chamada de vídeo.');
 await a.screenshot({path:path.join(root,'test/room-preview.png'),fullPage:true});
 await c.evaluate(()=>window.__test.room.leave());
 await c.evaluate(()=>window.__test.presence.refresh());
 await wait(c,()=>document.querySelector('#saved-list .room-link')?.dataset.status==='online');
 assert.equal(await c.evaluate(()=>window.__test.room.active),false);
 assert.equal(await a.evaluate(()=>window.__test.room.members.size),2);
 assert.equal(await c.locator('#saved-list .room-link small').textContent(),'Online');
 assert.equal(await c.locator('#saved-list .room-link .room-symbol.online').count(),1);
 assert.equal(await c.locator('#saved-list').getByText('Convite salvo').count(),0);
 console.log('PASS: a sala aparece Online após sair; consultar disponibilidade não entra na sala.');
 await c.evaluate(async()=>{const presence=window.__test.presence,peer=presence.peer,connect=peer.connect;peer.connect=()=>{throw new Error('Falha sintética da consulta');};try{await presence.refresh();}finally{peer.connect=connect;}});
 assert.equal(await c.locator('#saved-list .room-link small').textContent(),'Sem conexão');
 await c.evaluate(()=>window.__test.presence.refresh());
 await wait(c,()=>document.querySelector('#saved-list .room-link')?.dataset.status==='online');
 console.log('PASS: falha da consulta mostra Sem conexão e se recupera, sem afetar a sala ativa.');
 const protocol=require('../src/room-protocol.cjs'),bad=protocol.readInvite(invite);bad.secret=(bad.secret[0]==='a'?'b':'a')+bad.secret.slice(1);
 await c.click('#join-card');await c.locator('#join-invite').fill(protocol.inviteFor(bad,'Convite inválido'));await c.click('#join-room');await wait(c,()=>!document.getElementById('notice').hidden);assert.equal(await c.evaluate(()=>window.__test.room.active),false);assert.equal(await a.evaluate(()=>window.__test.room.members.size),2);console.log('PASS: convite com chave incorreta não entra na sala.');
 await b.evaluate(()=>window.__test.room.leave());await a.evaluate(()=>window.__test.room.leave());
 await c.evaluate(()=>window.__test.presence.refresh());
 await wait(c,()=>document.querySelector('#saved-list .room-link')?.dataset.status==='offline');
 assert.equal(await c.locator('#saved-list .room-link small').textContent(),'Offline');
 assert.equal(await c.locator('#saved-list .room-link.is-offline .room-symbol.offline').count(),1);
 console.log('PASS: sala fechada muda para Offline em cinza, sem alterar os convites salvos.');
 console.log('ALL ROOM CHECKS PASSED');
 }finally{for(const app of apps.reverse())await app.close().catch(()=>{});server?.close();fs.rmSync(temp,{recursive:true,force:true});execFileSync(process.execPath,['scripts/build.cjs'],{cwd:root,env:{...process.env,ENTRETELAS_TEST:''}});}
})().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
