const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { WindowsAudio } = require('../src/windows-audio.cjs');
function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.emit('close', 0); };
  child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
  let args;
  const recorder = new WindowsAudio('helper.exe', (...a) => { args = a; return child; });
  return { child, recorder, args: () => args };
}
const ready = { type: 'ready', sampleRate: 48000, channelsPerFrame: 2, bitsPerChannel: 16, isFloat: false };
const send = (child, event) => child.stderr.write(JSON.stringify(event) + '\n');
test('Windows: handshake, PCM fragmentado e limite de atraso', async () => {
  const f = fixture(); const started = f.recorder.startSystemAudio({ excludeProcesses: [123] });
  assert.deepEqual(f.args()[1], ['123']);
  const pcm = Buffer.alloc(3840); pcm.writeInt16LE(1000, 0);
  f.child.stdout.write(pcm.subarray(0, 3));
  send(f.child, ready); await started;
  f.child.stdout.write(pcm.subarray(3));
  const events = f.recorder.processEvents();
  assert.equal(events[0].type, 4); assert.equal(events[1].type, 0); assert.deepEqual(events[1].data, pcm);
  f.child.stdout.write(Buffer.alloc(3840 * 20));
  assert.equal(f.recorder.processEvents().length, 6);
  f.recorder.stop();
});
test('Windows: falha de ativação preserva HRESULT e não inicia áudio misturado', async () => {
  const f = fixture(); const started = f.recorder.startSystemAudio({ excludeProcesses: [123] });
  send(f.child, { type: 'error', stage: 'Initialize', hresult: '0x80004001' });
  await assert.rejects(started, /configurar.*0x80004001/);
  assert.equal(f.recorder.child, null);
});
test('Windows: erro depois de iniciar é reportado e encerrar durante a abertura cancela', async () => {
  const f = fixture(); const started = f.recorder.startSystemAudio({ excludeProcesses: [123] });
  send(f.child, ready); await started; f.recorder.processEvents();
  f.child.emit('close', 1);
  assert.match(f.recorder.processEvents()[0].message, /encerrou inesperadamente/);
  const g = fixture(); const pending = g.recorder.startSystemAudio({ excludeProcesses: [123] });
  g.recorder.stop(); await assert.rejects(pending, /cancelada/);
});
