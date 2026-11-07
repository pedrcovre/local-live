import Peer from 'peerjs';
import { readInvite } from './room-protocol.cjs';

// Availability probes never join the room, subscribe to media or ask for capture.
export class RoomPresence extends EventTarget {
  constructor(options = {}) {
    super(); this.options = options; this.rooms = new Map(); this.states = new Map(); this.revision = 0; this.closed = false;
    this.interval = setInterval(() => this.refresh(), 30000);
  }
  state(id) { return id === this.connected ? 'online' : this.states.get(id) || 'checking'; }
  changed() { this.dispatchEvent(new Event('change')); }
  track(rooms, connected) {
    const connectedChanged = this.connected !== connected;
    this.connected = connected;
    const entries = rooms.flatMap(room => { try { return [[room.id, readInvite(room.invite)]]; } catch { return []; } });
    const signature = JSON.stringify(entries);
    if (signature === this.signature && !connectedChanged) return;
    this.signature = signature; this.rooms = new Map(entries); this.revision++;
    for (const id of this.states.keys()) if (!this.rooms.has(id)) this.states.delete(id);
    this.refresh();
  }
  async client() {
    if (this.peer?.open) return this.peer;
    if (this.opening) return this.opening;
    this.peer?.destroy();
    const peer = this.peer = new Peer(crypto.randomUUID(), { host: '0.peerjs.com', port: 443, secure: true, debug: 0,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }, ...this.options });
    // Connection failures are reflected in the sidebar, never in room notices.
    peer.on('error', () => {});
    this.opening = new Promise(resolve => {
      const done = value => { clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => done(null), 10000);
      peer.once('open', () => done(peer)); peer.once('disconnected', () => done(null));
      peer.once('close', () => done(null));
      peer.on('error', error => { if (!peer.open && error.type !== 'peer-unavailable') done(null); });
    });
    try { return await this.opening; } finally { this.opening = null; }
  }
  probe(peer, identity) {
    return new Promise(resolve => {
      const connection = peer.connect(identity.id, { reliable: true, serialization: 'json' });
      if (!connection) return resolve('offline');
      let settled = false;
      const finish = state => { if (settled) return; settled = true; clearTimeout(timer); try { connection.close(); } catch {} resolve(state); };
      const nonce = crypto.randomUUID();
      const timer = setTimeout(() => finish('offline'), 6000);
      connection.on('open', () => { try { connection.send({ type: 'presence', version: 2, secret: identity.secret, nonce }); } catch { finish('offline'); } });
      connection.on('data', data => {
        if (data?.type === 'presence' && data.nonce === nonce) finish(data.online === true ? 'online' : 'offline');
        // Older room owners reject the probe as an unsupported message. This
        // still confirms that the room is reachable, without adding a member.
        else if (data?.type === 'denied') finish('online');
      });
      connection.on('error', () => finish('offline')); connection.on('close', () => finish('offline'));
    });
  }
  async refresh() {
    if (this.closed || this.running || !this.rooms.size) return;
    this.running = true;
    const revision = this.revision;
    try {
      const peer = await this.client();
      const entries = [...this.rooms]; let index = 0;
      await Promise.all(Array.from({ length: Math.min(3, entries.length) }, async () => {
        while (!this.closed && revision === this.revision && index < entries.length) {
          const [id, identity] = entries[index++];
          const state = id === this.connected ? 'online' : peer?.open ? await this.probe(peer, identity) : 'unknown';
          if (!this.closed && revision === this.revision) { this.states.set(id, state); this.changed(); }
        }
      }));
    } catch {
      if (!this.closed) { for (const id of this.rooms.keys()) this.states.set(id, 'unknown'); this.changed(); }
    } finally { this.running = false; if (!this.closed && revision !== this.revision) this.refresh(); }
  }
  destroy() { this.closed = true; clearInterval(this.interval); this.peer?.destroy(); }
}
