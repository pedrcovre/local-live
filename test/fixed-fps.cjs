const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-live-fps-'));
  let app;
  try {
    app = await _electron.launch({ args: [root], env: { ...process.env, ENTRETELAS_TEST: '1', ENTRETELAS_TEST_DATA: directory }, timeout: 30000 });
    const page = await app.firstWindow(); page.on('pageerror', e => console.log('PAGE', e.message));
    await page.waitForFunction(() => !!window.__test);
    const measured = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
      const context = canvas.getContext('2d'); let value = 0;
      const paint = setInterval(() => { context.fillStyle = value++ % 2 ? '#224455' : '#335566'; context.fillRect(0, 0, 1920, 1080); }, 33);
      const raw = canvas.captureStream(30);
      let cadence; const failures = [];
      const paced = await window.__test.normalizeVideo(raw, { fps: 144, onStats: s => cadence = s, onError: e => failures.push(e) });
      const send = new RTCPeerConnection({ iceServers: [] }), receive = new RTCPeerConnection({ iceServers: [] });
      const video = document.createElement('video'); video.muted = true; document.body.append(video);
      send.onicecandidate = e => { if (e.candidate) receive.addIceCandidate(e.candidate).catch(() => {}); };
      receive.onicecandidate = e => { if (e.candidate) send.addIceCandidate(e.candidate).catch(() => {}); };
      receive.ontrack = e => { video.srcObject = e.streams[0]; video.play(); };
      const sender = send.addTrack(paced.stream.getVideoTracks()[0], paced.stream);
      const codecs = RTCRtpSender.getCapabilities('video').codecs;
      const h264 = codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
      send.getTransceivers()[0].setCodecPreferences([...h264, ...codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264')]);
      await send.setLocalDescription(await send.createOffer()); await receive.setRemoteDescription(send.localDescription);
      await receive.setLocalDescription(await receive.createAnswer()); await send.setRemoteDescription(receive.localDescription);
      const parameters = sender.getParameters(); parameters.encodings[0].maxBitrate = 100000000; parameters.encodings[0].maxFramerate = 144; parameters.degradationPreference = 'maintain-framerate-and-resolution'; await sender.setParameters(parameters);
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const stats = async () => { const report = await receive.getStats(); let row; report.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') row = r; }); return row && { frames: row.framesDecoded, time: row.timestamp, width: row.frameWidth, height: row.frameHeight }; };
      try {
        await wait(4000); const first = await stats(); await wait(5000); const last = await stats();
        let encoding; const outbound = await send.getStats(); outbound.forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') encoding = { fps: r.framesPerSecond, limitation: r.qualityLimitationReason, codec: outbound.get(r.codecId)?.mimeType, encodeTime: r.totalEncodeTime / r.framesEncoded }; });
        return { cadence, encoding, receivedFps: first && last ? (last.frames - first.frames) / ((last.time - first.time) / 1000) : 0, last, failures, sourceSettings: raw.getVideoTracks()[0].getSettings(), outputSettings: paced.stream.getVideoTracks()[0].getSettings() };
      } finally { clearInterval(paint); paced.cleanup(); send.close(); receive.close(); video.remove(); }
    });
    console.log(JSON.stringify(measured, null, 2));
    assert.deepEqual(measured.failures, []);
    assert.equal(measured.last.width, 1920); assert.equal(measured.last.height, 1080);
    assert.ok(measured.cadence.outputFps > 140, 'gerador mantém a cadência próxima de 144');
    assert.ok(measured.receivedFps > 140, 'WebRTC recebe a cadência alta de verdade');
    assert.ok(measured.cadence.repeatedFps > 60, 'repetições são contabilizadas explicitamente');
    console.log('PASS: 1080p em cadência alta recebido via WebRTC; quadros repetidos identificados.');
  } finally { await app?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
