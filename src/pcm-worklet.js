class PCMPlayer extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(48000); this.read = 0; this.write = 0; this.count = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.reset) { this.read = this.write = this.count = 0; return; }
      if (!(data instanceof Float32Array)) return;
      // Bound latency to 120 ms instead of accumulating an ever-growing echo delay.
      if (this.count + data.length > 11520) { this.read = this.write; this.count = 0; }
      for (const sample of data) { this.buffer[this.write] = sample; this.write = (this.write + 1) % this.buffer.length; this.count++; }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    for (let i = 0; i < out[0].length; i++) {
      if (this.count >= 2) {
        out[0][i] = this.buffer[this.read]; this.read = (this.read + 1) % this.buffer.length;
        out[1][i] = this.buffer[this.read]; this.read = (this.read + 1) % this.buffer.length; this.count -= 2;
      } else { out[0][i] = 0; out[1][i] = 0; }
    }
    return true;
  }
}
registerProcessor('local-live-pcm', PCMPlayer);
