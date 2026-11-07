const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PROFILES, parseInvite, validHello, encodingFor, cleanName, validProfile } = require('../src/protocol.cjs');
const id = '01234567-89ab-4cde-8f01-23456789abcd';
const secret = 'a'.repeat(48);
test('convites exigem UUID v4 e segredo de 192 bits', () => {
  assert.deepEqual(parseInvite(`ET1.${id}.${secret}`), { id, secret });
  for (const bad of ['', `ET1.${id}.123`, `ET1.${id}.${secret}.extra`, `ET1.${id.replace('-4', '-3')}.${secret}`, 42, '<script>']) assert.throws(() => parseInvite(bad));
});
test('autorização exige segredo, versão, nome e perfil válidos', () => {
  const good = { type: 'hello', version: 1, secret, name: 'Amigo', profile: 'smooth' };
  assert.equal(validHello(good, secret), true);
  for (const change of [{ secret: 'b'.repeat(48) }, { version: 2 }, { name: '' }, { profile: '__proto__' }, { type: 'approved' }]) assert.ok(!validHello({ ...good, ...change }, secret));
  assert.ok(!validProfile('toString'));
  assert.equal(cleanName('\nAmigo\u0000'), 'Amigo');
});
test('limites por receptor preservam proporção e respeitam orçamento e FPS de captura', () => {
  const settings = { width: 1920, height: 1080, frameRate: 60 };
  const low = encodingFor('light', settings, 60, 30, 3);
  assert.equal(low.scaleResolutionDownBy, 1.5);
  assert.equal(low.maxFramerate, 30);
  assert.equal(low.maxBitrate, 10000000);
  const high = encodingFor('ultra', settings, 60, 10, 4);
  assert.equal(high.maxFramerate, 60);
  assert.equal(high.maxBitrate * 4, 10000000);
  assert.equal(encodingFor('smooth', settings, 60, 100, 1).maxBitrate, 100000000);
  assert.equal(encodingFor('light', settings, 60, 100, 1, 'adaptive').maxBitrate, 2500000);
  const portrait = encodingFor('light', { width: 1080, height: 1920 }, 144, 30, 1);
  assert.ok(1920 / portrait.scaleResolutionDownBy <= 720);
  for (const key of Object.keys(PROFILES)) assert.ok(encodingFor(key, settings, 60, 30, 1).scaleResolutionDownBy >= 1);
});

test('cadência fixa mantém o pedido de 144 sem herdar o FPS da fonte; perfil menor continua respeitado', () => {
  const settings = { width: 1920, height: 1080, frameRate: 30 };
  assert.equal(encodingFor('ultra', settings, 144, 100, 1, 'strict', true).maxFramerate, 144);
  assert.equal(encodingFor('smooth', settings, 144, 100, 1, 'strict', true).maxFramerate, 60);
});
