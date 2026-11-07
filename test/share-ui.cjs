const { _electron } = require('playwright');
const { PeerServer } = require('peer');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-live-share-ui-'));
const apps = [];
let server;
execFileSync(process.execPath, ['scripts/build.cjs'], { cwd: root, env: { ...process.env, ENTRETELAS_TEST: '1' } });
async function launch(label) {
  const app = await _electron.launch({ args: [root], env: { ...process.env, ENTRETELAS_TEST: '1', ENTRETELAS_TEST_DATA: path.join(temp, label) } });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.__test);
  return page;
}
async function assertCapture(page) {
  assert.equal(await page.evaluate(() => {
    const room = window.__test.room, original = window.__original;
    return room.active && room.stream === original.stream && room.peer === original.peer && room.id === original.id
      && room.stream.getTracks().every((track, index) => track === original.tracks[index] && track.readyState === 'live')
      && window.__audioContext.state === 'running' && window.__captureCount === 1;
  }), true, 'Navegar deve preservar a sala, captura, áudio e conexão originais.');
}
(async () => {
  try {
    await new Promise(resolve => PeerServer({ host: '127.0.0.1', port: 19091, path: '/' }, instance => { server = instance; resolve(); }));
    const host = await launch('host');
    await host.click('#create-card');
    await host.locator('#new-room-name').fill('Teste de interface');
    await host.click('#create-room');
    await host.waitForFunction(() => window.__test.room.members.size === 1);
    await host.evaluate(() => {
      window.__test.setNativePicker(true);
      window.__captureCount = 0;
      navigator.mediaDevices.getDisplayMedia = async options => {
        window.__captureOptions = options; window.__captureCount++;
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const ctx = canvas.getContext('2d');
        window.__painting = setInterval(() => { ctx.fillStyle = `hsl(${Date.now() % 360} 50% 35%)`; ctx.fillRect(0, 0, 1280, 720); }, 33);
        return canvas.captureStream(30);
      };
      window.__test.setAudioFactory(async status => {
        const context = new AudioContext({ sinkId: { type: 'none' } }), destination = context.createMediaStreamDestination();
        const tone = context.createOscillator(); tone.connect(destination); tone.start(); await context.resume();
        window.__audioContext = context; status({ state: 'ready' });
        return { track: destination.stream.getAudioTracks()[0], repair: async () => {}, cleanup: () => {
          clearInterval(window.__painting); tone.stop(); destination.stream.getTracks().forEach(track => track.stop()); context.close();
        } };
      });
    });
    await host.click('#share'); await host.selectOption('#capture-height', '720'); await host.selectOption('#capture-fps', '60');
    await host.click('#start-sharing');
    await host.waitForFunction(() => window.__test.room.stream?.getAudioTracks().length === 1);
    await host.waitForFunction(() => document.getElementById('preview').videoHeight === 720);
    assert.equal(await host.locator('#audio-mode').count(), 0);
    assert.deepEqual(await host.evaluate(() => ({ height: window.__test.room.caps.height, fps: window.__test.room.caps.fps })), { height: 720, fps: 60 });
    assert.equal(await host.evaluate(() => window.__captureOptions.audio), false);
    await host.evaluate(() => {
      const room = window.__test.room;
      window.__original = { stream: room.stream, tracks: room.stream.getTracks(), peer: room.peer, id: room.id };
    });
    // Reproduces the original report even with nobody else in the room.
    await host.click('#home');
    assert.equal(await host.locator('#home-view').isVisible(), true);
    await assertCapture(host);
    await host.locator('#saved-list .room-link', { hasText: 'Teste de interface' }).click();
    assert.equal(await host.locator('#room-view').isVisible(), true);
    await assertCapture(host);
    console.log('PASS: Início e retorno pela sala salva preservam a captura original, sem espectadores.');

    const invite = await host.evaluate(() => window.__test.room.invite);
    const viewer = await launch('viewer');
    await viewer.click('#join-card'); await viewer.locator('#join-invite').fill(invite); await viewer.click('#join-room');
    await viewer.waitForFunction(() => document.getElementById('remote').videoHeight === 720);
    await viewer.evaluate(async () => {
      const room = window.__test.room, stats = await room.call.peerConnection.getStats();
      let videoBytes = 0, audioBytes = 0;
      stats.forEach(item => { if (item.type === 'inbound-rtp') { if (item.kind === 'video') videoBytes = item.bytesReceived; if (item.kind === 'audio') audioBytes = item.bytesReceived; } });
      window.__originalWatch = { call: room.call, stream: room.remoteStream, peer: room.peer, videoBytes, audioBytes };
    });
    let confirmations = 0;
    host.on('dialog', async dialog => { confirmations++; await dialog.accept(); });
    await host.click('#home'); await viewer.click('#home');
    assert.equal(confirmations, 0, 'Início não deve pedir para sair ou fechar a sala.');
    await assertCapture(host);
    await viewer.waitForFunction(async () => {
      const room = window.__test.room, previous = window.__originalWatch;
      if (!room.active || room.call !== previous.call || room.remoteStream !== previous.stream || room.peer !== previous.peer) return false;
      const stats = await room.call.peerConnection.getStats(); let video = false, audio = false;
      stats.forEach(item => { if (item.type === 'inbound-rtp') { if (item.kind === 'video') video = item.bytesReceived > previous.videoBytes; if (item.kind === 'audio') audio = item.bytesReceived > previous.audioBytes; } });
      return video && audio;
    }, null, { timeout: 15000 });
    await host.screenshot({ path: path.join(root, 'test/navigation-preview.png'), fullPage: true });
    await host.click('#resume-room');
    await viewer.locator('#saved-list .room-link', { hasText: 'Teste de interface' }).click();
    assert.equal(await host.locator('#room-view').isVisible(), true);
    assert.equal(await viewer.locator('#room-view').isVisible(), true);
    assert.equal(await viewer.evaluate(() => window.__test.room.call === window.__originalWatch.call), true);
    await assertCapture(host);
    console.log('PASS: transmissor e espectador vão ao Início e voltam mantendo a mesma chamada e o recebimento de áudio/vídeo.');

    await host.click('#stop-sharing');
    await host.waitForFunction(() => !window.__test.room.stream && window.__audioContext.state === 'closed');
    assert.equal(await host.evaluate(() => window.__test.room.active), true);
    assert.equal(await host.evaluate(() => window.__original.tracks.every(track => track.readyState === 'ended')), true);
    await viewer.click('#leave-room');
    await host.waitForFunction(() => window.__test.room.members.size === 1);
    await host.click('#leave-room');
    assert.equal(await host.evaluate(() => window.__test.room.active), false);
    assert.equal(await host.locator('#home-view').isVisible(), true);
    assert.equal(await host.locator('#active-room').isVisible(), false);
    console.log('PASS: Encerrar minha transmissão libera a captura; Sair desconecta explicitamente.');
  } finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    server?.close(); fs.rmSync(temp, { recursive: true, force: true });
    execFileSync(process.execPath, ['scripts/build.cjs'], { cwd: root, env: { ...process.env, ENTRETELAS_TEST: '' } });
  }
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
