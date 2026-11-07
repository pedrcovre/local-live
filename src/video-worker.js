// Pace frames independently of the preview's monitor refresh rate.
let running = true;
self.onmessage = async ({ data }) => {
  if (data.type === 'stop') { running = false; return; }
  const { readable, writable, fps, width = 1920, height = 1080 } = data;
  const reader = readable.getReader(), writer = writable.getWriter();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false });
  let latest, serial = 0, drawn = -1, sentSerial = -1;
  let sourceFrames = 0, outputFrames = 0, repeatedFrames = 0, missed = 0;
  let processingMs = 0, waitingMs = 0;
  let measuredAt = performance.now(), firstTimestamp, base, tick = 0;
  const interval = 1000 / fps;
  const reading = (async () => {
    while (running) {
      const { value, done } = await reader.read();
      if (done) { running = false; break; }
      latest?.close(); latest = value; serial++; sourceFrames++;
      if (firstTimestamp === undefined) firstTimestamp = value.timestamp;
    }
  })();
  reading.catch(error => { running = false; self.postMessage({ type: 'error', message: error.message }); });
  try {
    while (running && !latest) await new Promise(resolve => setTimeout(resolve, 2));
    base = performance.now();
    while (running) {
      const deadline = base + tick * interval;
      const remaining = deadline - performance.now();
      if (remaining > 0) { await new Promise(resolve => setTimeout(resolve, remaining)); continue; }
      if (!running || !latest) break;
      const processingStart = performance.now();
      if (drawn !== serial) {
        const w = latest.displayWidth, h = latest.displayHeight;
        const scale = Math.min(width / w, height / h);
        context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
        context.drawImage(latest, (width - w * scale) / 2, (height - h * scale) / 2, w * scale, h * scale);
        drawn = serial;
      }
      const currentSerial = serial;
      const frame = new VideoFrame(canvas, { timestamp: Math.round(firstTimestamp + tick * interval * 1000), duration: Math.round(interval * 1000) });
      processingMs += performance.now() - processingStart;
      const writeStart = performance.now();
      try { await writer.write(frame); } finally { frame.close(); }
      waitingMs += performance.now() - writeStart;
      outputFrames++; if (sentSerial === currentSerial) repeatedFrames++;
      sentSerial = currentSerial; tick++;
      // Do not queue a burst of old frames when the encoder cannot keep up.
      const currentTick = Math.floor((performance.now() - base) / interval);
      if (currentTick > tick) { missed += currentTick - tick; tick = currentTick; }
      const now = performance.now(), seconds = (now - measuredAt) / 1000;
      if (seconds >= 1) {
        self.postMessage({ type: 'stats', sourceFps: sourceFrames / seconds, outputFps: outputFrames / seconds, repeatedFps: repeatedFrames / seconds, missed, targetFps: fps, processingMs, waitingMs });
        sourceFrames = outputFrames = repeatedFrames = missed = 0; measuredAt = now;
        processingMs = waitingMs = 0;
      }
    }
    if (running === false) self.postMessage({ type: 'ended' });
  } catch (error) { if (running) self.postMessage({ type: 'error', message: error.message }); }
  finally { running = false; latest?.close(); await reader.cancel().catch(() => {}); await writer.close().catch(() => {}); }
};
