const {_electron}=require('playwright'),path=require('node:path'),assert=require('node:assert/strict'),fs=require('node:fs');
const root=path.resolve(__dirname,'..');
const metadata=JSON.parse(require('node:child_process').execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path.join(root,'release/mac-arm64/Local Live.app/Contents/Info.plist')],{encoding:'utf8'}));
assert.equal(metadata.CFBundleIdentifier,'local.entretelas.app');
for(const key of ['NSCameraUsageDescription','NSMicrophoneUsageDescription','NSBluetoothAlwaysUsageDescription','NSBluetoothPeripheralUsageDescription'])assert.equal(metadata[key],undefined);
for(const key of ['NSScreenCaptureUsageDescription','NSAudioCaptureUsageDescription','NSLocalNetworkUsageDescription'])assert.ok(metadata[key]);
async function check(locked=false){
 const profile=fs.mkdtempSync('/private/tmp/local-live-packaged-');
 const file=path.join(profile,'local-live-preferences.json');
 const original='{invalid-saved-preferences';
 // Use an isolated existing profile so this UI check never accesses the user's
 // macOS Keychain. Encryption failures are covered by preferences.test.cjs.
 if(locked)fs.writeFileSync(file,original);
 else new (require('../src/preferences.cjs').Preferences)(profile);
 let app;
 try{
  app=await _electron.launch({executablePath:path.join(root,'release/mac-arm64/Local Live.app/Contents/MacOS/Local Live'),args:['--user-data-dir='+profile],timeout:30000});
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),profile);
  const page=await app.firstWindow();page.setDefaultTimeout(15000);
  await page.waitForURL('**/dist/index.html');
  await page.waitForFunction(()=>typeof document.getElementById('join-card').onclick==='function');
  assert.equal(await page.evaluate(()=>!!window.__test),false);
  assert.equal(await app.evaluate(({app})=>app.getVersion()),require('../package.json').version);
  assert.equal(await page.title(),'Local Live');
  assert.deepEqual(await page.evaluate(async()=>Promise.all(['camera','microphone'].map(async name=>(await navigator.permissions.query({name})).state))),['denied','denied']);
  if(locked){assert.match(await page.locator('#notice-text').textContent(),/dados foram preservados/);assert.equal(fs.readFileSync(file,'utf8'),original);}
  await page.click('#join-card');await page.locator('#join-invite').fill('invalid');await page.click('#join-room');
  await page.waitForFunction(()=>!document.getElementById('notice').hidden);
  assert.match(await page.locator('#notice-text').textContent(),/convite/);
  console.log('PASS: pacote Mac abre e valida convites com perfil '+(locked?'ilegível, preservando os dados.':'temporário; modo de teste desabilitado.'));
 }finally{await app?.close();fs.rmSync(profile,{recursive:true,force:true});}
}
(async()=>{await check();await check(true);})().catch(error=>{console.error(error);process.exitCode=1;});
