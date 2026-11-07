const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseInvite, cleanName, validProfile } = require('./protocol.cjs');
const { readInvite, inviteFor } = require('./room-protocol.cjs');
const identity = () => ({ id: crypto.randomUUID(), secret: crypto.randomBytes(24).toString('hex') });
const initialState = () => ({ host: identity(), rooms: [], lastRoom: '', name: '', profile: 'smooth' });
class Preferences {
  static open(directory, safeStorage) {
    try { return new Preferences(directory, safeStorage); }
    catch {
      // Preserve unreadable data. This session can still use rooms in memory;
      // it must never overwrite invitations whose encryption key is unavailable.
      const temporary = Object.create(Preferences.prototype);
      temporary.state = initialState();
      temporary.storageError = 'Não foi possível abrir as salas salvas. Seus dados foram preservados. As salas desta sessão não serão salvas; reabra o aplicativo quando o armazenamento seguro estiver disponível.';
      temporary.save = () => {};
      return temporary;
    }
  }
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'local-live-preferences.json');
    this.crypto = safeStorage;
    this.state = initialState();
    if (fs.existsSync(this.file)) {
      const envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const json = envelope.encrypted ? safeStorage.decryptString(Buffer.from(envelope.data, 'base64')) : envelope.data;
      const data = JSON.parse(json);
      parseInvite(`ET1.${data.host.id}.${data.host.secret}`);
      this.state = { ...this.state, ...data, rooms: Array.isArray(data.rooms) ? data.rooms.slice(0, 30) : [] };
      for (const room of this.state.rooms) readInvite(room.invite);
    } else this.save();
  }
  save() {
    const encrypted = !!this.crypto?.isEncryptionAvailable();
    const json = JSON.stringify(this.state);
    const envelope = { encrypted, data: encrypted ? this.crypto.encryptString(json).toString('base64') : json };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(envelope), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  read() { return { ...JSON.parse(JSON.stringify(this.state)), ...(this.storageError ? { storageError: this.storageError } : {}) }; }
  remember(invite, name, profile) {
    const parsed = readInvite(invite);
    const room = { id: parsed.id, invite: inviteFor(parsed, name || parsed.name), name: cleanName(name) || parsed.name, owned: this.state.rooms.find(r => r.id === parsed.id)?.owned === true, profile: validProfile(profile) ? profile : 'smooth' };
    this.state.rooms = [room, ...this.state.rooms.filter(r => r.id !== room.id)].slice(0, 30);
    this.state.lastRoom = room.id; this.save(); return this.read();
  }
  createRoom(name) { const host = identity(); this.remember(inviteFor(host, name), name, 'smooth'); this.state.rooms[0].owned = true; this.save(); return this.read(); }
  forget(id) { this.state.rooms = this.state.rooms.filter(r => r.id !== id); if (this.state.lastRoom === id) this.state.lastRoom = this.state.rooms[0]?.id || ''; this.save(); return this.read(); }
  profile(name, profile) { this.state.name = cleanName(name); if (validProfile(profile)) this.state.profile = profile; this.save(); return this.read(); }
  rotate() { this.state.host = identity(); this.save(); return this.read(); }
}
module.exports = { Preferences };
