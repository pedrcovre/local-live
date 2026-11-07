const PROFILES = Object.freeze({
  economy: { label: '480p · 15 fps', width: 854, height: 480, fps: 15, bitrate: 800000 },
  light: { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 2500000 },
  balanced: { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 5000000 },
  smooth: { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 10000000 },
  fast: { label: '1080p · 120 fps (experimental)', width: 1920, height: 1080, fps: 120, bitrate: 18000000 },
  ultra: { label: '1080p · 144 fps (experimental)', width: 1920, height: 1080, fps: 144, bitrate: 22000000 }
});
function validProfile(key) { return typeof key === 'string' && Object.hasOwn(PROFILES, key); }
function cleanName(value) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : ''; }
function parseInvite(value) {
  if (typeof value !== 'string' || value.length > 220 || !/^ET1\.[a-zA-Z0-9-]{36}\.[a-f0-9]{48}$/.test(value.trim())) throw new Error('Cole o convite completo, começando com ET1.');
  const [, id, secret] = value.trim().split('.');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error('Convite inválido.');
  return { id, secret };
}
function validHello(data, secret) {
  return data && data.type === 'hello' && data.version === 1 && typeof data.secret === 'string' && data.secret === secret && !!cleanName(data.name) && validProfile(data.profile);
}
function encodingFor(key, settings, captureFps, capMbps, activeCount, mode = 'strict', fixedCadence = false) {
  const p = PROFILES[validProfile(key) ? key : 'light'];
  const count = Math.max(1, activeCount || 1);
  // In strict mode the selected upload is available to video, without a hidden profile ceiling.
  // Audio, control and retransmissions add overhead; this is not a traffic shaper.
  const budget = Math.max(200000, (Math.max(1, Number(capMbps) || 30) * 1000000) / count);
  return {
    maxBitrate: mode === 'adaptive' ? Math.min(p.bitrate, Math.floor(budget)) : Math.floor(budget),
    maxFramerate: Math.min(p.fps, captureFps || 60, fixedCadence ? captureFps : settings.frameRate || captureFps || 60),
    scaleResolutionDownBy: Math.max(1, (settings.width || 1920) / p.width, (settings.height || 1080) / p.height)
  };
}
function targetStatus(actual, profile, captureFps = 144) {
  const target = PROFILES[validProfile(profile) ? profile : 'smooth'];
  if (captureFps < target.fps) return `Pedido: ${target.fps} fps; a captura do anfitrião está limitada a ${captureFps} fps.`;
  if (actual.width && (actual.width !== target.width || actual.height !== target.height)) return `Resolução abaixo/diferente da escolhida: ${actual.width}×${actual.height}; alvo ${target.width}×${target.height}.`;
  if (actual.fps < target.fps - 1) return `Recebendo/enviando ${actual.fps} de ${target.fps} fps. A captura, o codificador, o decodificador ou a rede estão limitando os quadros.`;
  return '';
}
module.exports = { PROFILES, validProfile, cleanName, parseInvite, validHello, encodingFor, targetStatus };
