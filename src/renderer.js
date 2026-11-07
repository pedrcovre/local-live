import { Room } from './room.js';
import { readInvite, capsFor, HEIGHTS, RATES } from './room-protocol.cjs';
import { normalizeVideo } from './video.js';
import { filteredAudio } from './filtered-audio.js';
const $ = id => document.getElementById(id);
const runtime = await window.desktop.runtime();
let prefs = await window.desktop.preferences('read');
const room = new Room(runtime.peerOptions);
let acquireAudio = filteredAudio;
let busy = false, captureCleanup, sharedAudio, captureStats, watchingCaps, playbackStall = 0, lastPlaybackTime = 0;
let volume = .8, rememberedVolume = .8;
let detachStreamListeners = () => {};
$('my-name').value = prefs.name || 'Visitante';
$('remote').muted = true;
// Synthetic tests silence the physical output with Chromium's mute-audio flag.
const initials = name => name.trim().slice(0, 1).toUpperCase() || 'V';
function notice(message = '') { $('notice-text').textContent = message; $('notice').hidden = !message; }
function dialog(id) { notice(); if (!$(id).open) $(id).showModal(); }
function name() { return $('my-name').value.trim().slice(0, 40) || 'Visitante'; }
function updateProfile() { $('my-avatar').textContent = initials(name()); window.desktop.preferences('profile', { name: name() }).catch(error => notice(error.message)); }
function controls() {
  const active = !!room.active;
  $('home-view').hidden = active; $('room-view').hidden = !active;
  $('share').disabled = busy || !!room.stream; $('empty-share').disabled = busy || !!room.stream;
  for (const id of ['create-room', 'join-room', 'start-sharing']) $(id).disabled = busy;
  window.desktop.activity(active || busy).catch(() => {});
  $('my-name').disabled = active;
  savedRooms();
}
function savedRooms() {
  $('saved-list').replaceChildren(); $('saved-empty').hidden = !!prefs.rooms.length;
  for (const saved of prefs.rooms) {
    const button = document.createElement('button'); button.className = `room-link${room.active && room.identity?.id === saved.id ? ' selected' : ''}`;
    const icon = document.createElement('span'); icon.className = 'room-symbol'; icon.textContent = '▱';
    const text = document.createElement('div'), title = document.createElement('strong'), subtitle = document.createElement('small');
    title.textContent = saved.name; subtitle.textContent = saved.owned ? 'Sua sala' : 'Convite salvo'; text.append(title, subtitle); button.append(icon, text);
    button.onclick = () => enterSaved(saved); button.disabled = busy; $('saved-list').append(button);
  }
}
async function leaveCurrent() {
  if (!room.active) return true;
  if (room.isOwner && room.members.size > 1 && !window.confirm('Sair fecha esta sala para todos. Você pode apenas encerrar sua transmissão e continuar aqui. Sair da sala?')) return false;
  room.leave(); return true;
}
async function enterSaved(saved) {
  if (room.active && room.identity?.id === saved.id) return;
  if (!await leaveCurrent()) return;
  busy = true; controls(); notice();
  try { if (saved.owned) await room.create(readInvite(saved.invite), saved.name, name()); else await room.join(saved.invite, name()); }
  catch (error) { notice(error.message); } finally { busy = false; controls(); }
}
$('new-room').onclick = $('create-card').onclick = () => { $('new-room-name').value = `Sala de ${name()}`; dialog('create-dialog'); };
$('add-invite').onclick = $('join-card').onclick = () => dialog('join-dialog');
$('home').onclick = async () => { if (await leaveCurrent()) controls(); };
$('my-name').onchange = updateProfile; $('my-avatar').textContent = initials(name());
$('dismiss-notice').onclick = () => notice();
for (const button of document.querySelectorAll('.close-dialog')) button.onclick = () => button.closest('dialog').close();
$('create-room').onclick = async () => {
  if (busy || !await leaveCurrent()) return;
  busy = true; controls(); notice();
  try {
    const title = $('new-room-name').value.trim(); if (!title) throw new Error('Dê um nome à sua sala.');
    prefs = await window.desktop.preferences('create-room', { name: title });
    const saved = prefs.rooms.find(item => item.id === prefs.lastRoom);
    await room.create(readInvite(saved.invite), saved.name, name()); $('create-dialog').close();
  } catch (error) { notice(error.message); } finally { busy = false; controls(); }
};
$('join-room').onclick = async () => {
  if (busy || !await leaveCurrent()) return;
  busy = true; controls(); notice();
  try { await room.join($('join-invite').value, name()); $('join-dialog').close(); }
  catch (error) { notice(error.message); } finally { busy = false; controls(); }
};
$('copy-invite').onclick = async () => { try { await window.desktop.copy(room.invite); const label = $('copy-invite').querySelector('span'); label.textContent = 'Convite copiado'; setTimeout(() => label.textContent = 'Copiar convite', 2000); } catch { notice('Não foi possível copiar o convite.'); } };
$('leave-room').onclick = async () => { await leaveCurrent(); controls(); };
$('share').onclick = $('empty-share').onclick = () => { if (room.active) dialog('share-dialog'); };
async function chooseSource() {
  const sources = await window.desktop.sources();
  if (!sources.length) throw new Error('Não foi possível encontrar uma tela. Confira a permissão de gravação de tela e reabra o aplicativo.');
  return new Promise(resolve => {
    let choice = null; $('sources').replaceChildren();
    for (const source of sources) {
      const button = document.createElement('button'); button.className = 'source'; const image = document.createElement('img'); image.src = source.thumbnail; image.alt = ''; const label = document.createElement('span'); label.textContent = source.name;
      button.append(image, label); button.onclick = () => { choice = source; $('picker').close(); }; $('sources').append(button);
    }
    $('cancel-picker').onclick = () => $('picker').close(); $('picker').addEventListener('close', () => resolve(choice), { once: true }); $('picker').showModal();
  });
}
function stopCapture() { const cleanup = captureCleanup; captureCleanup = null; sharedAudio = null; cleanup?.(); $('preview').srcObject = null; $('local-card').hidden = true; controls(); updateVolume(); }
function audioStatus(status) {
  room.reportAudio(status.state);
  const recovering = status.state !== 'ready'; $('audio-status').classList.toggle('recovering', recovering);
  $('audio-status').textContent = recovering ? `Reconectando áudio…${status.message ? ` ${status.message}` : ''}` : '♪ Áudio conectado';
}
$('start-sharing').onclick = async () => {
  if (busy || !room.active || room.stream) return;
  const caps = capsFor({ height: Number($('capture-height').value), fps: Number($('capture-fps').value) });
  busy = true; controls(); notice(); $('share-dialog').close(); let raw, normalized, audio;
  try {
    let source;
    if (!runtime.nativePicker) { source = await chooseSource(); if (!source) return; await window.desktop.select(source.id, false); }
    raw = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: caps.width, max: caps.width }, height: { ideal: caps.height, max: caps.height }, frameRate: { ideal: caps.fps, max: caps.fps } }, audio: false });
    normalized = await normalizeVideo(raw, { ...caps, onStats: stats => { room.cadence = stats; captureStats = stats; $('capture-stats').textContent = `${caps.height}p · saída ${Math.round(stats.outputFps)} FPS · fonte ${Math.round(stats.sourceFps)} FPS`; }, onError: message => { room.stopBroadcast(); notice(message); } });
    audio = await acquireAudio(audioStatus, track => room.replaceAudio(track)); normalized.stream.addTrack(audio.track);
    if (!room.active) { audio.cleanup(); normalized.cleanup(); return; }
    room.setBroadcast(normalized.stream, caps, Number($('budget').value));
    sharedAudio = audio; captureCleanup = () => { audio.cleanup(); normalized.cleanup(); };
    $('preview').srcObject = normalized.stream; $('local-card').hidden = false;
    $('source-name').textContent = source?.name || raw.getVideoTracks()[0].label || 'Tela escolhida no macOS';
    $('capture-stats').textContent = `${caps.height}p · alvo ${caps.fps} FPS`;
    updateVolume();
  } catch (error) { audio?.cleanup(); normalized?.cleanup(); raw?.getTracks().forEach(track => track.stop()); notice(error.name === 'NotAllowedError' ? 'A seleção foi cancelada ou a gravação de tela precisa de permissão nos ajustes do sistema.' : error.message); }
  finally { busy = false; controls(); }
};
$('stop-sharing').onclick = () => room.stopBroadcast();
function updateVolume() {
  // Windows process loopback excludes a single process tree (Discord). Avoid
  // recapturing this app's playback while it is broadcasting at the same time.
  const preventFeedback = window.desktop.platform === 'win32' && !!room.stream;
  $('remote-audio').volume = preventFeedback ? 0 : volume;
  if (!runtime.testing) $('remote-audio').muted = preventFeedback || volume === 0;
  $('volume').disabled = preventFeedback; $('mute').disabled = preventFeedback;
  $('volume').value = Math.round(volume * 100); $('volume-label').textContent = preventFeedback ? '0%' : `${Math.round(volume * 100)}%`;
  $('mute').textContent = volume === 0 || preventFeedback ? '⊘' : '♪';
  $('mute').setAttribute('aria-label', volume === 0 ? 'Ativar áudio' : 'Silenciar transmissão');
  $('audio-playback-status').textContent = preventFeedback ? 'Áudio assistido silenciado enquanto você compartilha, para evitar retorno.' : '';
}
$('volume').oninput = () => { volume = Number($('volume').value) / 100; if (volume) rememberedVolume = volume; updateVolume(); };
$('mute').onclick = () => { volume = volume > 0 ? 0 : rememberedVolume; updateVolume(); };
function qualityOptions(caps, quality = caps) {
  watchingCaps = caps; for (const [id, values, field, label] of [['watch-height', HEIGHTS, 'height', 'p'], ['watch-fps', RATES, 'fps', ' FPS']]) {
    $(id).replaceChildren(); for (const value of values.filter(n => n <= caps[field])) { const option = document.createElement('option'); option.value = value; option.textContent = `${value}${label}`; $(id).append(option); }
    $(id).value = String(Math.min(quality[field], caps[field])); $(id).disabled = false;
  }
}
for (const id of ['watch-height', 'watch-fps']) $(id).onchange = () => room.quality({ height: Number($('watch-height').value), fps: Number($('watch-fps').value) });
function renderMembers() {
  $('members').replaceChildren(); $('member-count').textContent = room.members.size;
  const live = [...room.members.values()].filter(member => member.caps).length;
  $('room-summary').textContent = `${room.members.size} ${room.members.size === 1 ? 'pessoa' : 'pessoas'} · ${live} ${live === 1 ? 'transmissão' : 'transmissões'} ao vivo`;
  for (const member of room.members.values()) {
    const own = member.id === room.id, button = document.createElement('button'); button.className = `member${member.caps ? ' live' : ''}${room.watching === member.id ? ' watching' : ''}`;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = initials(member.name);
    const text = document.createElement('div'), title = document.createElement('strong'), state = document.createElement('small'); title.textContent = `${member.name}${own ? ' · você' : ''}`; state.textContent = member.caps ? `${member.caps.height}p · ${member.caps.fps} FPS${own ? '' : ' · assistir'}` : 'Na sala'; text.append(title, state); button.append(avatar, text);
    if (member.caps) { const dot = document.createElement('span'); dot.className = 'live-dot'; button.append(dot); }
    button.disabled = own || !member.caps; button.onclick = () => room.watch(member.id, member.caps); $('members').append(button);
  }
  if (room.watching && room.members.get(room.watching)?.caps) qualityOptions(room.members.get(room.watching).caps, room.applied || room.requested);
  queueMicrotask(() => { if (room.active && !room.watching) { const candidate = [...room.members.values()].find(member => member.id !== room.id && member.caps); if (candidate) room.watch(candidate.id, candidate.caps); } });
}
room.addEventListener('joined', async ({ detail }) => {
  $('room-name').textContent = detail.name; controls();
  try { prefs = await window.desktop.preferences('remember', { invite: detail.invite, name: detail.name, profile: 'smooth' }); savedRooms(); } catch (error) { notice(error.message); }
});
room.addEventListener('members', renderMembers);
room.addEventListener('notice', event => notice(event.detail));
room.addEventListener('left', () => { stopCapture(); controls(); });
room.addEventListener('broadcast', ({ detail }) => { if (!detail.active) stopCapture(); controls(); });
room.addEventListener('watching', ({ detail }) => { $('watch-title').textContent = `Tela de ${detail.name}`; $('watch-status').textContent = 'Conectando…'; $('watch-live').hidden = false; qualityOptions(detail.caps); renderMembers(); });
room.addEventListener('quality', ({ detail }) => { qualityOptions(detail.caps, detail.quality); $('watch-status').textContent = `${detail.quality.height}p · ${detail.quality.fps} FPS`; });
room.addEventListener('stream', ({ detail }) => { $('remote').srcObject = new MediaStream(detail.stream.getVideoTracks()); $('remote-empty').hidden = true; updateVolume(); $('remote').play().catch(() => {}); detachStreamListeners(); const refresh = () => { if (room.remoteStream === detail.stream) resetAudioPlayback(); }; detail.stream.addEventListener('addtrack', refresh); detail.stream.addEventListener('removetrack', refresh); detachStreamListeners = () => { detail.stream.removeEventListener('addtrack', refresh); detail.stream.removeEventListener('removetrack', refresh); }; resetAudioPlayback(); lastPlaybackTime = 0; playbackStall = 0; });
room.addEventListener('unwatched', () => { $('remote').srcObject = null; $('remote-audio').srcObject = null; $('remote-empty').hidden = false; detachStreamListeners(); detachStreamListeners = () => {}; $('watch-title').textContent = 'A sala é de vocês.'; $('watch-live').hidden = true; $('watch-status').textContent = 'Escolha uma transmissão'; $('viewer-stats').textContent = 'Pronto para assistir.'; for (const id of ['watch-height', 'watch-fps']) $(id).disabled = true; renderMembers(); });
room.addEventListener('repair-audio', () => sharedAudio?.repair().catch(() => {}));
room.addEventListener('stats', ({ detail }) => { if (detail.id === 'receive') $('viewer-stats').textContent = `${detail.width}×${detail.height} · ${detail.fps} FPS recebidos · ${detail.mbps.toFixed(1)} Mbps · ${detail.rtt} ms`; });
let audioResetting = false, audioLastTime = 0, audioStall = 0;
async function resetAudioPlayback() {
  const remote = room.remoteStream; if (!remote || !remote.getAudioTracks().length || audioResetting) return;
  audioResetting = true;
  try {
    const audio = $('remote-audio'); audio.srcObject = null; audio.srcObject = new MediaStream(remote.getAudioTracks());
    updateVolume(); audio.play().catch(() => { $('audio-playback-status').textContent = 'Clique no volume para ativar o áudio.'; }); audioStall = 0; audioLastTime = audio.currentTime;
  } catch { $('audio-playback-status').textContent = 'Clique no volume para ativar o áudio.'; }
  finally { audioResetting = false; }
}
$('volume').addEventListener('pointerdown', () => $('remote-audio').play().catch(() => {}));
navigator.mediaDevices.addEventListener('devicechange', resetAudioPlayback);
$('remote-audio').addEventListener('stalled', () => { resetAudioPlayback(); room.requestAudioRepair(); });
room.addEventListener('audio-state', ({ detail }) => { if (detail.state === 'recovering') $('audio-playback-status').textContent = 'Reconectando o áudio da origem…'; else { updateVolume(); resetAudioPlayback(); } });
const playbackHealth = setInterval(() => {
  const video = $('remote'), audio = $('remote-audio'); if (!video.srcObject) return;
  if (video.paused) video.play().catch(() => {});
  if (video.currentTime === lastPlaybackTime && video.readyState >= 2) playbackStall++; else playbackStall = 0;
  lastPlaybackTime = video.currentTime;
  if (playbackStall >= 4) { const stream = video.srcObject; video.srcObject = null; video.srcObject = stream; video.play().catch(() => {}); playbackStall = 0; }
  if (audio.srcObject && !audio.muted) {
    if (audio.paused) audio.play().catch(() => {});
    if (audio.currentTime === audioLastTime && audio.readyState >= 2) audioStall++; else audioStall = 0;
    audioLastTime = audio.currentTime;
    if (audioStall >= 3) { resetAudioPlayback(); room.requestAudioRepair(); }
  }
}, 3000);
async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('viewer-stage').requestFullscreen(); } catch { notice('Não foi possível abrir a tela cheia.'); } }
$('fullscreen').onclick = fullscreen; $('remote').ondblclick = fullscreen;
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.fullscreenElement) { event.preventDefault(); document.exitFullscreen().catch(() => {}); } }, true);
$('remote').oncontextmenu = event => event.preventDefault();
window.desktop.onInvite(value => { $('join-invite').value = value; dialog('join-dialog'); });
if (runtime.invite) { $('join-invite').value = runtime.invite; dialog('join-dialog'); }
updateVolume(); controls();
if (prefs.storageError) notice(prefs.storageError);
window.addEventListener('beforeunload', () => { clearInterval(playbackHealth); room.destroy(); });
if (runtime.testing) window.__test = { room, normalizeVideo, filteredAudio, getAudio: () => sharedAudio, setNativePicker: value => { runtime.nativePicker = value; }, setAudioFactory: factory => { acquireAudio = factory; }, getPrefs: () => prefs };
