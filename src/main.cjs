const { app, BrowserWindow, desktopCapturer, ipcMain, session, clipboard, safeStorage, powerSaveBlocker, powerMonitor } = require('electron');
const { Preferences } = require('./preferences.cjs');
const { DiscordAudio, discordProcesses, nativeFactory } = require('./audio.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const entry = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
const testing = !app.isPackaged && process.env.ENTRETELAS_TEST === '1';
const nativePicker = !testing && process.platform === 'darwin' && Number(process.getSystemVersion().split('.')[0]) >= 15;
let win;
let selection;
let audio;
let powerBlocker;
let pendingInvite = process.argv.find(arg => arg.startsWith('locallive://')) || '';
if (!testing && !app.requestSingleInstanceLock()) app.quit();
app.on('open-url', (event, url) => { event.preventDefault(); if (url.startsWith('locallive://') && url.length < 1000) { pendingInvite = url; win?.webContents.send('room-invite', url); win?.show(); } });
app.on('second-instance', (_event, args) => { const url = args.find(arg => arg.startsWith('locallive://')); if (url && url.length < 1000) { pendingInvite = url; win?.webContents.send('room-invite', url); } win?.show(); win?.focus(); });
// Streaming must not lose renderer priority when a game covers this window.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
function keepActive(active) {
  if (active && powerBlocker === undefined) powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!active && powerBlocker !== undefined) { powerSaveBlocker.stop(powerBlocker); powerBlocker = undefined; }
}
if (testing) {
  app.setPath('userData', process.env.ENTRETELAS_TEST_DATA);
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('disable-audio-output');
  app.commandLine.appendSwitch('mute-audio');
}
function trusted(frame) { return frame && frame.url === entry && frame === win?.webContents.mainFrame; }
function guard(event) { if (!trusted(event.senderFrame)) throw new Error('Origem não autorizada.'); }
app.whenReady().then(() => {
  let prefs;
  if (app.isPackaged) app.setAsDefaultProtocolClient('locallive');
  powerMonitor.on('resume', () => audio?.restart());
  ipcMain.handle('media-active', (event, active) => { guard(event); keepActive(active === true); });
  audio = new DiscordAudio({ factory: () => nativeFactory(app), processes: () => discordProcesses(app), emit: packet => { if (win && !win.isDestroyed()) win.webContents.send('audio-packet', packet); } });
  ipcMain.handle('audio-start', event => { guard(event); if (testing) throw new Error('Captura real de áudio bloqueada nos testes.'); return audio.start(); });
  ipcMain.handle('audio-repair', (event, id) => { guard(event); if (audio.session === id) audio.restart(); });
  ipcMain.handle('audio-stop', (event, id) => { guard(event); if (audio.session === id) audio.stop(); });
  const preferences = () => prefs ||= Preferences.open(app.getPath('userData'), testing ? null : safeStorage);
  ipcMain.handle('preferences', (event, action, data = {}) => {
    guard(event);
    const store = preferences();
    if (action === 'create-room') return store.createRoom(data.name);
    if (action === 'read') return store.read();
    if (action === 'remember') return store.remember(data.invite, data.name, data.profile);
    if (action === 'forget') return store.forget(data.id);
    if (action === 'profile') return store.profile(data.name, data.profile);
    if (action === 'rotate') return store.rotate();
    throw new Error('Operação inválida.');
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => wc === win?.webContents && wc.getURL() === entry && ['media', 'display-capture', 'fullscreen'].includes(permission));
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(wc === win?.webContents && wc.getURL() === entry && ['media', 'display-capture', 'fullscreen'].includes(permission)));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const chosen = selection;
    selection = null;
    if (!trusted(request.frame) || !chosen || Date.now() - chosen.time > 30000) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(s => s.id === chosen.id);
      callback(source ? { video: source, ...(chosen.audio && ['win32', 'darwin'].includes(process.platform) ? { audio: 'loopback' } : {}) } : {});
    } catch { callback({}); }
  }, { useSystemPicker: nativePicker });
  ipcMain.handle('sources', async event => {
    guard(event);
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.filter(s => !s.name.startsWith('Local Live')).map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });
  ipcMain.handle('select-source', (event, id, audio) => {
    guard(event);
    if (typeof id !== 'string' || id.length > 300) throw new Error('Fonte inválida.');
    selection = { id, audio: audio === true, time: Date.now() };
  });
  ipcMain.handle('copy', (event, value) => {
    guard(event);
    if (typeof value !== 'string' || value.length > 2000) throw new Error('Texto inválido.');
    clipboard.writeText(value);
  });
  ipcMain.handle('runtime', event => {
    guard(event);
    return testing ? { testing: true, nativePicker: false, peerOptions: { host: '127.0.0.1', port: 19091, path: '/', secure: false, config: { iceServers: [] } } } : { testing: false, nativePicker, invite: pendingInvite };
  });
  win = new BrowserWindow({ width: 1280, height: 860, minWidth: 1000, minHeight: 720, title: 'Local Live', backgroundColor: '#f5f5f7', show: !testing,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.loadURL(entry);
  win.webContents.on('render-process-gone', () => { audio.stop(); keepActive(false); });
  win.on('closed', () => { audio.stop(); win = null; selection = null; app.quit(); });
});
app.on('before-quit', () => { audio?.stop(); keepActive(false); });
app.on('window-all-closed', () => app.quit());
