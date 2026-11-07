const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const crypto = require('node:crypto');
const run = promisify(execFile);

function discordFilter(processes, platform) {
  const discord = processes.filter(p => platform === 'win32' ? /^discord(?:canary|ptb)?\.exe$/i.test(p.name) : /\/Discord(?: Canary| PTB)?\.app\/Contents\//i.test(p.name));
  if (!discord.length) throw new Error('Abra o aplicativo Discord e entre na chamada antes de iniciar o áudio sem retorno. Discord no navegador não é compatível com este filtro.');
  if (platform === 'win32') {
    const ids = new Set(discord.map(p => p.pid));
    const roots = discord.filter(p => !ids.has(p.parent));
    if (roots.length !== 1) throw new Error('Há mais de uma instância independente do Discord. Feche as extras para filtrar a chamada com segurança.');
    return [roots[0].pid]; // WASAPI excludes this process and its descendants.
  }
  return [...new Set(discord.map(p => p.pid))].sort((a, b) => a - b);
}
function nativeDirectory(app) {
  const platform = process.platform === 'darwin' ? 'mac' : 'win';
  return app.isPackaged ? path.join(process.resourcesPath, 'native-audio') : path.join(__dirname, '../native-audio', `${platform}-${process.arch}`);
}
async function discordProcesses(app) {
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='Discord.exe' OR Name='DiscordCanary.exe' OR Name='DiscordPTB.exe'\" | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 7000, maxBuffer: 512000 });
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(rows) ? rows : [rows]).map(p => ({ pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name }));
  }
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5000, maxBuffer: 2000000 });
  const { stdout: audioJSON } = await run(path.join(nativeDirectory(app), 'audio-processes'), [], { timeout: 5000 });
  const audioObjects = JSON.parse(audioJSON);
  return stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).map(m => ({ pid: Number(m[1]), parent: Number(m[2]), name: m[3], audioObject: audioObjects.find(p => p.pid === Number(m[1]))?.audioObject })).filter(p => p.audioObject);
}
function pcmStereo(buffer, meta) {
  if (meta.sampleRate !== 48000 || ![1, 2].includes(meta.channelsPerFrame) || ![16, 32].includes(meta.bitsPerChannel)) throw new Error('Formato de áudio não suportado pelo filtro.');
  const channels = meta.channelsPerFrame, bytes = meta.bitsPerChannel / 8;
  const frames = Math.floor(buffer.byteLength / bytes / channels);
  if (frames > 48000) throw new Error('Bloco de áudio excessivo.');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const result = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) {
    const offset = (i * channels + Math.min(c, channels - 1)) * bytes;
    const sample = meta.isFloat && bytes === 4 ? view.getFloat32(offset, true) : bytes === 2 ? view.getInt16(offset, true) / 32768 : view.getInt32(offset, true) / 2147483648;
    result[i * 2 + c] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  }
  return result;
}
class DiscordAudio {
  constructor({ factory, processes, platform = process.platform, emit, monitorMs = 1500, retryMs = 1000, stallMs = 15000, now = Date.now }) {
    Object.assign(this, { factory, processes, platform, emit, monitorMs, retryMs, stallMs, now }); this.generation = 0;
  }
  filterFor(rows) {
    let filter = [];
    try { filter = discordFilter(rows, this.platform); } catch (error) {
      if (rows.some(p => /discord/i.test(p.name))) throw error;
    }
    if (this.platform === 'darwin') {
      const own = rows.filter(p => /\/Local Live\.app\/Contents\//.test(p.name) && p.pid !== process.pid).map(p => p.pid);
      return [...new Set([...filter, ...own])].sort((a, b) => a - b);
    }
    return filter.length ? filter : [process.pid];
  }
  async start() {
    this.stop(); const gen = this.generation;
    this.session = crypto.randomUUID(); this.attempt = 0;
    try { await this.open(gen); } catch (error) { if (gen === this.generation) this.recover(error, gen); }
    if (gen !== this.generation) throw new Error('Captura cancelada.');
    return { session: this.session, state: this.recorder ? 'ready' : 'recovering' };
  }
  async open(gen) {
    const opening = {}; this.opening = opening;
    let rows;
    try { rows = await this.processes(); } catch (error) { if (gen !== this.generation || this.opening !== opening) return; throw error; }
    if (gen !== this.generation || this.opening !== opening) return;
    const filter = this.filterFor(rows);
    const fingerprint = list => this.filterFor(list).map(pid => `${pid}:${list.find(p => p.pid === pid)?.audioObject || ''}`).join(',');
    const initial = fingerprint(rows);
    if (gen !== this.generation || this.opening !== opening) return;
    const recorder = this.factory(); this.recorder = recorder; this.meta = null;
    try { await recorder.startSystemAudio({ sampleRate: 48000, chunkDurationMs: 20, stereo: true, mute: false, emitSilence: true, excludeProcesses: filter }); }
    catch (error) {
      let detail; try { detail = recorder.processEvents().find(e => e.type === 3)?.message; } catch {}
      if (gen !== this.generation || this.opening !== opening) { try { recorder.stop(); } catch {} return; }
      if (this.recorder === recorder) this.closeRecorder();
      throw new Error(detail ? `${error.message}: ${detail}` : error.message);
    }
    if (gen !== this.generation || this.recorder !== recorder || this.opening !== opening) { recorder.stop(); return; }
    this.lastPCM = this.now(); this.openedAt = this.now();
    this.emit({ type: 'status', state: 'ready', session: this.session });
    this.poll = setInterval(() => {
      if (gen !== this.generation || this.recorder !== recorder) return;
      try {
        for (const event of recorder.processEvents()) {
          if (event.type === 4) this.meta = event;
          if (event.type === 3) throw new Error(event.message || 'A captura de áudio foi interrompida.');
          if (event.type === 0 && event.data?.byteLength && this.meta) { this.lastPCM = this.now(); if (this.lastPCM - this.openedAt > 5000) this.attempt = 0; this.emit({ type: 'pcm', session: this.session, samples: pcmStereo(event.data, this.meta) }); }
        }
      } catch (error) { this.recover(error, gen); }
    }, 10);
    let checking = false;
    this.monitor = setInterval(async () => {
      if (checking || gen !== this.generation || this.recorder !== recorder) return; checking = true;
      try {
        const next = fingerprint(await this.processes());
        if (gen !== this.generation || this.recorder !== recorder) return;
        if (next !== initial) this.recover(new Error('Atualizando o filtro de áudio após uma mudança de processo.'), gen);
        else if (this.now() - this.lastPCM > this.stallMs && this.now() - (this.lastStall || 0) > 30000) { this.lastStall = this.now(); this.recover(new Error('Reconectando a fonte de áudio sem resposta.'), gen); }
      } catch (error) { if (gen === this.generation && this.recorder === recorder) this.recover(error, gen); }
      finally { checking = false; }
    }, this.monitorMs);
  }
  recover(error, gen = this.generation) {
    if (gen !== this.generation || !this.session) return;
    this.closeRecorder(); clearTimeout(this.retry);
    this.emit({ type: 'status', state: 'recovering', session: this.session, message: error.message });
    const delay = Math.min(30000, this.retryMs * 2 ** Math.min(this.attempt++, 5));
    this.retry = setTimeout(() => { this.retry = null; if (gen === this.generation) this.open(gen).catch(next => this.recover(next, gen)); }, delay);
  }
  restart() { if (this.session && !this.retry) this.recover(new Error('Reconectando o áudio da transmissão.')); }
  closeRecorder() {
    this.opening = null;
    clearInterval(this.poll); clearInterval(this.monitor); this.poll = this.monitor = null;
    const recorder = this.recorder; this.recorder = null; this.meta = null;
    if (recorder) try { recorder.stop(); } catch {}
  }
  stop() { this.generation++; clearTimeout(this.retry); this.retry = null; this.closeRecorder(); this.session = null; }
}
function nativeFactory(app) {
  const base = nativeDirectory(app);
  if (process.platform === 'win32') return new (require('./windows-audio.cjs').WindowsAudio)(path.join(base, 'local-live-audio.exe'));
  const { AudioRecorderNative } = require(path.join(base, 'native_audio.node'));
  return new AudioRecorderNative();
}
module.exports = { DiscordAudio, discordFilter, discordProcesses, pcmStereo, nativeFactory };
