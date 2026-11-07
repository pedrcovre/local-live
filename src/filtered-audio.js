// Recover native capture and Web Audio independently of the video connection.
export async function filteredAudio(onStatus = () => {}, onTrack = () => {}, desktop = window.desktop) {
  let lastClock = 0, clockStalls = 0;
  let context, node, destination, session, stopped = false, rebuilding = false, removeListener;
  const setStatus = (state, message = '') => onStatus({ state, message });
  async function graph() {
    context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } });
    await context.audioWorklet.addModule('./pcm-worklet.js');
    node = new AudioWorkletNode(context, 'local-live-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    destination = context.createMediaStreamDestination(); node.connect(destination);
    // Drive the processing graph through the verified silent sink; no samples
    // are rendered to the physical speakers of the transmitter.
    if (context.sinkId?.type === 'none') node.connect(context.destination);
    await context.resume(); lastClock = context.currentTime; clockStalls = 0;
    node.onprocessorerror = () => rebuild();
    context.onstatechange = () => { if (stopped) return; if (context.state === 'closed') rebuild(); else if (context.state !== 'running') context.resume().catch(() => {}); };
  }
  async function rebuild() {
    if (stopped || rebuilding) return; rebuilding = true; setStatus('recovering', 'Restaurando o áudio da transmissão…');
    const oldContext = context, oldTrack = destination?.stream.getAudioTracks()[0];
    try {
      oldContext.onstatechange = null; node?.disconnect(); await oldContext.close().catch(() => {});
      await graph(); if (stopped) { context.onstatechange = null; node.disconnect(); destination.stream.getTracks().forEach(t => t.stop()); await context.close().catch(() => {}); return; }
      await onTrack(destination.stream.getAudioTracks()[0]); oldTrack?.stop(); setStatus('ready');
    } catch (error) { setStatus('recovering', error.message); }
    finally { rebuilding = false; }
  }
  const cleanup = () => {
    if (stopped) return; stopped = true; clearInterval(health); removeListener?.();
    if (context) context.onstatechange = null; node?.disconnect(); destination?.stream.getTracks().forEach(t => t.stop()); context?.close().catch(() => {});
    if (session) desktop.audioStop(session).catch(() => {});
  };
  let health;
  try {
    await graph();
    removeListener = desktop.onAudio(packet => {
      if (stopped || packet.session !== session) return;
      if (packet.type === 'pcm') node?.port.postMessage(packet.samples);
      else if (packet.type === 'status') { if (packet.state === 'recovering') node?.port.postMessage({ reset: true }); setStatus(packet.state, packet.message); }
    });
    const started = await desktop.audioStart(); session = started.session; setStatus(started.state || 'ready');
    health = setInterval(() => {
      if (stopped) return;
      if (context.state === 'closed') rebuild();
      else if (context.state !== 'running') context.resume().catch(() => {});
      else { clockStalls = context.currentTime <= lastClock ? clockStalls + 1 : 0; lastClock = context.currentTime; if (clockStalls >= 3) rebuild(); }
      if (destination.stream.getAudioTracks()[0].readyState === 'ended') rebuild();
    }, 2000);
    return { get track() { return destination.stream.getAudioTracks()[0]; }, cleanup, repair: () => desktop.audioRepair(session), context: () => context, rebuild };
  } catch (error) { cleanup(); throw error; }
}
