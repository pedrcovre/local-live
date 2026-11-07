const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Preferences } = require('../src/preferences.cjs');
test('identidade e salas sobrevivem à reabertura; renovação invalida a chave antiga', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-live-prefs-'));
  try {
    const a = new Preferences(directory); const host = a.read().host;
    const invite = `ET1.${host.id}.${host.secret}`;
    a.remember(invite, 'Sala Pedro', 'smooth'); a.profile('Meu nome', 'fast');
    const b = new Preferences(directory);
    assert.deepEqual(b.read().host, host);
    assert.equal(require('../src/room-protocol.cjs').readInvite(b.read().rooms[0].invite).id, host.id);
    assert.equal(b.read().name, 'Meu nome');
    b.remember(invite, 'Sala renomeada', 'balanced'); assert.equal(b.read().rooms.length, 1);
    assert.notEqual(b.rotate().host.secret, host.secret);
    assert.equal(b.forget(host.id).rooms.length, 0);
    assert.equal(new Preferences(directory).read().rooms.length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('salas próprias mantêm a propriedade e nomes após reabrir', () => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'local-live-owned-'));
 try{const prefs=new Preferences(directory); const saved=prefs.createRoom('Noite de jogos').rooms[0]; assert.equal(saved.owned,true);prefs.remember(saved.invite,saved.name,'smooth');assert.equal(new Preferences(directory).read().rooms[0].owned,true);}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('falha de leitura não sobrescreve convites já salvos', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-live-prefs-'));
  try {
    const file = path.join(directory, 'local-live-preferences.json'); fs.writeFileSync(file, '{broken');
    assert.throws(() => new Preferences(directory)); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('armazenamento seguro indisponível permite salas temporárias e preserva o arquivo criptografado', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-live-locked-'));
  try {
    const file = path.join(directory, 'local-live-preferences.json');
    const original = JSON.stringify({ encrypted: true, data: 'unavailable' });
    fs.writeFileSync(file, original);
    const crypto = { decryptString() { throw new Error('Key unavailable'); } };
    const temporary = Preferences.open(directory, crypto);
    assert.match(temporary.read().storageError, /preservados/);
    const saved = temporary.createRoom('Sala temporária').rooms[0];
    temporary.profile('Pedro'); temporary.remember(saved.invite, saved.name);
    assert.equal(temporary.read().rooms[0].owned, true);
    assert.equal(temporary.read().name, 'Pedro');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(Preferences.open(directory, crypto).read().rooms.length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
