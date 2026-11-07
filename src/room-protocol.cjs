const { cleanName } = require('./protocol.cjs');
const HEIGHTS = [480, 720, 1080], RATES = [15, 30, 60, 120, 144];
const validId = id => typeof id === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(id);
function inviteFor(identity, name = '') {
  if (!validId(identity.id) || !/^[a-f\d]{48}$/.test(identity.secret)) throw new Error('Sala inválida.');
  const hex = identity.id.replaceAll('-', '') + identity.secret;
  const bytes = hex.match(/../g).map(n => String.fromCharCode(parseInt(n, 16))).join('');
  return `locallive://sala/${btoa(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}${name ? `?nome=${encodeURIComponent(cleanName(name))}` : ''}`;
}
function readInvite(value) {
  if (typeof value !== 'string' || value.length > 1000) throw new Error('Cole um convite do Local Live.');
  const text = value.trim();
  if (text.startsWith('ET1.')) {
    const { parseInvite } = require('./protocol.cjs');
    return { ...parseInvite(text), name: 'Sala de amigos' };
  }
  try {
    const url = new URL(text);
    if (url.protocol !== 'locallive:' || url.hostname !== 'sala' || !/^\/[A-Za-z0-9_-]{54}$/.test(url.pathname)) throw 0;
    const binary = atob(url.pathname.slice(1).replaceAll('-', '+').replaceAll('_', '/'));
    if (binary.length !== 40) throw 0;
    const hex = [...binary].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    const uuid = hex.slice(0, 32), id = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
    if (!validId(id)) throw 0;
    return { id, secret: hex.slice(32), name: cleanName(url.searchParams.get('nome')) || 'Sala de amigos' };
  } catch { throw new Error('Esse convite não é válido. Peça ao seu amigo para usar “Copiar convite” na sala.'); }
}
function capsFor(value) {
  if (!value || !HEIGHTS.includes(value.height) || !RATES.includes(value.fps)) return null;
  return { width: value.height === 480 ? 854 : value.height === 720 ? 1280 : 1920, height: value.height, fps: value.fps };
}
function qualityFor(requested = {}, caps) {
  return { height: Math.min(HEIGHTS.includes(requested.height) ? requested.height : caps.height, caps.height), fps: Math.min(RATES.includes(requested.fps) ? requested.fps : caps.fps, caps.fps) };
}
module.exports = { HEIGHTS, RATES, validId, inviteFor, readInvite, capsFor, qualityFor };
