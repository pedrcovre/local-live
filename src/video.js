// Normalize the transmission to a real 1920x1080 frame, preserving aspect ratio.
// Smaller sources are scaled without extra detail; fixed pacing repeats frames explicitly.
export async function normalizeVideo(raw, options = {}) {
  if (options.fps) return fixedVideo(raw, options);
  const track = raw.getVideoTracks()[0];
  const settings = track.getSettings();
  if (settings.width === 1920 && settings.height === 1080) return { stream: raw, cleanup: () => raw.getTracks().forEach(t => t.stop()) };
  const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = raw;
  video.className = 'capture-source'; document.body.append(video);
  await video.play();
  const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
  const ctx = canvas.getContext('2d', { alpha: false });
  const normalized = canvas.captureStream(0);
  const output = normalized.getVideoTracks()[0];
  let running = true; let callback;
  function draw() {
    if (!running) return;
    const width = video.videoWidth, height = video.videoHeight;
    if (width && height) {
      const scale = Math.min(1920 / width, 1080 / height), w = width * scale, h = height * scale;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1920, 1080);
      ctx.drawImage(video, (1920 - w) / 2, (1080 - h) / 2, w, h); output.requestFrame();
    }
    callback = video.requestVideoFrameCallback(draw);
  }
  draw();
  track.addEventListener('ended', () => { output.stop(); output.dispatchEvent(new Event('ended')); });
  return { stream: normalized, cleanup: () => { running = false; video.cancelVideoFrameCallback(callback); video.pause(); video.srcObject = null; video.remove(); normalized.getTracks().forEach(t => t.stop()); raw.getTracks().forEach(t => t.stop()); } };
}

async function fixedVideo(raw, { fps, onStats = () => {}, onError = () => {}, width = 1920, height = 1080 }) {
  if (![15, 30, 60, 120, 144].includes(fps)) throw new Error('FPS inválido.');
  if (typeof MediaStreamTrackProcessor !== 'function' || typeof MediaStreamTrackGenerator !== 'function') throw new Error('Este sistema não oferece o gerador necessário para a cadência fixa.');
  const source = raw.getVideoTracks()[0];
  // This request targets the real source too; pacing cannot create new motion.
  let sourceWarning = '';
  try { await source.applyConstraints({ frameRate: { min: fps, ideal: fps, max: fps } }); }
  catch { sourceWarning = `A captura não aceitou ${fps} fps mínimos; a cadência será completada repetindo o último quadro.`; }
  const processor = new MediaStreamTrackProcessor({ track: source, maxBufferSize: 1 });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  generator.contentHint = 'motion';
  const stream = new MediaStream([generator]);
  const worker = new Worker('./video-worker.js');
  let stopped = false;
  const cleanup = () => {
    if (stopped) return; stopped = true;
    worker.terminate(); generator.stop(); raw.getTracks().forEach(track => track.stop());
  };
  const fail = message => { if (stopped) return; cleanup(); generator.dispatchEvent(new Event('ended')); onError(message); };
  worker.onmessage = ({ data }) => {
    if (stopped) return;
    if (data.type === 'stats') onStats({ ...data, sourceWarning });
    if (data.type === 'error') fail(`Falha na cadência de vídeo: ${data.message}`);
    if (data.type === 'ended') fail('A fonte de vídeo foi encerrada.');
  };
  worker.onerror = event => fail(event.message || 'Falha no processamento de vídeo.');
  source.addEventListener('ended', () => fail('A fonte de vídeo foi encerrada.'), { once: true });
  try { worker.postMessage({ readable: processor.readable, writable: generator.writable, fps, width, height }, [processor.readable, generator.writable]); }
  catch (error) { cleanup(); throw error; }
  return { stream, cleanup, sourceWarning };
}
