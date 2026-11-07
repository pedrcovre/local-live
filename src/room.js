import Peer from 'peerjs';
import { preferH264 } from './codecs.cjs';
import { cleanName } from './protocol.cjs';
import { validId, inviteFor, readInvite, capsFor, qualityFor } from './room-protocol.cjs';
const token = () => [...crypto.getRandomValues(new Uint8Array(24))].map(v => v.toString(16).padStart(2, '0')).join('');
const send = (conn, data) => { if (conn?.open) { try { conn.send(data); } catch {} } };
export class Room extends EventTarget {
  constructor(peerOptions = {}) {
    super(); this.peerOptions = peerOptions; this.members = new Map(); this.watchers = new Map(); this.grants = new Map(); this.pending = new Set(); this.timers = new Set(); this.previous = new Map(); this.epoch = 0;
    this.statsTimer = setInterval(() => this.stats(), 2000);
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  notice(message) { this.emit('notice', message); }
  later(fn, delay) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, delay); this.timers.add(timer); return timer; }
  changed() { this.emit('members', [...this.members.values()].map(({ id, name, caps }) => ({ id, name, caps, self: id === this.id }))); }
  async connect(id) {
    const epoch = this.epoch;
    const peer = new Peer(id, { host: '0.peerjs.com', port: 443, secure: true, debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }, ...this.peerOptions });
    this.peer = peer; peer.on('connection', conn => this.accept(conn)); peer.on('call', call => this.incomingCall(call));
    peer.on('disconnected', () => { this.notice('Reconectando o serviço de salas…'); this.later(() => { if (this.peer === peer && !peer.destroyed) peer.reconnect(); }, 2000); });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Não foi possível conectar a sala. Verifique a internet e tente novamente.')), 18000);
      peer.once('open', () => { clearTimeout(timeout); resolve(); });
      peer.on('error', error => { clearTimeout(timeout); if (!peer.open) reject(new Error(error.type === 'unavailable-id' ? 'Esta sala já está aberta em outro aplicativo.' : `Falha ao conectar (${error.type || 'rede'}).`)); else this.notice(error.type === 'peer-unavailable' ? 'A sala está offline. Quem criou a sala precisa abri-la no Local Live.' : `Conexão: ${error.type || 'falha de rede'}.`); });
    });
    if (epoch !== this.epoch) throw new Error('Entrada cancelada.');
  }
  async create(identity, roomName, name) {
    this.leave(); this.isOwner = true; this.identity = identity; this.id = identity.id; this.name = cleanName(name) || 'Você'; this.roomName = cleanName(roomName) || 'Sala de amigos'; this.invite = inviteFor(identity, this.roomName); this.active = true;
    try { await this.connect(this.id); this.members.set(this.id, { id: this.id, name: this.name, caps: null }); this.changed(); this.emit('joined', { name: this.roomName, invite: this.invite, owner: true }); }
    catch (error) { this.leave(); throw error; }
  }
  async join(invite, name) {
    const identity = readInvite(invite); this.leave(); this.identity = identity; this.id = crypto.randomUUID(); this.name = cleanName(name) || 'Visitante'; this.roomName = identity.name; this.invite = inviteFor(identity, identity.name); this.active = true; this.isOwner = false;
    try {
      await this.connect(this.id);
      await new Promise((resolve, reject) => {
        const control = this.peer.connect(identity.id, { reliable: true, serialization: 'json' }); this.control = control;
        const timeout = setTimeout(() => reject(new Error('A sala está offline ou a rede bloqueou a conexão direta.')), 22000);
        control.on('open', () => send(control, { type: 'hello', version: 2, secret: identity.secret, name: this.name }));
        control.on('data', data => {
          if (this.control !== control) return;
          if (data?.type === 'welcome') { clearTimeout(timeout); this.roomName = cleanName(data.name) || identity.name; this.invite = inviteFor(identity, this.roomName); this.receive(data); this.emit('joined', { name: this.roomName, invite: this.invite, owner: false }); resolve(); }
          else if (data?.type === 'denied') { clearTimeout(timeout); reject(new Error(data.message || 'Convite inválido.')); }
          else this.receive(data);
        });
        control.on('close', () => { clearTimeout(timeout); if (this.control === control) { this.leave(); this.notice('A sala foi fechada. Suas salas salvas continuam disponíveis.'); reject(new Error('A sala foi fechada.')); } });
        control.on('error', () => { clearTimeout(timeout); reject(new Error('Não foi possível entrar na sala.')); });
      });
    } catch (error) { this.leave(); throw error; }
  }
  accept(conn) {
    if (!this.isOwner || this.members.size + this.pending.size >= 12) return conn.close();
    this.pending.add(conn); let authenticated = false;
    const expiry = this.later(() => { if (!authenticated) { this.pending.delete(conn); conn.close(); } }, 12000);
    conn.on('data', data => {
      if (!this.active || !data || typeof data !== 'object') return;
      if (!authenticated) {
        if (data.type !== 'hello' || data.version !== 2 || data.secret !== this.identity.secret || !cleanName(data.name) || !validId(conn.peer) || this.members.has(conn.peer)) { send(conn, { type: 'denied', message: 'Convite inválido ou aplicativo desatualizado.' }); conn.close(); return; }
        authenticated = true; clearTimeout(expiry); this.pending.delete(conn);
        this.members.set(conn.peer, { id: conn.peer, name: cleanName(data.name), caps: null, conn });
        send(conn, { type: 'welcome', name: this.roomName, members: this.roster() }); this.broadcastRoster(); return;
      }
      this.fromMember(conn.peer, data);
    });
    const closed = () => { this.pending.delete(conn); if (this.members.get(conn.peer)?.conn === conn) this.removeMember(conn.peer); };
    conn.on('close', closed); conn.on('error', closed);
  }
  roster() { return [...this.members.values()].map(({ id, name, caps }) => ({ id, name, caps })); }
  broadcastRoster() { const message = { type: 'roster', members: this.roster() }; for (const member of this.members.values()) if (member.conn) send(member.conn, message); this.changed(); }
  toOwner(data) { if (!this.active) return; if (this.isOwner) this.fromMember(this.id, data); else send(this.control, data); }
  route(id, data) { if (id === this.id) this.receive(data); else send(this.members.get(id)?.conn, data); }
  fromMember(id, data) {
    const member = this.members.get(id); if (!member) return;
    if (data.type === 'publish') { member.caps = capsFor(data.caps); this.broadcastRoster(); if (!member.caps) this.closeSubscriptions(id); }
    if (data.type === 'unwatch') this.releaseGrant(id);
    if (data.type === 'subscribe') {
      const publisher = this.members.get(data.publisher); if (!publisher?.caps || publisher.id === id) return;
      this.releaseGrant(id); const grant = { publisher: publisher.id, token: token(), quality: qualityFor(data.quality, publisher.caps) }; this.grants.set(id, grant);
      this.route(id, { type: 'subscription', publisher: publisher.id, token: grant.token, quality: grant.quality, caps: publisher.caps });
    }
    if (data.type === 'ready-watch') {
      const grant = this.grants.get(id); if (grant?.token === data.token && grant.publisher === data.publisher) this.route(grant.publisher, { type: 'watcher', id, token: grant.token, quality: grant.quality });
    }
    if (data.type === 'quality') {
      const grant = this.grants.get(id), publisher = grant && this.members.get(grant.publisher);
      if (publisher?.caps) { grant.quality = qualityFor(data.quality, publisher.caps); this.route(grant.publisher, { type: 'watcher-quality', id, quality: grant.quality }); this.route(id, { type: 'quality', quality: grant.quality, caps: publisher.caps }); }
    }
    if (data.type === 'audio-state' && member.caps && ['ready','recovering'].includes(data.state)) { for (const [watcher,grant] of this.grants) if (grant.publisher === id) this.route(watcher,{type:'audio-state',state:data.state}); }
    if (data.type === 'repair-audio' && this.grants.has(id)) this.route(this.grants.get(id).publisher, { type: 'repair-audio' });
  }
  receive(data) {
    if (!data || typeof data !== 'object') return;
    if (['welcome', 'roster'].includes(data.type) && Array.isArray(data.members)) {
      const next = new Map();
      for (const member of data.members.slice(0, 12)) if (validId(member.id)) next.set(member.id, { id: member.id, name: cleanName(member.name) || 'Amigo', caps: capsFor(member.caps) });
      this.members = next; this.changed();
      if (this.watching && !next.get(this.watching)?.caps) this.unwatch(false);
    }
    if (data.type === 'subscription' && data.publisher === this.watching && /^[a-f\d]{48}$/.test(data.token)) { this.expected = { publisher: data.publisher, token: data.token }; this.applied = data.quality; this.emit('quality', { quality: data.quality, caps: data.caps }); this.toOwner({ type: 'ready-watch', publisher: data.publisher, token: data.token }); }
    if (data.type === 'watcher' && validId(data.id) && /^[a-f\d]{48}$/.test(data.token)) this.callWatcher(data);
    if (data.type === 'watcher-quality') { const watcher = this.watchers.get(data.id); if (watcher) { watcher.quality = qualityFor(data.quality, this.caps); this.apply(watcher); } }
    if (data.type === 'unwatcher') this.closeWatcher(data.id);
    if (data.type === 'stream-ended' && data.publisher === this.watching) this.unwatch(false);
    if (data.type === 'quality') { this.applied = data.quality; this.emit('quality', data); }
    if (data.type === 'repair-audio' && Date.now() - (this.lastPeerRepair || 0) > 10000) { this.lastPeerRepair = Date.now(); this.emit('repair-audio'); }
    if (data.type === 'audio-state') this.emit('audio-state', {state:data.state});
    if (data.type === 'closing') { this.leave(); this.notice('A sala foi encerrada por quem a criou.'); }
  }
  setBroadcast(stream, caps, budget = 30) {
    if (!this.active || !capsFor(caps)) throw new Error('Entre em uma sala antes de compartilhar.');
    this.stopBroadcast(); this.stream = stream; this.caps = capsFor(caps); this.budget = Math.max(5, Math.min(100, Number(budget) || 30));
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (this.stream === stream) this.stopBroadcast(); }, { once: true });
    this.toOwner({ type: 'publish', caps: this.caps }); this.emit('broadcast', { active: true, caps: this.caps });
  }
  stopBroadcast() {
    for (const id of [...this.watchers.keys()]) this.closeWatcher(id);
    const stream = this.stream; this.stream = null; this.caps = null; this.cadence = null;
    stream?.getTracks().forEach(track => track.stop());
    if (this.active) this.toOwner({ type: 'publish', caps: null });
    this.emit('broadcast', { active: false });
  }
  watch(id, quality) {
    const member = this.members.get(id); if (!member?.caps || id === this.id) return;
    this.unwatch(); this.watching = id; this.requested = qualityFor(quality, member.caps); this.toOwner({ type: 'subscribe', publisher: id, quality: this.requested }); this.emit('watching', { id, name: member.name, caps: member.caps });
  }
  unwatch(notify = true) {
    if (notify && this.active) this.toOwner({ type: 'unwatch' });
    const call = this.call; this.call = null; call?.close(); this.remoteStream?.getTracks().forEach(track => track.stop()); this.remoteStream = null;
    this.watching = null; this.expected = null; this.previous.delete('receive'); this.emit('unwatched');
  }
  quality(quality) { if (!this.watching) return; const caps = this.members.get(this.watching)?.caps; if (caps) this.toOwner({ type: 'quality', quality: qualityFor(quality, caps) }); }
  incomingCall(call) {
    if (!this.expected || call.peer !== this.expected.publisher || call.metadata?.room !== this.identity.id || call.metadata?.token !== this.expected.token || this.call) return call.close();
    this.call = call;
    call.on('stream', stream => { if (this.call === call) { this.remoteStream = stream; this.emit('stream', { stream, id: call.peer }); } });
    call.on('close', () => { if (this.call === call && this.watching) { const id = this.watching, quality = this.applied; this.unwatch(false); this.later(() => { if (this.members.get(id)?.caps) this.watch(id, quality); }, 1200); } });
    call.on('error', () => { if (this.call === call) this.notice('Reconectando esta transmissão…'); });
    call.answer(undefined, { sdpTransform: preferH264 });
  }
  callWatcher(data) {
    if (!this.stream || !this.caps) return;
    this.closeWatcher(data.id);
    const call = this.peer.call(data.id, this.stream, { metadata: { room: this.identity.id, token: data.token }, sdpTransform: preferH264 });
    if (!call) return;
    const watcher = { ...data, call, quality: qualityFor(data.quality, this.caps) }; this.watchers.set(data.id, watcher);
    call.peerConnection.addEventListener('connectionstatechange', () => { if (call.peerConnection.connectionState === 'connected') this.rebalance(); });
    call.on('close', () => { if (this.watchers.get(data.id) === watcher) { this.watchers.delete(data.id); this.rebalance(); } });
    call.on('error', () => this.closeWatcher(data.id)); this.rebalance();
  }
  async apply(watcher) {
    if (!this.stream || !this.caps) return;
    if (watcher.applying) { watcher.again = true; return; } watcher.applying = true;
    try {
      const sender = watcher.call.peerConnection.getSenders().find(s => s.track?.kind === 'video'); const params = sender?.getParameters(); if (!params?.encodings?.length) return;
      const quality = qualityFor(watcher.quality, this.caps); watcher.quality = quality;
      params.encodings[0].maxBitrate = Math.floor(this.budget * 1000000 / Math.max(1, this.watchers.size));
      params.encodings[0].maxFramerate = quality.fps;
      params.encodings[0].scaleResolutionDownBy = Math.max(1, this.caps.height / quality.height);
      params.degradationPreference = 'maintain-framerate-and-resolution';
      try { await sender.setParameters(params); } catch (error) { if (!(error instanceof TypeError)) throw error; params.degradationPreference = 'maintain-resolution'; await sender.setParameters(params); }
      watcher.encoding = { ...params.encodings[0] };
    } catch { this.notice('Ajustando a qualidade da conexão…'); }
    finally { watcher.applying = false; if (watcher.again) { watcher.again = false; this.apply(watcher); } }
  }
  rebalance() { for (const watcher of this.watchers.values()) this.apply(watcher); }
  async replaceAudio(track) {
    if (!this.stream) return;
    for (const old of this.stream.getAudioTracks()) this.stream.removeTrack(old);
    this.stream.addTrack(track);
    await Promise.all([...this.watchers.values()].map(async watcher => {
      const pc = watcher.call.peerConnection;
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio') || pc.getTransceivers().find(t => t.receiver.track.kind === 'audio')?.sender;
      if (sender) try { await sender.replaceTrack(track); } catch { this.closeWatcher(watcher.id); }
    }));
  }
  reportAudio(state) { if (this.stream) this.toOwner({type:'audio-state',state}); }
  requestAudioRepair() { if (this.watching && Date.now() - (this.lastRepair || 0) > 15000) { this.lastRepair = Date.now(); this.toOwner({ type: 'repair-audio' }); } }
  closeWatcher(id) { const watcher = this.watchers.get(id); this.watchers.delete(id); watcher?.call.close(); this.previous.delete(`send:${id}`); this.rebalance(); }
  releaseGrant(id) { const grant = this.grants.get(id); this.grants.delete(id); if (grant) this.route(grant.publisher, { type: 'unwatcher', id }); }
  closeSubscriptions(publisher) { for (const [id, grant] of this.grants) if (grant.publisher === publisher) { this.releaseGrant(id); this.route(id, { type: 'stream-ended', publisher }); } }
  removeMember(id) { this.releaseGrant(id); this.closeSubscriptions(id); this.members.delete(id); this.broadcastRoster(); }
  async stats() {
    if (this.statsBusy || !this.active) return; this.statsBusy = true; const epoch = this.epoch;
    try {
      const links = [...this.watchers.values()].map(w => [`send:${w.id}`, w.call.peerConnection, 'outbound-rtp']); if (this.call) links.push(['receive', this.call.peerConnection, 'inbound-rtp']);
      for (const [id, pc, direction] of links) {
        if (pc.connectionState !== 'connected') continue;
        const report = await pc.getStats(); let video, audio, pair;
        report.forEach(item => { if (item.type === direction && item.kind === 'video' && !item.isRemote) video = item; if (item.type === direction && item.kind === 'audio' && !item.isRemote) audio = item; if (item.type === 'transport' && item.selectedCandidatePairId) pair = report.get(item.selectedCandidatePairId); });
        if (!video || epoch !== this.epoch) continue;
        const previous = this.previous.get(id), frames = video.framesEncoded ?? video.framesDecoded ?? 0, bytes = video.bytesSent ?? video.bytesReceived ?? 0, elapsed = previous ? (video.timestamp - previous.time) / 1000 : 0;
        const audioBytes = audio?.bytesReceived ?? audio?.bytesSent ?? 0;
        const audioLast = !previous || audioBytes !== previous.audioBytes ? Date.now() : previous.audioLast;
        this.previous.set(id, { time: video.timestamp, frames, bytes, audioBytes, audioLast });
        if (id === 'receive' && this.remoteStream?.getAudioTracks().length && Date.now() - audioLast > 12000) this.requestAudioRepair();
        this.emit('stats', { id, fps: Math.round(elapsed > 0 ? (frames - previous.frames) / elapsed : video.framesPerSecond || 0), width: video.frameWidth || 0, height: video.frameHeight || 0, mbps: elapsed > 0 ? (bytes - previous.bytes) * 8 / elapsed / 1e6 : 0, rtt: Math.round((pair?.currentRoundTripTime || 0) * 1000), audioBytes, codec: report.get(video.codecId)?.mimeType || '' });
      }
    } catch {} finally { this.statsBusy = false; }
  }
  leave() {
    this.epoch++;
    if (this.isOwner) for (const member of this.members.values()) send(member.conn, { type: 'closing' });
    this.stopBroadcast(); this.unwatch(false); this.active = false;
    for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    const control = this.control; this.control = null; control?.close();
    const peer = this.peer; this.peer = null; peer?.destroy();
    this.members.clear(); this.grants.clear(); this.pending.clear(); this.previous.clear(); this.isOwner = false; this.changed(); this.emit('left');
  }
  destroy() { this.leave(); clearInterval(this.statsTimer); }
}
