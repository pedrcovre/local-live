const {test}=require('node:test'),assert=require('node:assert/strict');
const {inviteFor,readInvite,capsFor,qualityFor}=require('../src/room-protocol.cjs');
const identity={id:'01234567-89ab-4cde-8f01-23456789abcd',secret:'ab'.repeat(24)};
test('convite de sala preserva segredo, nome e identidade; aceita migração de ET1',()=>{const invite=inviteFor(identity,'Sala de amigos');assert.deepEqual(readInvite(invite),{...identity,name:'Sala de amigos'});assert.equal(readInvite(`ET1.${identity.id}.${identity.secret}`).secret,identity.secret);for(const bad of ['https://example.com','locallive://sala/abc','locallive://outro/abc'])assert.throws(()=>readInvite(bad));});
test('qualidade/FPS solicitados nunca ultrapassam a fonte',()=>{const caps=capsFor({height:720,fps:30});assert.deepEqual(qualityFor({height:1080,fps:144},caps),{height:720,fps:30});assert.deepEqual(qualityFor({height:480,fps:15},caps),{height:480,fps:15});assert.equal(capsFor({height:2160,fps:60}),null);});
