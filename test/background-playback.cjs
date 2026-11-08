const { _electron } = require('playwright');
const { PeerServer } = require('peer');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), apps = [], temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'local-live-background-'));
let server;
execFileSync(process.execPath, ['scripts/build.cjs'], { cwd: root, env: { ...process.env, ENTRETELAS_TEST: '1' } });
async function launch(name) {
  const app = await _electron.launch({ args: [root], env: { ...process.env, ENTRETELAS_TEST: '1', ENTRETELAS_TEST_DATA: path.join(temporary, name) } }); apps.push(app);
  const page = await app.firstWindow(); await page.waitForFunction(() => !!window.__test);
  return { app, page };
}
async function rate(page, milliseconds = 2200) {
  return page.evaluate(async milliseconds => {
    const connection = window.__test.room.call?.peerConnection;
    const sample = async () => { let video, audio; (await connection.getStats()).forEach(item => { if (item.type === 'inbound-rtp') { if (item.kind === 'video') video = item; if (item.kind === 'audio') audio = item; } }); return { frames: video?.framesDecoded || 0, time: video?.timestamp || 0, audio: audio?.bytesReceived || 0 }; };
    const first = await sample(); await new Promise(resolve => setTimeout(resolve, milliseconds)); const last = await sample();
    return { fps: (last.frames - first.frames) / ((last.time - first.time) / 1000), audioBytes: last.audio - first.audio };
  }, milliseconds);
}
async function restore(app) {
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.showInactive(); window.emit('focus'); });
}
(async () => {
  try {
    await new Promise(resolve => PeerServer({ host: '127.0.0.1', port: 19091, path: '/' }, instance => { server = instance; resolve(); }));
    const host = await launch('host'), viewer = await launch('viewer');
    await host.page.click('#create-card'); await host.page.locator('#new-room-name').fill('Retorno após Alt+Tab'); await host.page.click('#create-room');
    await host.page.waitForFunction(() => window.__test.room.members.size === 1);
    const invite = await host.page.evaluate(() => window.__test.room.invite);
    await viewer.page.click('#join-card'); await viewer.page.locator('#join-invite').fill(invite); await viewer.page.click('#join-room');
    await host.page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d'); let count = 0;
      window.__paint = setInterval(() => { context.fillStyle = count++ % 2 ? '#24799d' : '#173656'; context.fillRect(0, 0, 1280, 720); }, 30);
      const video = await window.__test.normalizeVideo(canvas.captureStream(30), { width: 1280, height: 720, fps: 60 });
      const audio = new AudioContext({ sinkId: { type: 'none' } }), destination = audio.createMediaStreamDestination(), tone = audio.createOscillator();
      tone.connect(destination); tone.start(); await audio.resume(); video.stream.addTrack(destination.stream.getAudioTracks()[0]);
      window.__capture = { video, audio, tone, track: video.stream.getVideoTracks()[0], peer: window.__test.room.peer };
      window.__test.room.setBroadcast(video.stream, { width: 1280, height: 720, fps: 60 }, 30);
    });
    await viewer.page.waitForFunction(() => document.getElementById('remote').videoHeight === 720);
    await viewer.page.selectOption('#watch-height', '480'); await viewer.page.selectOption('#watch-fps', '30');
    await viewer.page.waitForFunction(() => document.getElementById('remote').videoHeight === 480);
    await restore(viewer.app); await viewer.page.waitForTimeout(4500);
    const initial = await rate(viewer.page); assert.ok(initial.fps >= 20, JSON.stringify(initial));
    await viewer.page.evaluate(() => { window.__originalCall = window.__test.room.call; });
    await viewer.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await viewer.page.waitForTimeout(1800); await restore(viewer.app);
    const normal = await rate(viewer.page); assert.ok(normal.fps >= 20, JSON.stringify(normal));
    assert.equal(await viewer.page.evaluate(() => window.__originalCall === window.__test.room.call), true);
    console.log('PASS: minimizar/restaurar sem falha mantém FPS e a mesma chamada.');

    await viewer.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    // Inject a real 1 FPS media flow. The video clock and audio still advance,
    // reproducing the condition missed by a watchdog that only checks freezes.
    await host.page.evaluate(async () => {
      const watcher = [...window.__test.room.watchers.values()][0];
      const sender = watcher.call.peerConnection.getSenders().find(sender => sender.track?.kind === 'video');
      const parameters = sender.getParameters(); parameters.encodings[0].maxFramerate = 1; await sender.setParameters(parameters);
    });
    const slow = await rate(viewer.page, 3500); assert.ok(slow.fps < 3, JSON.stringify(slow));
    await viewer.page.evaluate(() => { window.__viewerPeer = window.__test.room.peer; window.__clockBeforeReturn = document.getElementById('remote').currentTime; });
    await restore(viewer.app);
    await viewer.page.waitForFunction(() => window.__test.room.call && window.__test.room.call !== window.__originalCall && document.getElementById('remote').videoHeight === 480, null, { timeout: 23000 });
    await viewer.page.waitForTimeout(1800);
    const recovered = await rate(viewer.page); assert.ok(recovered.fps >= 20, JSON.stringify(recovered)); assert.ok(recovered.audioBytes > 0);
    assert.equal(await viewer.page.evaluate(() => window.__test.room.peer === window.__viewerPeer && window.__test.room.members.size === 2 && window.__test.room.applied.height === 480 && window.__test.room.applied.fps === 30 && !document.getElementById('remote-audio').paused), true);
    assert.equal(await host.page.evaluate(() => window.__test.room.stream.getVideoTracks()[0] === window.__capture.track && window.__capture.track.readyState === 'live' && window.__test.room.peer === window.__capture.peer), true);
    console.log('PASS: recepção de '+slow.fps.toFixed(1)+' FPS recupera para '+recovered.fps.toFixed(1)+' FPS com áudio, mesma sala e captura original.');
  } finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    server?.close(); fs.rmSync(temporary, { recursive: true, force: true });
    execFileSync(process.execPath, ['scripts/build.cjs'], { cwd: root, env: { ...process.env, ENTRETELAS_TEST: '' } });
  }
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
