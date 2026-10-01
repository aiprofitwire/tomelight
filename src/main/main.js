'use strict';
/**
 * Tomelight: main process.
 * Owns windows, menus, file IO, watching, settings, sessions and exports.
 * Each window is a workspace: an optional folder plus any number of open tabs.
 */
const {
  app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, screen, protocol, net,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const EXTS = ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'html', 'htm', 'txt'];
const SUPPORTED = new Set(EXTS.map((e) => `.${e}`));
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv', 'Library']);
const isMac = process.platform === 'darwin';
const RENDERER = path.join(__dirname, '..', '..', 'dist', 'index.html');
if (process.env.TOMELIGHT_USER_DATA) app.setPath('userData', process.env.TOMELIGHT_USER_DATA);

/* ------------------------------------------------------------------ */
/* HTML pages get their own walled-off origin: tlpage://local/<path>     */
/* Like a real browser tab: scripts, CDNs, fonts, localStorage and      */
/* relative data files all work, but the page can't reach Tomelight     */
/* itself, and can only read files inside its own folder.               */
/* ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([{
  scheme: 'tlpage',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);
const pageRoots = new Set();      // folders whose files pages may load
const pagePreviews = new Map();   // file -> unsaved HTML for the live split preview
const toPageUrl = (file) => `tlpage://local${file.split('/').map(encodeURIComponent).join('/')}`;
function handlePageProtocol() {
  protocol.handle('tlpage', async (req) => {
    const u = new URL(req.url);
    let file;
    try { file = path.normalize(decodeURIComponent(u.pathname)); } catch { return new Response('Bad path', { status: 400 }); }
    const allowed = [...pageRoots].some((r) => file === r || file.startsWith(r + path.sep));
    if (!allowed) return new Response('Blocked: outside this page\'s folder', { status: 403 });
    if (u.searchParams.has('tlpreview') && pagePreviews.has(file)) {
      return new Response(pagePreviews.get(file), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    try {
      const res = await net.fetch(pathToFileURL(file).href);
      return res;
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
ipcMain.handle('page:url', (_e, file) => {
  pageRoots.add(path.dirname(file));
  return `${toPageUrl(file)}?v=${Date.now()}`;
});
ipcMain.handle('page:preview', (_e, { file, html }) => {
  pageRoots.add(path.dirname(file));
  pagePreviews.set(file, html);
  return `${toPageUrl(file)}?tlpreview=1&v=${Date.now()}`;
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
const DEFAULT_SETTINGS = {
  theme: 'wire',            // wire | auto | arcane | parchment | nebula
  bodyFont: 'sans',         // sans | serif
  width: 'comfortable',     // narrow | comfortable | wide
  fontScale: 1,
  autosave: true,
  sidebar: true,
  sidebarWidth: 290,
  sidebarPanel: 'folder',   // folder | outline
  dblClickEdit: true,
  strikeDone: true,
  restoreSession: true,
  imgMaxWidth: 1600,
  imgQuality: 82,
  notesVisible: true,
  showLineBreaks: true,
  writeTipSeen: false,
  imgShape: 'original',
  studioGuide: true,
  imgFormat: 'webp',        // webp | jpeg
  imgOutput: 'beside',      // beside | folder  (a "web-ready" subfolder)
  imgSeoNames: true,
  recent: [],
  recentFolders: [],
  session: null,            // { folder, tabs: [file], active: file }
  bounds: null,
};
let settings = { ...DEFAULT_SETTINGS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  // One-time carry-over from the app's old working name, so recents and the session survive the rename.
  try {
    const legacy = path.join(app.getPath('appData'), 'Grimoire', 'settings.json');
    if (!fs.existsSync(settingsFile()) && fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.copyFileSync(legacy, settingsFile());
    }
  } catch { /* nothing to migrate */ }
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch { settings = { ...DEFAULT_SETTINGS }; }
}
let saveTimer = null;
function persistSettings(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    } catch (e) { console.error('settings save failed', e); }
  };
  if (now) write(); else saveTimer = setTimeout(write, 250);
}
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
function publicSettings() { return settings; }
function addRecent(file) {
  settings.recent = [file, ...settings.recent.filter((f) => f !== file)].slice(0, 30);
  persistSettings();
  if (isMac) app.addRecentDocument(file);
  scheduleMenu();
  broadcast('settings:changed', publicSettings());
}
function addRecentFolder(dir) {
  settings.recentFolders = [dir, ...settings.recentFolders.filter((f) => f !== dir)].slice(0, 12);
  persistSettings();
  if (isMac) app.addRecentDocument(dir);
  scheduleMenu();
  broadcast('settings:changed', publicSettings());
}

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */
let appReady = false;
let pending = [];          // paths received before the app was ready
let lastFocused = null;
let quitting = false;

function nextBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1360, Math.round(workArea.width * 0.8));
  const height = Math.min(920, Math.round(workArea.height * 0.88));
  const base = settings.bounds && settings.bounds.width ? settings.bounds : {
    width, height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
  const open = BrowserWindow.getAllWindows().length;
  return { ...base, x: (base.x ?? 80) + open * 28, y: (base.y ?? 60) + open * 28 };
}

function createWindow({ restore = false } = {}) {
  const win = new BrowserWindow({
    ...nextBounds(),
    minWidth: 640,
    minHeight: 440,
    show: false,
    backgroundColor: ({ wire: '#091516', nebula: '#090e1c', arcane: '#0d0c12', parchment: '#f6f0e4' })[settings.theme] || (nativeTheme.shouldUseDarkColors ? '#090e1c' : '#f5efe3'),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 17 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webviewTag: false,
    },
  });
  win.__queue = [];
  win.__ready = false;
  win.__watch = new Map();
  win.__folderWatch = null;
  win.loadFile(RENDERER, { query: restore ? { restore: '1' } : {} });
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://') && url.includes('/dist/index.html')) return;
    e.preventDefault();
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('found-in-page', (_e, result) => {
    if (!win.isDestroyed()) win.webContents.send('found-in-page', result);
  });

  win.on('close', (e) => {
    if (win.__forceClose) return;
    e.preventDefault();
    win.webContents.send('app:before-close');
    setTimeout(() => { if (!win.isDestroyed()) { win.__forceClose = true; win.close(); } }, 2000);
  });
  win.on('focus', () => { lastFocused = win; });
  win.on('resize', () => rememberBounds(win));
  win.on('move', () => rememberBounds(win));
  win.on('closed', () => {
    for (const [file, fn] of win.__watch) fs.unwatchFile(file, fn);
    if (win.__folderWatch) win.__folderWatch.close();
    if (lastFocused === win) lastFocused = null;
  });
  lastFocused = win;
  return win;
}
function rememberBounds(win) {
  if (win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return;
  settings.bounds = win.getBounds();
  persistSettings();
}
function targetWindow() {
  const f = BrowserWindow.getFocusedWindow();
  if (f) return f;
  if (lastFocused && !lastFocused.isDestroyed()) return lastFocused;
  return BrowserWindow.getAllWindows()[0] || createWindow();
}
function sendWhenReady(win, channel, ...args) {
  if (win.__ready) win.webContents.send(channel, ...args);
  else win.__queue.push([channel, args]);
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** Open a file as a tab (or a folder as the workspace) in the best window. */
function openPath(p, { win = null, newWindow = false } = {}) {
  if (!p) return;
  p = path.resolve(p);
  if (!appReady) { pending.push(p); return; }
  const w = newWindow ? createWindow() : (win || targetWindow());
  if (isDir(p)) {
    addRecentFolder(p);
    sendWhenReady(w, 'folder:open', p);
  } else {
    addRecent(p);
    sendWhenReady(w, 'file:open', p);
  }
  if (!w.isDestroyed()) { w.show(); w.focus(); }
  return w;
}

async function showOpenDialog(win, { folders = false } = {}) {
  const res = await dialog.showOpenDialog(win || undefined, folders ? {
    title: 'Open a Folder',
    buttonLabel: 'Open Folder',
    properties: ['openDirectory', 'createDirectory'],
  } : {
    title: 'Open Files',
    properties: ['openFile', 'multiSelections', 'openDirectory'],
    filters: [
      { name: 'Documents', extensions: EXTS },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (res.canceled) return;
  const w = win || targetWindow();
  res.filePaths.forEach((f) => openPath(f, { win: w }));
}

async function newDocument(win, dir) {
  const res = await dialog.showSaveDialog(win || undefined, {
    title: 'New File',
    defaultPath: path.join(dir || app.getPath('documents'), 'Untitled.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (res.canceled || !res.filePath) return;
  const name = path.basename(res.filePath, path.extname(res.filePath));
  await fsp.writeFile(res.filePath, `# ${name}\n\n`, 'utf8');
  const w = win || targetWindow();
  openPath(res.filePath, { win: w });
  sendWhenReady(w, 'view:set-mode', 'write');
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

ipcMain.on('renderer:ready', (e) => {
  const win = winOf(e);
  if (!win) return;
  win.__ready = true;
  for (const [ch, args] of win.__queue) win.webContents.send(ch, ...args);
  win.__queue = [];
});

ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  persistSettings();
  broadcast('settings:changed', publicSettings());
  scheduleMenu();
  return publicSettings();
});
ipcMain.on('session:set', (e, session) => {
  // The most recently focused window owns the saved session.
  const win = winOf(e);
  if (win && lastFocused && win !== lastFocused && BrowserWindow.getAllWindows().length > 1) return;
  settings.session = session;
  persistSettings();
});

ipcMain.handle('file:read', async (_e, file) => {
  const stat = await fsp.stat(file);
  if (stat.isDirectory()) throw new Error('is a directory');
  const content = await fsp.readFile(file, 'utf8');
  return {
    file,
    name: path.basename(file),
    dir: path.dirname(file),
    ext: path.extname(file).toLowerCase(),
    dirUrl: pathToFileURL(path.dirname(file) + path.sep).href,
    fileUrl: pathToFileURL(file).href,
    content,
    mtime: stat.mtimeMs,
    size: stat.size,
    home: app.getPath('home'),
  };
});

ipcMain.handle('file:write', async (_e, { file, content }) => {
  // Write to a temp file then rename, so a crash never leaves a half-written tome.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tomelight-tmp`);
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, file);
  } catch {
    try { await fsp.unlink(tmp); } catch {}
    await fsp.writeFile(file, content, 'utf8');
  }
  const stat = await fsp.stat(file);
  return { mtime: stat.mtimeMs };
});

ipcMain.on('file:watch', (e, files) => {
  const win = winOf(e);
  if (!win) return;
  const want = new Set(files);
  for (const [file, fn] of win.__watch) {
    if (!want.has(file)) { fs.unwatchFile(file, fn); win.__watch.delete(file); }
  }
  for (const file of want) {
    if (win.__watch.has(file)) continue;
    const fn = (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      if (!win.isDestroyed()) win.webContents.send('file:changed-on-disk', { file, gone: curr.nlink === 0 && curr.size === 0 && curr.mtimeMs === 0 });
    };
    fs.watchFile(file, { interval: 500 }, fn);
    win.__watch.set(file, fn);
  }
});

ipcMain.on('folder:watch', (e, dir) => {
  const win = winOf(e);
  if (!win) return;
  if (win.__folderWatch) { win.__folderWatch.close(); win.__folderWatch = null; }
  if (!dir) return;
  let t = null;
  try {
    win.__folderWatch = fs.watch(dir, { recursive: true }, (_type, name) => {
      if (name && /(^|\/)\.[^/]*$/.test(name)) return; // ignore dotfiles (incl. our tmp files)
      clearTimeout(t);
      t = setTimeout(() => { if (!win.isDestroyed()) win.webContents.send('folder:changed', dir); }, 300);
    });
  } catch { /* folder may be unreadable; tree still works manually */ }
});

async function listDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    let dirent = d.isDirectory();
    if (d.isSymbolicLink()) dirent = isDir(full);
    if (dirent) { if (!SKIP_DIRS.has(d.name)) out.push({ name: d.name, path: full, dir: true }); }
    else if (SUPPORTED.has(path.extname(d.name).toLowerCase())) out.push({ name: d.name, path: full, dir: false });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
  return out;
}
ipcMain.handle('dir:list', async (_e, dir) => {
  try {
    return { dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, entries: await listDir(dir) };
  } catch (err) {
    return { dir, parent: null, entries: [], error: String(err.message || err) };
  }
});
/** Every supported file under a folder (for quick open). */
ipcMain.handle('dir:walk', async (_e, root) => {
  const files = [];
  const walk = async (dir, depth) => {
    if (files.length > 4000 || depth > 8) return;
    let entries;
    try { entries = await listDir(dir); } catch { return; }
    for (const en of entries) {
      if (en.dir) await walk(en.path, depth + 1);
      else files.push({ name: en.name, path: en.path, rel: path.relative(root, en.path) });
    }
  };
  await walk(root, 0);
  return files;
});

ipcMain.handle('path:info', async (_e, p) => {
  try { const s = await fsp.stat(p); return { exists: true, dir: s.isDirectory() }; } catch { return { exists: false }; }
});

ipcMain.on('path:open', (e, p, opts = {}) => openPath(p, { win: opts.newWindow ? null : winOf(e), newWindow: !!opts.newWindow }));
ipcMain.on('dialog:open', (e, opts = {}) => showOpenDialog(winOf(e), opts));
ipcMain.on('file:new', (e, dir) => newDocument(winOf(e), dir));
ipcMain.on('file:reveal', (_e, file) => shell.showItemInFolder(file));
ipcMain.on('shell:open-external', (_e, url) => { if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url); });
ipcMain.on('shell:open-path', (_e, p) => shell.openPath(p));
ipcMain.on('win:close-ok', (e) => {
  const win = winOf(e);
  if (win && !win.isDestroyed()) { win.__forceClose = true; win.close(); }
});
ipcMain.on('win:close', (e) => { const w = winOf(e); if (w) w.close(); });
ipcMain.on('win:set-title', (e, { title, file }) => {
  const win = winOf(e);
  if (!win) return;
  win.setTitle(title || 'Tomelight');
  if (isMac) win.setRepresentedFilename(file || '');
});
ipcMain.on('win:set-edited', (e, edited) => {
  const win = winOf(e);
  if (win && isMac) win.setDocumentEdited(!!edited);
});
ipcMain.on('recent:clear', () => {
  settings.recent = [];
  settings.recentFolders = [];
  if (isMac) app.clearRecentDocuments();
  persistSettings();
  scheduleMenu();
  broadcast('settings:changed', publicSettings());
});

ipcMain.on('find:start', (e, { text, forward = true, findNext = false }) => {
  if (!text) { e.sender.stopFindInPage('clearSelection'); return; }
  e.sender.findInPage(text, { forward, findNext, matchCase: false });
});
ipcMain.on('find:stop', (e) => e.sender.stopFindInPage('keepSelection'));

ipcMain.handle('export:pdf', async (e, { file, isHtml, suggested }) => {
  const win = winOf(e);
  const res = await dialog.showSaveDialog(win, {
    title: 'Export as PDF',
    defaultPath: path.join(path.dirname(file), `${suggested}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  let data;
  const opts = { printBackground: true, pageSize: 'Letter', preferCSSPageSize: true };
  if (isHtml) {
    const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    pageRoots.add(path.dirname(file));
    await hidden.loadURL(toPageUrl(file));
    await new Promise((r) => setTimeout(r, 700));
    data = await hidden.webContents.printToPDF(opts);
    hidden.destroy();
  } else {
    data = await e.sender.printToPDF(opts);
  }
  await fsp.writeFile(res.filePath, data);
  shell.showItemInFolder(res.filePath);
  return { path: res.filePath };
});

ipcMain.handle('export:html', async (e, { file, html, suggested }) => {
  const res = await dialog.showSaveDialog(winOf(e), {
    title: 'Export as HTML',
    defaultPath: path.join(path.dirname(file), `${suggested}.html`),
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  await fsp.writeFile(res.filePath, html, 'utf8');
  shell.showItemInFolder(res.filePath);
  return { path: res.filePath };
});

/* ---- images: read bytes (decoding iPhone HEIC / TIFF with macOS sips), write optimized output ---- */
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.avif', '.heic', '.heif', '.tif', '.tiff']);
const NEEDS_SIPS = new Set(['.heic', '.heif', '.tif', '.tiff']);
ipcMain.handle('img:read', async (_e, file) => {
  const ext = path.extname(file).toLowerCase();
  if (!IMG_EXT.has(ext)) throw new Error('unsupported image type');
  const original = await fsp.stat(file);
  if (NEEDS_SIPS.has(ext)) {
    // Chromium can't decode HEIC/TIFF, but every Mac ships `sips`, which can.
    if (!isMac) throw new Error('HEIC and TIFF need macOS');
    const tmp = path.join(app.getPath('temp'), `tomelight-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    await new Promise((resolve, reject) => {
      require('node:child_process').execFile('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', tmp], (err) => (err ? reject(new Error('could not decode this photo')) : resolve()));
    });
    const buf = await fsp.readFile(tmp);
    fsp.unlink(tmp).catch(() => {});
    return { bytes: new Uint8Array(buf), size: original.size };
  }
  const buf = await fsp.readFile(file);
  return { bytes: new Uint8Array(buf), size: buf.length };
});
ipcMain.handle('img:write', async (_e, { source, bytes, ext = '.webp', subdir = '', name = '' }) => {
  const p = path.parse(source);
  const dir = subdir ? path.join(p.dir, subdir) : p.dir;
  if (subdir) await fsp.mkdir(dir, { recursive: true });
  const base = name || p.name;
  let out = path.join(dir, `${base}${ext}`);
  if (out === source || fs.existsSync(out)) {
    let i = 1;
    do { out = path.join(dir, `${base}-web${i > 1 ? `-${i}` : ''}${ext}`); i++; } while (fs.existsSync(out));
  }
  await fsp.writeFile(out, Buffer.from(bytes));
  return { path: out };
});
/* ---- sticky notes: kept in the app's own data, never inside the user's files ---- */
let notesDb = null;
let notesTimer = null;
const notesFile = () => path.join(app.getPath('userData'), 'notes.json');
function notes() {
  if (!notesDb) { try { notesDb = JSON.parse(fs.readFileSync(notesFile(), 'utf8')); } catch { notesDb = {}; } }
  return notesDb;
}
function persistNotes(now = false) {
  clearTimeout(notesTimer);
  const write = () => { try { fs.mkdirSync(path.dirname(notesFile()), { recursive: true }); fs.writeFileSync(notesFile(), JSON.stringify(notesDb, null, 1)); } catch (e) { console.error('notes save failed', e); } };
  if (now) write(); else notesTimer = setTimeout(write, 400);
}
ipcMain.handle('notes:get', (_e, file) => notes()[file] || []);
ipcMain.handle('notes:set', (_e, { file, notes: list }) => {
  const db = notes();
  if (list && list.length) db[file] = list; else delete db[file];
  persistNotes();
  return true;
});

ipcMain.handle('notes:count', () => {
  const db = notes();
  const files = Object.keys(db).length;
  return { files, notes: Object.values(db).reduce((n, l) => n + l.length, 0) };
});
ipcMain.handle('notes:clear-all', () => { notesDb = {}; persistNotes(true); broadcast('notes:cleared'); return true; });

ipcMain.handle('img:save-zip', async (e, bytes) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(winOf(e), {
    title: 'Download Optimized Images',
    defaultPath: path.join(app.getPath('downloads'), `optimized-images-${stamp}.zip`),
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  await fsp.writeFile(res.filePath, Buffer.from(bytes));
  return { path: res.filePath };
});
ipcMain.handle('img:pick', async (e) => {
  const res = await dialog.showOpenDialog(winOf(e), {
    title: 'Optimize Images for the Web',
    buttonLabel: 'Optimize',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'heif', 'gif', 'webp', 'avif', 'tif', 'tiff', 'bmp'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('app:asset-text', async (_e, rel) => {
  const base = path.dirname(RENDERER);
  const p = path.join(base, rel);
  if (!p.startsWith(base)) throw new Error('bad path');
  return fsp.readFile(p, 'utf8');
});

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */
function send(channel, ...args) {
  const w = BrowserWindow.getFocusedWindow() || lastFocused;
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
}
let menuTimer = null;
function scheduleMenu() { clearTimeout(menuTimer); menuTimer = setTimeout(buildMenu, 60); }
function buildMenu() {
  const recentItems = [];
  if (settings.recentFolders.length) {
    settings.recentFolders.slice(0, 6).forEach((f) => recentItems.push({ label: `${path.basename(f)}/`, sublabel: f, click: () => openPath(f) }));
    recentItems.push({ type: 'separator' });
  }
  settings.recent.slice(0, 12).forEach((f) => recentItems.push({ label: path.basename(f), sublabel: f, click: () => openPath(f) }));
  if (recentItems.length) recentItems.push({ type: 'separator' }, { label: 'Clear Recent', click: () => ipcMain.emit('recent:clear') });
  else recentItems.push({ label: 'No Recent Files', enabled: false });

  const themeItem = (id, label) => ({
    label, type: 'radio', checked: settings.theme === id,
    click: () => { settings.theme = id; persistSettings(); broadcast('settings:changed', publicSettings()); },
  });

  const template = [
    ...(isMac ? [{
      label: 'Tomelight',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('ui:settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New File…', accelerator: 'CmdOrCtrl+N', click: () => send('file:new') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => showOpenDialog(BrowserWindow.getFocusedWindow()) },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => showOpenDialog(BrowserWindow.getFocusedWindow(), { folders: true }) },
        { label: 'Open Recent', submenu: recentItems },
        { label: 'Quick Open…', accelerator: 'CmdOrCtrl+P', click: () => send('ui:quick-open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
        { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', click: () => send('file:save-all') },
        { label: 'Reveal in Finder', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('file:reveal') },
        { type: 'separator' },
        { label: 'Image Studio…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('img:optimize') },
        { type: 'separator' },
        { label: 'Export as PDF…', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('export:pdf') },
        { label: 'Export as HTML…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('export:html') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.send('tab:close'); } },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.close(); } },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('edit:undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('edit:redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => send('edit:select-all') },
        { type: 'separator' },
        { label: 'Paste as Markdown', accelerator: 'CmdOrCtrl+Shift+V', click: () => send('edit:paste-md') },
        { type: 'separator' },
        { label: 'Copy for Email (Rich Text)', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('copy:as', 'rich') },
        { label: 'Copy for Web (Clean HTML)', accelerator: 'CmdOrCtrl+Alt+H', click: () => send('copy:as', 'html') },
        { label: 'Copy for Social (Plain Text)', accelerator: 'CmdOrCtrl+Alt+C', click: () => send('copy:as', 'plain') },
        { type: 'separator' },
        { label: 'Add Sticky Note', accelerator: 'CmdOrCtrl+Alt+N', click: () => send('note:add') },
        { label: 'Show / Hide Sticky Notes', accelerator: 'CmdOrCtrl+Alt+Shift+N', click: () => send('note:toggle') },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('ui:find') },
        { type: 'separator' },
        { label: 'Mark as Done', accelerator: 'CmdOrCtrl+D', click: () => send('doc:toggle-done') },
        { label: 'Complete All Tasks', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('doc:complete-all') },
        { label: 'Tidy Formatting', accelerator: 'CmdOrCtrl+Alt+T', click: () => send('doc:tidy') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: () => send('ui:palette') },
        { type: 'separator' },
        { label: 'Read', accelerator: 'CmdOrCtrl+1', click: () => send('view:set-mode', 'read') },
        { label: 'Write', accelerator: 'CmdOrCtrl+2', click: () => send('view:set-mode', 'write') },
        { label: 'Split (Markdown + Preview)', accelerator: 'CmdOrCtrl+3', click: () => send('view:set-mode', 'split') },
        { label: 'Source', accelerator: 'CmdOrCtrl+4', click: () => send('view:set-mode', 'source') },
        { label: 'Switch Read / Write', accelerator: 'CmdOrCtrl+E', click: () => send('view:toggle-edit') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => send('ui:toggle-sidebar') },
        { label: 'Show Folder', accelerator: 'CmdOrCtrl+Shift+1', click: () => send('ui:panel', 'folder') },
        { label: 'Show Outline', accelerator: 'CmdOrCtrl+Shift+2', click: () => send('ui:panel', 'outline') },
        { label: 'Focus Mode', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('ui:focus') },
        { type: 'separator' },
        { label: 'Theme', submenu: [
          themeItem('wire', 'Wire (Cyber-Noir)'),
          themeItem('nebula', 'Nebula (Midnight Blue)'),
          themeItem('arcane', 'Arcane (Dark)'),
          themeItem('parchment', 'Parchment (Light)'),
          themeItem('auto', 'Auto (Follow macOS)'),
        ] },
        { type: 'separator' },
        { label: 'Bigger Text', accelerator: 'CmdOrCtrl+=', click: () => send('view:zoom', 1) },
        // Same action for ⌘+ typed with Shift, and the keypad plus, so every "zoom in" habit works.
        { label: 'Bigger Text ', accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: () => send('view:zoom', 1) },
        { label: 'Bigger Text  ', accelerator: 'CmdOrCtrl+numadd', visible: false, acceleratorWorksWhenHidden: true, click: () => send('view:zoom', 1) },
        { label: 'Smaller Text ', accelerator: 'CmdOrCtrl+numsub', visible: false, acceleratorWorksWhenHidden: true, click: () => send('view:zoom', -1) },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: () => send('view:zoom', -1) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => send('view:zoom', 0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }, { role: 'reload' }]),
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => send('tab:cycle', 1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => send('tab:cycle', -1) },
        { label: 'Next Tab ', accelerator: 'CmdOrCtrl+Shift+]', click: () => send('tab:cycle', 1) },
        { label: 'Previous Tab ', accelerator: 'CmdOrCtrl+Shift+[', click: () => send('tab:cycle', -1) },
        { type: 'separator' },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('tab:reopen') },
        { label: 'Close Other Tabs', click: () => send('tab:close-others') },
        { label: 'Close All Tabs', accelerator: 'CmdOrCtrl+Alt+W', click: () => send('tab:close-all') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('ui:shortcuts') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */
// macOS delivers files (and folders dropped on the Dock icon) via open-file, sometimes before 'ready'.
app.on('open-file', (e, file) => {
  e.preventDefault();
  openPath(file);
});

function argPaths(argv) {
  return argv.filter((a) => !a.startsWith('-') && a !== '.' && fs.existsSync(a)
    && (isDir(a) || SUPPORTED.has(path.extname(a).toLowerCase())))
    .filter((a) => !a.endsWith('.app') && !a.includes('/Contents/MacOS/') && !a.endsWith('.js') && path.resolve(a) !== path.resolve(app.getAppPath()));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another copy is already running and will open whatever we were given.
  // Exit right away: a graceful quit() before the app is ready can crash on macOS.
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv) => {
    const files = argPaths(argv.slice(1));
    if (files.length) files.forEach((f) => openPath(f));
    else {
      const w = targetWindow();
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(() => {
    handlePageProtocol();
    loadSettings();
    app.setAboutPanelOptions({
      applicationName: 'Tomelight',
      applicationVersion: app.getVersion(),
      copyright: 'Your docs, beautifully lit.',
    });
    appReady = true;
    buildMenu();
    nativeTheme.on('updated', () => broadcast('theme:system', nativeTheme.shouldUseDarkColors));

    const initial = [...pending, ...argPaths(process.argv.slice(app.isPackaged ? 1 : 2))];
    pending = [];
    const win = createWindow({ restore: settings.restoreSession });
    initial.forEach((p) => openPath(p, { win }));
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ restore: settings.restoreSession });
  });
  app.on('before-quit', () => { quitting = true; persistSettings(true); if (notesDb) persistNotes(true); });
  app.on('window-all-closed', () => {
    persistSettings(true);
    if (!isMac) app.quit();
  });
}
