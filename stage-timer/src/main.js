const { app, BrowserWindow, ipcMain, screen, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const fontList = require('font-list');
const config = require('./config.json');

const PORT = 4777;
const RENDERER = path.join(__dirname, 'renderer');
const FONTS = path.join(__dirname, '..', 'assets', 'fonts');
const POPPINS = path.join(path.dirname(require.resolve('@fontsource/poppins/package.json')), 'files');
const LIMITS = { logoBytes: 1024 * 1024, bgBytes: 8 * 1024 * 1024, fonts: { free: 5, paid: 20 } };
const BUILTIN_FONTS = ['Varien', 'Poppins'];
const HEX = /^#[0-9a-f]{6}$/i;

const DEFAULTS = {
  title: 'OPENING PRAYER',
  moderator: 'REV. MARK NORTEY',
  totalMs: 120000,
  autoAdvance: false,
  schedule: [],
  activeId: null,
  myFonts: [],
  licenseKey: '',
  style: {
    bgColor: '#101518', bgImage: '', bgFit: 'cover', logo: '', textColor: '#FFFFFF',
    fonts: { title: 'Varien', timer: 'Varien', moderator: 'Varien', date: 'Varien' }
  }
};

let S;                       // persisted settings
const rt = { remainingMs: 0, running: false, endAt: 0, timeUp: false }; // runtime timer
let license = null;          // verified license payload or null
let controlWin = null, outWin = null;
const clients = new Set();   // SSE clients
let saveTimer = null;

/* ---------- persistence ---------- */
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch {}
  S = { ...DEFAULTS, ...saved, style: { ...DEFAULTS.style, ...(saved.style || {}), fonts: { ...DEFAULTS.style.fonts, ...((saved.style || {}).fonts || {}) } } };
  rt.remainingMs = S.totalMs;
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(settingsPath(), JSON.stringify(S)); } catch (e) { console.error(e); } }, 400);
}

/* ---------- licensing (offline, Ed25519-signed keys) ---------- */
function verifyLicense(key) {
  try {
    const pub = fs.readFileSync(path.join(__dirname, 'public.pem'));
    const [p, s] = String(key).trim().split('.');
    const data = Buffer.from(p, 'base64url');
    if (!crypto.verify(null, data, pub, Buffer.from(s, 'base64url'))) return null;
    const info = JSON.parse(data.toString());
    if (info.exp && Date.now() > info.exp) return null;
    return info;
  } catch { return null; }
}

/* ---------- state sent to windows ---------- */
const effectiveStyle = () => {
  const st = { ...S.style };
  if (!license) { st.logo = ''; st.bgImage = ''; st.bgColor = '#101518'; }
  return st;
};
const publicState = () => ({
  title: S.title, moderator: S.moderator, totalMs: S.totalMs, autoAdvance: S.autoAdvance,
  schedule: S.schedule, activeId: S.activeId, myFonts: S.myFonts, style: effectiveStyle(),
  licensed: !!license, licenseInfo: license ? { name: license.name, exp: license.exp || null } : null,
  fontLimit: license ? LIMITS.fonts.paid : LIMITS.fonts.free,
  config: { momoNumber: config.momoNumber, paymentUrl: config.paymentUrl, adminName: config.adminName }
});
const tick = () => ({ remainingMs: rt.remainingMs, totalMs: S.totalMs, running: rt.running, timeUp: rt.timeUp });
function sse(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
const pushState = () => { sse('state', publicState()); sse('tick', tick()); persist(); };

/* ---------- timer engine ---------- */
function start() {
  if (rt.remainingMs <= 0) rt.remainingMs = S.totalMs;
  if (rt.remainingMs <= 0) return;
  rt.endAt = Date.now() + rt.remainingMs; rt.running = true; rt.timeUp = false;
}
function pause() { if (rt.running) { rt.remainingMs = Math.max(0, rt.endAt - Date.now()); rt.running = false; } }
function reset() { rt.running = false; rt.timeUp = false; rt.remainingMs = S.totalMs; }
function loadItem(item, autostart) {
  S.activeId = item.id; S.title = item.title; S.moderator = item.moderator;
  S.totalMs = ((item.minutes || 0) * 60 + (item.seconds || 0)) * 1000;
  reset(); if (autostart) start();
}
function step(dir, autostart) {
  const i = S.schedule.findIndex(x => x.id === S.activeId);
  const next = S.schedule[i + dir] || (i === -1 && dir === 1 ? S.schedule[0] : null);
  if (next) loadItem(next, autostart);
}
setInterval(() => {
  if (!rt.running) return;
  rt.remainingMs = Math.max(0, rt.endAt - Date.now());
  if (rt.remainingMs === 0) {
    rt.running = false; rt.timeUp = true;
    if (S.autoAdvance) setTimeout(() => { if (rt.timeUp) { step(1, true); pushState(); } }, 5000);
  }
  sse('tick', tick());
}, 100);

/* ---------- commands from the control window ---------- */
const dataUrlBytes = u => Math.floor((u.length - u.indexOf(',') - 1) * 0.75);
const uid = () => crypto.randomBytes(5).toString('hex');
const clampNum = (v, max) => Math.max(0, Math.min(max, Math.floor(+v || 0)));

function cmd(c) {
  const paid = !!license;
  switch (c.type) {
    case 'setText':
      if (typeof c.title === 'string') S.title = c.title.slice(0, 80);
      if (typeof c.moderator === 'string') S.moderator = c.moderator.slice(0, 80);
      break;
    case 'setTime': {
      S.totalMs = (clampNum(c.minutes, 5999) * 60 + clampNum(c.seconds, 59)) * 1000;
      reset(); break;
    }
    case 'start': start(); break;
    case 'pause': pause(); break;
    case 'reset': reset(); break;
    case 'adjust': {
      const d = Number(c.delta) || 0;
      if (rt.running) { rt.endAt += d; rt.remainingMs = Math.max(0, rt.endAt - Date.now()); }
      else rt.remainingMs = Math.max(0, rt.remainingMs + d);
      S.totalMs = Math.max(1000, S.totalMs + d); break;
    }
    case 'setStyle': {
      const p = c.patch || {};
      const allowedFonts = [...BUILTIN_FONTS, ...S.myFonts];
      if (p.textColor !== undefined) { if (!HEX.test(p.textColor)) return { error: 'Use a hex colour like #FFFFFF.' }; S.style.textColor = p.textColor; }
      if (p.fonts) for (const k of ['title', 'timer', 'moderator', 'date'])
        if (p.fonts[k] !== undefined) { if (!allowedFonts.includes(p.fonts[k])) return { error: 'Add that font to My fonts first.' }; S.style.fonts[k] = p.fonts[k]; }
      const paidKeys = ['bgColor', 'bgImage', 'bgFit', 'logo'].filter(k => p[k] !== undefined);
      if (paidKeys.length && !paid) return { error: 'Logo and background customisation need the paid version.' };
      if (p.bgColor !== undefined) { if (!HEX.test(p.bgColor)) return { error: 'Use a hex colour like #101518.' }; S.style.bgColor = p.bgColor; }
      if (p.bgFit !== undefined) S.style.bgFit = ['cover', 'contain', 'fill'].includes(p.bgFit) ? p.bgFit : 'cover';
      for (const [k, max, label] of [['logo', LIMITS.logoBytes, 'Logo'], ['bgImage', LIMITS.bgBytes, 'Background']]) {
        if (p[k] === undefined) continue;
        if (p[k] === '') { S.style[k] = ''; continue; }
        if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/.test(p[k])) return { error: `${label} must be a PNG, JPG, WEBP, GIF or SVG image.` };
        if (dataUrlBytes(p[k]) > max) return { error: `${label} must be ${max / 1048576} MB or smaller.` };
        S.style[k] = p[k];
      }
      break;
    }
    case 'addFont': {
      const limit = paid ? LIMITS.fonts.paid : LIMITS.fonts.free;
      if (S.myFonts.includes(c.name) || BUILTIN_FONTS.includes(c.name)) return { error: 'That font is already available.' };
      if (S.myFonts.length >= limit) return { error: `${paid ? 'Paid' : 'Free'} version allows up to ${limit} custom fonts.${paid ? '' : ' Upgrade for up to 20.'}` };
      if (typeof c.name !== 'string' || !c.name || c.name.length > 80) return { error: 'Invalid font name.' };
      S.myFonts.push(c.name); break;
    }
    case 'removeFont':
      S.myFonts = S.myFonts.filter(f => f !== c.name);
      for (const k of Object.keys(S.style.fonts)) if (S.style.fonts[k] === c.name) S.style.fonts[k] = 'Varien';
      break;
    case 'scheduleAdd':
      if (S.schedule.length >= 200) return { error: 'Schedule is full (200 items).' };
      S.schedule.push({ id: uid(), title: String(c.title || 'UNTITLED').slice(0, 80), moderator: String(c.moderator || '').slice(0, 80),
        start: /^\d{2}:\d{2}$/.test(c.start) ? c.start : '', minutes: clampNum(c.minutes, 5999), seconds: clampNum(c.seconds, 59) });
      break;
    case 'scheduleRemove': S.schedule = S.schedule.filter(x => x.id !== c.id); if (S.activeId === c.id) S.activeId = null; break;
    case 'scheduleMove': {
      const i = S.schedule.findIndex(x => x.id === c.id), j = i + (c.dir < 0 ? -1 : 1);
      if (i > -1 && j > -1 && j < S.schedule.length) [S.schedule[i], S.schedule[j]] = [S.schedule[j], S.schedule[i]];
      break;
    }
    case 'scheduleLoad': { const it = S.schedule.find(x => x.id === c.id); if (it) loadItem(it, !!c.autostart); break; }
    case 'next': step(1, !!c.autostart); break;
    case 'prev': step(-1, false); break;
    case 'setAuto': S.autoAdvance = !!c.value; break;
    case 'activate': {
      const info = verifyLicense(c.key);
      if (!info) return { error: 'That license key is not valid or has expired.' };
      license = info; S.licenseKey = String(c.key).trim(); break;
    }
    case 'deactivate': license = null; S.licenseKey = ''; break;
    case 'openOutput': openOutput(c.displayId); return { ok: true };
    case 'closeOutput': if (outWin) outWin.close(); return { ok: true };
    default: return { error: 'Unknown command.' };
  }
  pushState();
  return { ok: true };
}

/* ---------- local server (control UI, output page, fonts, SSE) ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png' };
function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    res.write(`event: tick\ndata: ${JSON.stringify(tick())}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p.startsWith('/vendor/poppins/')) return serveFile(res, POPPINS, p.slice(16));
  if (p.startsWith('/fonts/')) return serveFile(res, FONTS, p.slice(7));
  serveFile(res, RENDERER, p === '/' ? 'control.html' : p.slice(1));
});
server.on('error', err => { dialog.showErrorBox('Stage Timer', `Port ${PORT} is already in use. Close the other copy of Stage Timer and try again.\n\n${err.message}`); app.quit(); });
server.listen(PORT, '127.0.0.1');

/* ---------- windows ---------- */
function openOutput(displayId) {
  if (outWin) outWin.close();
  const displays = screen.getAllDisplays();
  const d = displays.find(x => x.id === displayId) || screen.getPrimaryDisplay();
  const multi = displays.length > 1;
  outWin = new BrowserWindow({
    x: d.bounds.x + (multi ? 0 : 60), y: d.bounds.y + (multi ? 0 : 60),
    width: multi ? d.bounds.width : 960, height: multi ? d.bounds.height : 540,
    frame: !multi, fullscreen: multi, backgroundColor: '#101518', autoHideMenuBar: true, title: 'Stage Timer Output',
    webPreferences: { backgroundThrottling: false }
  });
  outWin.setMenuBarVisibility(false);
  outWin.loadURL(`http://127.0.0.1:${PORT}/output.html`);
  outWin.webContents.on('before-input-event', (e, i) => { if (i.key === 'Escape') outWin.close(); });
  outWin.on('closed', () => { outWin = null; });
}

function createControl() {
  controlWin = new BrowserWindow({
    width: 1180, height: 820, minWidth: 980, minHeight: 700, backgroundColor: '#14171a', title: 'Stage Timer',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  controlWin.setMenuBarVisibility(false);
  controlWin.loadURL(`http://127.0.0.1:${PORT}/control.html`);
  controlWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controlWin.on('closed', () => app.quit());
}

ipcMain.handle('cmd', (e, c) => cmd(c || {}));
ipcMain.handle('fonts', async () => { try { return await fontList.getFonts({ disableQuoting: true }); } catch { return []; } });
ipcMain.handle('displays', () => screen.getAllDisplays().map((d, i) => ({ id: d.id, label: `Display ${i + 1} – ${d.bounds.width}×${d.bounds.height}${d.id === screen.getPrimaryDisplay().id ? ' (main)' : ''}` })));
ipcMain.handle('openExternal', (e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

app.whenReady().then(() => {
  loadSettings();
  if (S.licenseKey) license = verifyLicense(S.licenseKey);
  createControl();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createControl(); });
});
app.on('window-all-closed', () => app.quit());
