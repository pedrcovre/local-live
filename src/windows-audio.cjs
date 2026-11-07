const { spawn } = require('node:child_process');
const STAGES = {
  ActivateAudioInterfaceAsync: 'ativar a captura por processo', GetActivateResult: 'ativar o filtro do Discord',
  Initialize: 'configurar o formato de áudio', GetService: 'abrir o capturador', Start: 'iniciar o áudio',
  'activation-timeout': 'aguardar a resposta do Windows', capture: 'receber o áudio',
};
class WindowsAudio {
  constructor(executable, launch = spawn) { this.executable = executable; this.launch = launch; this.events = []; this.pending = Buffer.alloc(0); }
  startSystemAudio(options) {
    const pids = options.excludeProcesses;
    if (!Array.isArray(pids) || pids.length !== 1 || !Number.isInteger(pids[0]) || pids[0] < 1) throw new Error('Processo do Discord inválido.');
    return new Promise((resolve, reject) => {
      let ready = false, settled = false, status = '';
      this.stopped = false;
      const child = this.launch(this.executable, [String(pids[0])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      const timer = setTimeout(() => failure(new Error('O Windows não respondeu ao iniciar o filtro de áudio.')), 15000);
      const failure = error => {
        if (this.stopped) return;
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
        else this.events.push({ type: 3, message: error.message });
        this.stop();
      };
      this.cancelStart = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Captura de áudio cancelada.')); } };
      child.on('error', error => failure(new Error(`Não foi possível abrir o capturador de áudio: ${error.message}`)));
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        if (this.stopped) return;
        this.pending = Buffer.concat([this.pending, chunk]);
        if (this.pending.length > 192000) return failure(new Error('O capturador enviou áudio sem inicialização válida.'));
        if (ready) this.flushPCM();
      });
      child.stderr.on('data', chunk => {
        if (this.stopped) return;
        status += chunk.toString('utf8');
        if (status.length > 16384) return failure(new Error('Resposta inválida do capturador de áudio.'));
        let newline;
        while ((newline = status.indexOf('\n')) >= 0) {
          const line = status.slice(0, newline); status = status.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { return failure(new Error('Resposta inválida do capturador de áudio.')); }
          if (message.type === 'error') return failure(new Error(`Falha ao ${STAGES[message.stage] || message.stage} (Windows ${message.hresult}).`));
          if (message.type === 'ready' && !ready) {
            if (message.sampleRate !== 48000 || message.channelsPerFrame !== 2 || message.bitsPerChannel !== 16 || message.isFloat !== false) return failure(new Error('Formato inesperado do capturador de áudio.'));
            this.events.push({ ...message, type: 4 });
            ready = true; settled = true; clearTimeout(timer); this.flushPCM(); resolve();
          }
        }
      });
      child.on('close', code => { clearTimeout(this.killTimer); if (!this.stopped) failure(new Error(`O capturador de áudio encerrou inesperadamente (código ${code}).`)); });
    });
  }
  flushPCM() {
    const bytes = 3840; // 20 ms, 48 kHz, stereo, 16-bit.
    while (this.pending.length >= bytes) {
      this.events.push({ type: 0, data: Buffer.from(this.pending.subarray(0, bytes)) });
      this.pending = this.pending.subarray(bytes);
    }
    // Keep at most 120 ms of media without dropping metadata/errors.
    let frames = this.events.filter(e => e.type === 0).length;
    this.events = this.events.filter(e => e.type !== 0 || frames-- <= 6);
  }
  processEvents() { const events = this.events; this.events = []; return events; }
  stop() {
    this.stopped = true; this.cancelStart?.(); this.cancelStart = null;
    this.pending = Buffer.alloc(0);
    const child = this.child; this.child = null;
    if (child) {
      child.stdin.end();
      this.killTimer = setTimeout(() => child.kill(), 500); this.killTimer.unref();
    }
  }
}
module.exports = { WindowsAudio };
