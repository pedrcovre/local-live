// Media clocks can keep advancing while a backgrounded decoder delivers 1 FPS.
// Use measured decoded FPS, not just currentTime, and avoid reconnect storms.
class PlaybackRecovery {
  constructor({ rebind, reconnect, now = () => performance.now() }) {
    Object.assign(this, { rebind, reconnect, now });
    this.foreground = true; this.lastReconnect = -Infinity; this.lastResume = -Infinity;
    this.track(null);
  }
  track(session) {
    if (session === this.session) return;
    this.session = session; this.startedAt = this.now(); this.resumedAt = this.startedAt;
    this.lowSamples = 0; this.healthy = false; this.returned = false;
  }
  suspend() { this.foreground = false; this.lowSamples = 0; }
  resume() {
    this.foreground = true;
    const now = this.now(); if (now - this.lastResume < 750) return;
    this.lastResume = now; this.resumedAt = now; this.lowSamples = 0;
    this.returned = !!this.session; this.rebind();
  }
  observe({ session, fps, targetFps, sampleSeconds, visible }) {
    this.track(session);
    if (!session || !visible || !this.foreground || !(sampleSeconds > 0) || !Number.isFinite(fps)) { this.lowSamples = 0; return; }
    const target = Math.max(1, targetFps || 30);
    if (fps >= Math.min(15, target / 2)) { this.healthy = true; this.lowSamples = 0; return; }
    if ((!this.healthy && !this.returned) || this.now() - this.resumedAt < 4000) return;
    if (fps > Math.max(2, Math.min(5, target / 5))) { this.lowSamples = 0; return; }
    this.lowSamples++;
    if (this.lowSamples === 2) this.rebind();
    if (this.lowSamples >= 4 && this.now() - this.lastReconnect >= 30000) {
      this.lastReconnect = this.now(); this.lowSamples = 0; this.reconnect();
    }
  }
}
module.exports = { PlaybackRecovery };
