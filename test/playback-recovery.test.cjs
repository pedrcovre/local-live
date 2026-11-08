const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackRecovery } = require('../src/playback-recovery.cjs');
function fixture() {
  let time = 0, rebound = 0, reconnected = 0; const session = {};
  const recovery = new PlaybackRecovery({ now: () => time, rebind: () => rebound++, reconnect: () => reconnected++ });
  const sample = (fps, options = {}) => { time += 2000; recovery.observe({ session, fps, targetFps: 30, sampleSeconds: 2, visible: true, ...options }); };
  return { recovery, sample, advance: ms => time += ms, counts: () => ({ rebound, reconnected }) };
}
test('1 FPS após voltar ao foco dispara restauração mesmo com relógio e quadros avançando', () => {
  const f = fixture(); f.sample(30); f.recovery.suspend(); f.advance(30000); f.recovery.resume();
  for (let i = 0; i < 6; i++) f.sample(1);
  assert.equal(f.counts().reconnected, 1); assert.ok(f.counts().rebound >= 2);
  for (let i = 0; i < 5; i++) f.sample(1);
  assert.equal(f.counts().reconnected, 1, 'a recuperação respeita o intervalo mínimo de 30 segundos');
});
test('segundo plano, amostras iniciais e quedas breves não derrubam uma chamada', () => {
  const f = fixture(); for (let i = 0; i < 10; i++) f.sample(0);
  assert.equal(f.counts().reconnected, 0);
  f.sample(30); f.recovery.suspend(); for (let i = 0; i < 10; i++) f.sample(1);
  assert.equal(f.counts().reconnected, 0);
  f.recovery.resume(); f.sample(30); f.sample(1); f.sample(30); f.sample(1); f.sample(30);
  assert.equal(f.counts().reconnected, 0);
});
test('15 FPS selecionados continuam saudáveis e troca de chamada limpa amostras antigas', () => {
  const f = fixture(); f.sample(15, { targetFps: 15 }); f.recovery.resume();
  for (let i = 0; i < 10; i++) f.sample(15, { targetFps: 15 });
  assert.equal(f.counts().reconnected, 0);
  for (let i = 0; i < 3; i++) f.sample(1);
  const next = {}; f.sample(0, { session: next, sampleSeconds: 0 });
  for (let i = 0; i < 6; i++) f.sample(0, { session: next });
  assert.equal(f.counts().reconnected, 0);
});
