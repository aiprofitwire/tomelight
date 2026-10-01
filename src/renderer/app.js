/**
 * Tomelight renderer: workspace (folder + tabs), views, interactions.
 */
import DOMPurify from 'dompurify';
import {
  renderMarkdown, tidyMarkdown, describeFixes, splitFrontMatter, toggleTaskAt, toggleCellAt, addCheckAt, setAllTasks, toggleDoneSeal, slugify,
} from './markdown.js';
import { createEditor, format } from './editor.js';
import { createWriter } from './writer.js';
import { initWelcomeGL } from './welcome-gl.js';
import { icon, emblem } from './icons.js';
import { optimizeImage, prettyBytes, altFromName, IMG_RE, seoName, scrubMetadata } from './webp.js';
import { zipSync } from 'fflate';
import { cleanFragment, toHtml, toPlain, socialCounts, htmlToMarkdown } from './copyas.js';

const api = window.tomelight;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const isMac = api.platform === 'darwin';
const MOD = isMac ? '⌘' : 'Ctrl+';
const DOC_RE = /\.(md|markdown|mdown|mkd|mdx|html?|txt)$/i;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseName = (p) => p.split('/').pop();
const dirName = (p) => p.split('/').slice(0, -1).join('/') || '/';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const state = {
  settings: null,
  folder: null,            // workspace root
  expanded: new Set(),     // expanded dirs in the tree
  treeCache: new Map(),    // dir -> entries
  tabs: [],
  activeId: null,
  closed: [],              // recently closed files (reopen)
  editor: null,
  systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  outlineActive: null,
  find: { ranges: [], idx: -1, text: '' },
  mermaidCache: new Map(),
  walkCache: null,
};
let tabSeq = 0;
const cur = () => state.tabs.find((t) => t.id === state.activeId) || null;

const MODES = {
  md: [
    { id: 'read', label: 'Read', icon: 'read', tip: `Read  ${MOD}1` },
    { id: 'write', label: 'Write', icon: 'pencil', tip: `Write like a normal document  ${MOD}2` },
    { id: 'split', label: 'Split', icon: 'split', tip: `Markdown + preview  ${MOD}3` },
    { id: 'source', label: 'Source', icon: 'source', tip: `Raw Markdown  ${MOD}4` },
  ],
  html: [
    { id: 'read', label: 'Page', icon: 'globe', tip: `Original page  ${MOD}1` },
    { id: 'reader', label: 'Reader', icon: 'reader', tip: 'Clean reading view' },
    { id: 'split', label: 'Split', icon: 'split', tip: `Edit + live page  ${MOD}3` },
    { id: 'source', label: 'Source', icon: 'source', tip: `Source  ${MOD}4` },
  ],
};
const kindOf = (ext) => (ext === '.html' || ext === '.htm' ? 'html' : ext === '.txt' ? 'txt' : 'md');
const modesFor = (t) => (t && t.kind === 'html' ? MODES.html : t && t.kind === 'txt' ? MODES.md.filter((m) => m.id !== 'write') : MODES.md);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
async function boot() {
  state.settings = await api.getSettings();
  document.body.classList.toggle('is-mac', isMac);
  if (state.settings.sidebarPanel === 'images') state.settings = await api.setSettings({ sidebarPanel: 'folder' });
  applySettings();
  paintStatic();
  state.editor = createEditor($('#editor-host'), {
    onChange: onEditorChange,
    onScrollLine: syncPreviewToLine,
    onSave: () => save(cur(), true),
  });
  bindUI();
  bindSelection();
  bindStudio();
  bindNotes();
  bindLinkPop();
  bindCommands();

  api.onSettings((s) => {
    const prevTheme = effectiveTheme();
    state.settings = s;
    applySettings();
    renderSidebar();
    if (!cur()) renderWelcome();
    renderStudio();
    if (prevTheme !== effectiveTheme()) rerenderMermaid();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { state.systemDark = e.matches; applySettings(); rerenderMermaid(); });
  api.onOpenFile((file) => openTab(file));
  api.onOpenFolder((dir) => openFolder(dir));
  api.onChangedOnDisk(onDiskChange);
  api.onFolderChanged(() => { state.treeCache.clear(); state.walkCache = null; if (state.settings.sidebarPanel === 'folder') renderFolderPanel(); if (!cur()) renderWelcome(); });
  api.onBeforeClose(async () => {
    await flushAll();
    saveSessionNow();
    api.closeOk();
  });

  if (new URLSearchParams(location.search).get('restore') && state.settings.session) await restoreSession(state.settings.session);
  if (!state.tabs.length) showWelcome();
  requestAnimationFrame(() => document.body.classList.remove('booting'));
  api.ready();
}

async function restoreSession(s) {
  if (s.folder && (await api.pathInfo(s.folder)).dir) {
    state.folder = s.folder;
    state.expanded = new Set(s.expanded || [s.folder]);
    api.watchFolder(s.folder);
  }
  for (const f of s.tabs || []) {
    // eslint-disable-next-line no-await-in-loop
    await openTab(f, { activate: false, quiet: true });
  }
  const active = state.tabs.find((t) => t.file === s.active) || state.tabs[0];
  if (active) activate(active.id);
  renderSidebar();
}

const TOOLBAR = [
  { k: 'h1', label: 'H1', tip: 'Big heading' }, { k: 'h2', label: 'H2', tip: 'Section heading' }, { k: 'h3', label: 'H3', tip: 'Small heading' },
  '|',
  { k: 'bold', icon: 'bold', tip: `Bold  ${MOD}B` }, { k: 'italic', icon: 'italic', tip: `Italic  ${MOD}I` }, { k: 'strike', icon: 'strike', tip: 'Strikethrough' },
  '|',
  { k: 'ul', icon: 'list', tip: 'Bullet list' }, { k: 'ol', icon: 'listOl', tip: 'Numbered list' }, { k: 'task', icon: 'checkSquare', tip: `Checklist  ${MOD}↩` },
  '|',
  { k: 'quote', icon: 'quote', tip: 'Quote' }, { k: 'link', icon: 'link', tip: 'Link' }, { k: 'code', icon: 'source', tip: 'Code' },
  { k: 'table', icon: 'table', tip: 'Table' }, { k: 'check-table', icon: 'checks', tip: 'Checklist table (Done column)' }, { k: 'hr', icon: 'minus', tip: 'Divider line' },
  '|',
  { k: 'image', icon: 'image', tip: 'Insert image (auto converts to WebP)' },
  '|',
  { k: 'tidy', icon: 'sparkles', tip: 'Tidy: fix spacing, line breaks and bullets' },
];
function paintToolbar() {
  $('#md-toolbar').innerHTML = TOOLBAR.map((b) => (b === '|' ? '<span class="tb-sep"></span>'
    : `<button type="button" data-fmt="${b.k}" data-tip="${b.tip}">${b.icon ? icon(b.icon) : `<b>${b.label}</b>`}</button>`)).join('')
    + '<span class="tb-hint">Formatting buttons write Markdown for you</span>';
  $('#md-toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#md-toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-fmt]');
    if (!b) return;
    if (b.dataset.fmt === 'image') { pickAndInsert(); return; }
    if (b.dataset.fmt === 'tidy') { tidyCurrent(); return; }
    format(state.editor.view, b.dataset.fmt);
  });
}

function paintStatic() {
  paintToolbar();
  $('#btn-sidebar').innerHTML = icon('sidebar');
  $('#btn-studio').innerHTML = icon('image');
  $('#btn-more').innerHTML = icon('more');
  $('#btn-close-all').innerHTML = icon('x');
  $('#btn-hide-side').innerHTML = icon('up', 'rot-left');
  $('#sidebar-reveal').innerHTML = `${icon('up', 'rot-right')}<span>Sidebar</span>`;
  $('#btn-palette .pb-icon').innerHTML = icon('search');
  $('#btn-seal').innerHTML = `${icon('seal')}<span>Mark Done</span>`;
  $('#btn-copy').innerHTML = `${icon('clipboard')}<span>Copy for…</span>`;
  $('#welcome-emblem').innerHTML = emblem('w');
  $('.dz-emblem').innerHTML = emblem('d');
  $('#w-open .bi').innerHTML = icon('open');
  $('#w-folder .bi').innerHTML = icon('folder');
  $('#w-new .bi').innerHTML = icon('plus');
  $('#find-prev').innerHTML = icon('up');
  $('#find-next').innerHTML = icon('up', 'flip');
  $('#find-close').innerHTML = icon('x');
  $('.fb-icon').innerHTML = icon('search');
  $('.pi-icon').innerHTML = icon('search');
  // The welcome light: a live-rendered beam rising from the mark.
  state.gl = initWelcomeGL($('#welcome-gl'), {
    isActive: () => document.body.classList.contains('is-welcome'),
    getOrigin: () => {
      const r = $('#welcome-emblem').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.48 };
    },
  });
  if (!state.gl) $('#welcome').classList.add('no-gl'); // no GPU: a still, CSS-painted beam instead
  const mark = $('#welcome-emblem'); const word = $('#wordmark');
  [mark, word].forEach((el) => {
    el.addEventListener('mouseenter', () => { state.gl?.setHover(true); document.body.classList.add('mark-hover'); });
    el.addEventListener('mouseleave', () => { state.gl?.setHover(false); document.body.classList.remove('mark-hover'); });
  });
}
function playWelcome() {
  const w = $('#welcome');
  const first = !state.introPlayed;
  state.introPlayed = true;
  w.classList.remove('intro', 'intro-quick');
  void w.offsetWidth;
  w.classList.add(first ? 'intro' : 'intro-quick');
  requestAnimationFrame(() => state.gl?.play(first));
}

/* ------------------------------------------------------------------ */
/* Settings & theme                                                     */
/* ------------------------------------------------------------------ */
function effectiveTheme() {
  const t = state.settings.theme;
  if (t === 'auto') return state.systemDark ? 'nebula' : 'parchment';
  return t;
}
const isDark = () => effectiveTheme() !== 'parchment';
function applySettings() {
  const s = state.settings;
  const b = document.body;
  b.classList.remove('theme-arcane', 'theme-parchment', 'theme-nebula', 'theme-wire');
  b.classList.add(`theme-${effectiveTheme()}`);
  b.dataset.font = s.bodyFont;
  b.dataset.width = s.width;
  b.classList.toggle('no-sidebar', !s.sidebar);
  b.classList.toggle('strike-done', !!s.strikeDone);
  document.documentElement.style.setProperty('--scale', s.fontScale);
  syncZoomUI();
  const breaks = s.showLineBreaks !== false;
  requestAnimationFrame(() => state.gl?.refreshColors());
  if (renderMarkdown.breaks !== breaks) {
    const first = renderMarkdown.breaks === undefined;
    renderMarkdown.breaks = breaks;
    if (!first && cur() && cur().kind !== 'html' && cur().mode !== 'write' && cur().mode !== 'source') renderPreview();
  }
  document.documentElement.style.setProperty('--sidebar-w', `${s.sidebarWidth || 290}px`);
  $$('#side-switch button').forEach((btn) => btn.classList.toggle('active', btn.dataset.panel === s.sidebarPanel));
  moveSwitchGlider();
  updateSaveStatus();
}
const setSetting = (patch) => api.setSettings(patch);

/* ------------------------------------------------------------------ */
/* Session                                                              */
/* ------------------------------------------------------------------ */
let sessionTimer = null;
function saveSession() { clearTimeout(sessionTimer); sessionTimer = setTimeout(saveSessionNow, 300); }
function saveSessionNow() {
  clearTimeout(sessionTimer);
  api.setSession({
    folder: state.folder,
    expanded: [...state.expanded].slice(0, 200),
    tabs: state.tabs.map((t) => t.file),
    active: cur()?.file || null,
  });
}
function updateWindowTitle() {
  const t = cur();
  const folder = state.folder ? baseName(state.folder) : null;
  api.setTitle(t ? `${t.doc.name}${folder ? ` · ${folder}` : ''}` : folder || 'Tomelight', t ? t.file : '');
  api.setEdited(state.tabs.some((x) => x.dirty));
}

/* ------------------------------------------------------------------ */
/* Folder / workspace                                                   */
/* ------------------------------------------------------------------ */
async function openFolder(dir) {
  if (state.folder !== dir) {
    state.folder = dir;
    state.expanded = new Set([dir]);
    state.treeCache.clear();
    state.walkCache = null;
  }
  api.watchFolder(dir);
  if (!state.settings.sidebar) await setSetting({ sidebar: true });
  if (state.settings.sidebarPanel !== 'folder') await setSetting({ sidebarPanel: 'folder' });
  renderSidebar();
  if (!cur()) renderWelcome();
  updateWindowTitle();
  saveSession();
}
function closeFolder() {
  state.folder = null;
  state.treeCache.clear();
  state.walkCache = null;
  api.watchFolder(null);
  renderSidebar();
  if (!cur()) renderWelcome();
  updateWindowTitle();
  saveSession();
}
/** The folder the tree shows: the workspace, or the active tome's own folder. */
const treeRoot = () => state.folder || (cur() ? cur().doc.dir : null);

/* ------------------------------------------------------------------ */
/* Tabs                                                                 */
/* ------------------------------------------------------------------ */
async function openTab(file, { activate: act = true, quiet = false, mode = null } = {}) {
  const existing = state.tabs.find((t) => t.file === file);
  if (existing) { if (act) activate(existing.id); return existing; }
  let doc;
  try { doc = await api.readFile(file); } catch {
    if (!quiet) toast(`Could not open ${baseName(file)}`, 'error');
    return null;
  }
  const again = state.tabs.find((t) => t.file === file); // opened while we awaited
  if (again) { if (act) activate(again.id); return again; }
  const kind = kindOf(doc.ext);
  const t = {
    id: ++tabSeq, file: doc.file, doc, kind,
    content: doc.content, lastSaved: doc.content, dirty: false,
    mode: mode || 'read', render: null, undo: [], redo: [], savedAt: null,
    edState: null, edScroll: 0, previewScroll: 0,
  };
  if (kind !== 'html') t.render = renderMarkdown(t.content, { plain: kind === 'txt' });
  await ensureNotes(t);
  const at = state.tabs.findIndex((x) => x.id === state.activeId);
  state.tabs.splice(at >= 0 ? at + 1 : state.tabs.length, 0, t);
  api.watchFiles(state.tabs.map((x) => x.file));
  if (act) activate(t.id); else renderTabs();
  saveSession();
  return t;
}

function stashActive() {
  const t = cur();
  if (!t) return;
  if (t.mode === 'write') flushWriter(t);
  t.previewScroll = $('#preview-pane').scrollTop;
  if (t.edState) { t.edState = state.editor.state; t.edScroll = state.editor.scrollTop; }
}

function activate(id) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  if (state.activeId !== id) stashActive();
  state.activeId = id;
  document.body.classList.remove('is-welcome');
  document.body.dataset.kind = t.kind;
  hideBanner();
  closeFind();
  if (t.edState) state.editor.load(t.edState, t.edScroll);
  buildModes();
  setMode(t.mode, { force: true, restoreScroll: true });
  renderCrumbs();
  renderTabs();
  if (state.settings.sidebarPanel === 'folder') revealInTree(t.file); else renderSidebar();
  updateWindowTitle();
  saveSession();
}

async function closeTab(id, { skipConfirm = false } = {}) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.dirty) {
    if (state.settings.autosave || skipConfirm) await save(t);
    else if (window.confirm(`Save changes to ${t.doc.name}?`)) await save(t);
  }
  const idx = state.tabs.indexOf(t);
  state.tabs.splice(idx, 1);
  state.closed.push(t.file);
  if (state.closed.length > 30) state.closed.shift();
  api.watchFiles(state.tabs.map((x) => x.file));
  if (state.activeId === id) {
    state.activeId = null;
    const next = state.tabs[idx] || state.tabs[idx - 1];
    if (next) activate(next.id); else showWelcome();
  } else renderTabs();
  updateWindowTitle();
  saveSession();
}
async function closeOthers(id) { for (const t of [...state.tabs]) if (t.id !== id) await closeTab(t.id); }
async function closeAll() { for (const t of [...state.tabs]) await closeTab(t.id); }
function cycleTab(d) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.findIndex((t) => t.id === state.activeId);
  activate(state.tabs[(i + d + state.tabs.length) % state.tabs.length].id);
}
async function reopenClosed() {
  while (state.closed.length) {
    const f = state.closed.pop();
    if (!state.tabs.some((t) => t.file === f)) { await openTab(f); return; }
  }
  toast('No closed tabs to reopen', 'quiet');
}

function showWelcome() {
  state.activeId = null;
  document.body.classList.add('is-welcome');
  document.body.dataset.kind = '';
  document.body.dataset.mode = '';
  renderWelcome();
  playWelcome();
  renderCrumbs();
  renderTabs();
  renderSidebar();
  updateWindowTitle();
  $('#progress').hidden = true;
  $('#btn-seal').hidden = true;
  $('#btn-copy').hidden = true;
  $('#modes').innerHTML = '';
  $('#sb-type').textContent = ''; $('#sb-words').textContent = state.folder ? shortPath(state.folder) : ''; $('#sb-tasks').textContent = ''; $('#sb-save').textContent = '';
}

/* ---- tab list (vertical tabs in the sidebar) ---- */
function miniRing(tasks) {
  if (!tasks || !tasks.total) return '';
  const done = tasks.done === tasks.total;
  // A count reads instantly; a partial ring looked like a loading spinner.
  return `<span class="mini-ring ${done ? 'complete' : ''}" title="${tasks.done} of ${tasks.total} tasks done">${done ? icon('check') : `<b>${tasks.done}</b>/${tasks.total}`}</span>`;
}
function renderTabs() {
  const list = $('#tabs-list');
  $('#tab-count').textContent = state.tabs.length ? state.tabs.length : '';
  $('#btn-close-all').hidden = !state.tabs.length;
  if (!state.tabs.length) {
    list.innerHTML = '<div class="tabs-empty">No files open. Pick one from the folder below or press <kbd>⌘P</kbd>.</div>';
    return;
  }
  // Show the folder name next to duplicates like README.md
  const counts = {};
  state.tabs.forEach((t) => { counts[t.doc.name] = (counts[t.doc.name] || 0) + 1; });
  list.innerHTML = state.tabs.map((t) => {
    const hint = counts[t.doc.name] > 1 ? `<small>${escapeHtml(baseName(t.doc.dir))}</small>` : '';
    const ic = t.kind === 'html' ? 'globe' : 'file';
    const sealed = t.render && t.render.sealed;
    return `<div class="tab-item ${t.id === state.activeId ? 'active' : ''} ${t.dirty ? 'dirty' : ''} ${sealed ? 'sealed' : ''}" data-id="${t.id}" draggable="true" title="${escapeHtml(shortPath(t.file))}">
      <span class="ti-icon ${t.kind}">${sealed ? icon('seal') : icon(ic)}</span>
      <span class="ti-name">${escapeHtml(t.doc.name)}${hint}</span>
      ${miniRing(t.kind !== 'html' && t.render ? t.render.tasks : null)}
      <span class="ti-dirty"></span>
      <button class="ti-close" data-close="${t.id}" title="Close  ${MOD}W">${icon('x')}</button>
    </div>`;
  }).join('');
  const act = $('.tab-item.active', list);
  if (act) act.scrollIntoView({ block: 'nearest' });
}
function refreshTabChip(t) {
  // cheap update of one tab row (progress, dirty) without rebuilding the list
  const el = $(`.tab-item[data-id="${t.id}"]`);
  if (!el) { renderTabs(); return; }
  el.classList.toggle('dirty', t.dirty);
  const sealed = !!(t.render && t.render.sealed);
  if (el.classList.contains('sealed') !== sealed) { renderTabs(); return; }
  const ring = el.querySelector('.mini-ring');
  const html = miniRing(t.kind !== 'html' && t.render ? t.render.tasks : null);
  if (ring) ring.outerHTML = html || '<span hidden></span>';
  else if (html) el.querySelector('.ti-dirty').insertAdjacentHTML('beforebegin', html);
}

/* ------------------------------------------------------------------ */
/* Modes                                                                */
/* ------------------------------------------------------------------ */
function buildModes() {
  $('#modes').innerHTML = modesFor(cur()).map((m) => `<button data-mode="${m.id}" data-tip="${m.tip}">${icon(m.icon)}<span>${m.label}</span></button>`).join('')
    + '<span class="seg-glider"></span>';
}

function setMode(mode, { force = false, line = null, restoreScroll = false, focusText = null } = {}) {
  const t = cur();
  if (!t) return;
  if (!modesFor(t).some((m) => m.id === mode)) mode = 'read';
  const prev = t.mode;
  if (prev === 'write' && mode !== 'write') flushWriter(t);
  if (mode !== 'write' && $('#banner').dataset.kind === 'write-tip') hideBanner();
  t.mode = mode;
  document.body.dataset.mode = mode;
  $$('#modes button').forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  requestAnimationFrame(moveGlider);

  const needsEditor = mode === 'split' || mode === 'source';
  if (needsEditor) {
    if (!t.edState) {
      t.edState = state.editor.newState(t.content, t.kind === 'html' ? 'html' : 'markdown');
      state.editor.load(t.edState, 0);
    } else if (force) {
      state.editor.load(t.edState, t.edScroll);
      if (state.editor.value !== t.content) state.editor.setValue(t.content);
    }
  }

  if (t.kind === 'html') {
    if (mode === 'read') loadFrame(t);
    if (mode === 'split') loadFrameSrcdoc(t, true);
    if (mode === 'reader') renderReader(t);
  } else if (mode === 'write') {
    if (force || prev !== 'write') enterWrite(t, { focusText });
  } else if (mode !== 'source' && (force || prev === 'source' || prev === 'write')) {
    renderPreview();
  }
  if (t.kind === 'html' || mode === 'source' || mode === 'write') renderNotes();
  if (restoreScroll) requestAnimationFrame(() => { $('#preview-pane').scrollTop = t.previewScroll || 0; });
  updateChrome();
  if (needsEditor && !restoreScroll) requestAnimationFrame(() => { if (line != null) state.editor.focusLine(line); else state.editor.focus(); });
  saveSession();
}
function moveGlider() {
  const active = $('#modes button.active');
  const g = $('#modes .seg-glider');
  if (!active || !g) return;
  g.style.width = `${active.offsetWidth}px`;
  g.style.transform = `translateX(${active.offsetLeft - 3}px)`;
}
function moveSwitchGlider() {
  const active = $('#side-switch button.active');
  const g = $('#side-switch .switch-glider');
  if (!active || !g) return;
  g.style.width = `${active.offsetWidth}px`;
  g.style.transform = `translateX(${active.offsetLeft - 3}px)`;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */
const PURIFY = {
  ADD_ATTR: ['target', 'aria-checked', 'tabindex', 'role', 'data-line', 'data-item-line', 'data-kind', 'data-cell'],
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
};

function renderPreview({ animateSeal = false } = {}) {
  const t = cur();
  if (!t || t.kind === 'html') return;
  const r = renderMarkdown(t.content, { plain: t.kind === 'txt' });
  t.render = r;
  const tome = $('#tome');
  let html = DOMPurify.sanitize(r.html, PURIFY);
  if (r.meta && Object.keys(r.meta).length) html = metaCard(r.meta) + html;
  tome.innerHTML = html;
  decorate(tome, t, { animateSeal });
  updateChrome();
  refreshTabChip(t);
  if (r.hasMermaid) renderMermaid(tome).then(relayoutNotes);
  renderNotes();
  if (state.find.text) runFind(state.find.text, { keepIndex: true });
}

function metaCard(meta) {
  const rows = Object.entries(meta).slice(0, 14).map(([k, v]) => {
    let val;
    if (Array.isArray(v)) val = v.map((x) => `<span class="chip">${escapeHtml(typeof x === 'object' ? JSON.stringify(x) : x)}</span>`).join('');
    else if (v instanceof Date) val = escapeHtml(v.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }));
    else if (v && typeof v === 'object') val = `<code>${escapeHtml(JSON.stringify(v))}</code>`;
    else val = escapeHtml(v);
    return `<div class="meta-row"><span class="meta-key">${escapeHtml(k)}</span><span class="meta-val">${val}</span></div>`;
  }).join('');
  return `<div class="meta-card">${rows}</div>`;
}

function resolveUrl(href, t = cur()) {
  try { return new URL(href, t.doc.dirUrl); } catch { return null; }
}

const ICON_KINDS = { note: 1, info: 1, tip: 1, important: 1, warning: 1, caution: 1, danger: 1, success: 1, question: 1, todo: 1 };
/** Post-process the rendered article: images, ghost checks, callout icons, seal. */
function decorate(root, t, { animateSeal = false } = {}) {
  $$('img', root).forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && !/^(https?:|data:|blob:|file:)/i.test(src)) {
      const u = src.startsWith('/') ? new URL(`file://${src}`) : resolveUrl(src, t);
      if (u) img.src = u.href;
    }
    img.loading = 'lazy';
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  });
  $$('.callout-icon', root).forEach((el) => { el.innerHTML = icon(el.dataset.kind in ICON_KINDS ? el.dataset.kind : 'note'); });
  $$('.done-seal', root).forEach((bq) => {
    const p = bq.querySelector('p');
    if (p) p.innerHTML = p.innerHTML.replace(/^\s*✅\s*/, '');
    const seal = document.createElement('span');
    seal.className = `wax${animateSeal ? ' stamp' : ''}`;
    seal.innerHTML = icon('check');
    bq.prepend(seal);
  });
  $$('h1, h2, h3', root).forEach((h) => {
    const b = document.createElement('button');
    b.className = 'heading-copy';
    b.type = 'button';
    b.title = 'Copy this section';
    b.innerHTML = icon('clipboard');
    const n = document.createElement('button');
    n.className = 'heading-note';
    n.type = 'button';
    n.title = 'Add a sticky note here';
    n.innerHTML = icon('sticky');
    h.prepend(n, b);
  });
  if (t.kind !== 'html') {
    $$('li.plain-item', root).forEach((li) => {
      const line = li.dataset.itemLine;
      if (line == null || line === '-1') return;
      const b = document.createElement('button');
      b.className = 'ghost-check';
      b.dataset.line = line;
      b.type = 'button';
      b.title = 'Check this off';
      b.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>';
      li.prepend(b);
    });
  }
}

/* ---- mermaid (loaded lazily, only when a tome contains a diagram) ---- */
let mermaidLoading = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidLoading) {
    mermaidLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/mermaid.min.js';
      s.onload = () => resolve(window.mermaid);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return mermaidLoading;
}
let mermaidTheme = null;
let mermaidSeq = 0;
async function renderMermaid(root) {
  const blocks = $$('.mermaid-block', root);
  if (!blocks.length) return;
  let mermaid;
  try { mermaid = await loadMermaid(); } catch { return; }
  const theme = effectiveTheme();
  if (mermaidTheme !== theme) {
    const cs = getComputedStyle(document.body);
    const v = (n) => cs.getPropertyValue(n).trim();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: `${v('--font-ui') || 'Inter Variable, system-ui, sans-serif'}`,
      themeVariables: {
        darkMode: isDark(),
        background: v('--surface'),
        primaryColor: v('--surface-2'),
        primaryTextColor: v('--text'),
        primaryBorderColor: v('--accent'),
        lineColor: v('--muted'),
        secondaryColor: v('--surface'),
        tertiaryColor: v('--surface'),
        textColor: v('--text'),
        mainBkg: v('--surface-2'),
        nodeBorder: v('--accent'),
        clusterBkg: v('--surface'),
        titleColor: v('--heading'),
        edgeLabelBackground: v('--surface'),
        fontSize: '14px',
      },
    });
    mermaidTheme = theme;
  }
  for (const block of blocks) {
    const code = block.querySelector('.mermaid-src').textContent;
    const out = block.querySelector('.mermaid-out');
    const key = `${theme}::${code}`;
    if (state.mermaidCache.has(key)) { out.innerHTML = state.mermaidCache.get(key); fitMermaid(out); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, code);
      state.mermaidCache.set(key, svg);
      out.innerHTML = svg;
      fitMermaid(out);
    } catch (err) {
      out.innerHTML = `<div class="mermaid-error">Diagram error: ${escapeHtml(String(err.message || err).split('\n')[0])}</div>`;
    }
  }
}
// Wide diagrams get shrunk to fit, which makes labels unreadable. Never go below 80% of natural size: scroll instead.
function fitMermaid(out) {
  const svg = out.querySelector('svg');
  const vb = svg?.viewBox?.baseVal;
  if (!vb || !vb.width) return;
  const cw = out.clientWidth || 600;
  const min = vb.width * 0.8;
  if (min > cw) { svg.style.setProperty('max-width', 'none', 'important'); svg.style.width = `${Math.round(min)}px`; svg.style.flex = 'none'; out.classList.add('wide'); }
}
function rerenderMermaid() {
  const t = cur();
  if (t && t.render && t.render.hasMermaid && t.mode !== 'source') renderMermaid($('#tome'));
}

/* ---- HTML documents ---- */
/* HTML pages load from their own sandboxed origin (tlpage://), so they behave like a real browser tab. */
async function loadFrame(t) {
  const frame = $('#frame');
  frame.removeAttribute('srcdoc');
  frame.src = await api.pageUrl(t.file);
}
let srcdocTimer = null;
function loadFrameSrcdoc(t, now = false) {
  clearTimeout(srcdocTimer);
  const go = async () => {
    // Live preview of unsaved edits, served from the file's own folder so relative links, CSS and data still work.
    const url = await api.pagePreview(t.file, t.content);
    if (t === cur()) $('#frame').src = url;
  };
  if (now) go(); else srcdocTimer = setTimeout(go, 350);
}
function renderReader(t) {
  const clean = DOMPurify.sanitize(t.content, {
    FORBID_TAGS: ['style', 'script', 'link', 'meta', 'iframe', 'form', 'input', 'button', 'select', 'textarea', 'nav', 'svg', 'canvas', 'noscript', 'object', 'embed'],
    FORBID_ATTR: ['style', 'class', 'width', 'height', 'align', 'bgcolor', 'color'],
  });
  const tome = $('#tome');
  tome.innerHTML = clean;
  $$('div, span, section', tome).forEach((el) => { if (!el.textContent.trim() && !el.querySelector('img, table, pre')) el.remove(); });
  $$('h1, h2, h3, h4', tome).forEach((h, i) => { if (!h.id) h.id = `${slugify(h.textContent) || 'section'}-${i}`; });
  $$('pre', tome).forEach((pre) => {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    wrap.innerHTML = '<div class="code-head"><button class="code-copy" type="button">Copy</button></div>';
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
  });
  $$('table', tome).forEach((tb) => {
    const w = document.createElement('div');
    w.className = 'table-wrap';
    tb.replaceWith(w); w.appendChild(tb);
  });
  decorate(tome, t);
  const headings = $$('h1, h2, h3, h4', tome).map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.trim(), id: h.id }));
  const words = (tome.textContent.match(/[\p{L}\p{N}’']+/gu) || []).length;
  t.render = { headings, words, tasks: { total: 0, done: 0 }, sealed: false };
  requestAnimationFrame(renderNotes);
}

/* ------------------------------------------------------------------ */
/* Chrome: crumbs, progress, seal, status                              */
/* ------------------------------------------------------------------ */
function shortPath(p) {
  const m = /^\/Users\/[^/]+/.exec(p) || /^\/home\/[^/]+/.exec(p);
  return m ? `~${p.slice(m[0].length)}` : p;
}
function renderCrumbs() {
  const c = $('#crumbs');
  const t = cur();
  if (!t) {
    c.innerHTML = state.folder
      ? `<span class="crumb-folder" data-tip="${escapeHtml(shortPath(state.folder))}">${icon('folder')}${escapeHtml(baseName(state.folder))}</span>`
      : '<span class="crumb-app">Tomelight</span>';
    return;
  }
  let rel = t.doc.dir;
  if (state.folder && t.file.startsWith(`${state.folder}/`)) rel = [baseName(state.folder), ...t.file.slice(state.folder.length + 1).split('/').slice(0, -1)].join(' / ');
  else rel = baseName(t.doc.dir);
  const typeIcon = t.kind === 'html' ? 'globe' : 'file';
  c.innerHTML = `<span class="crumb-folder" data-tip="Reveal in Finder">${icon('folder')}${escapeHtml(rel)}</span><span class="crumb-sep">/</span><span class="crumb-file">${icon(typeIcon)}<span class="crumb-name">${escapeHtml(t.doc.name)}</span><span class="dirty-dot" ${t.dirty ? '' : 'hidden'}></span></span>`;
  c.querySelector('.crumb-folder').onclick = () => api.reveal(t.file);
}

function updateChrome() {
  const t = cur();
  if (!t) return;
  const r = t.render;
  const isMd = t.kind !== 'html';
  const pill = $('#progress');
  const tasks = isMd && r ? r.tasks : { total: 0, done: 0 };
  pill.hidden = !tasks.total;
  if (tasks.total) {
    const pct = tasks.done / tasks.total;
    const C = 2 * Math.PI * 15;
    const fg = pill.querySelector('.ring-fg');
    fg.style.strokeDasharray = `${C}`;
    fg.style.strokeDashoffset = `${C * (1 - pct)}`;
    $('#progress-text').textContent = `${tasks.done}/${tasks.total}`;
    pill.classList.toggle('complete', pct === 1);
    pill.dataset.tip = pct === 1 ? 'Every task complete' : 'Jump to next open task';
  }
  $('#btn-copy').hidden = false;
  const seal = $('#btn-seal');
  seal.hidden = !isMd;
  const sealed = !!(r && r.sealed);
  seal.classList.toggle('sealed', sealed);
  seal.querySelector('span').textContent = sealed ? 'Done' : 'Mark Done';
  seal.dataset.tip = sealed ? `Remove the done seal  ${MOD}D` : `Mark as done  ${MOD}D`;
  $('#sb-type').textContent = { md: 'Markdown', html: 'HTML', txt: 'Text' }[t.kind];
  if (r && r.words != null && !(t.kind === 'html' && t.mode !== 'reader')) {
    const mins = Math.max(1, Math.round(r.words / 230));
    $('#sb-words').textContent = `${r.words.toLocaleString()} words · ${mins} min read`;
  } else $('#sb-words').textContent = shortPath(t.doc.dir);
  $('#sb-tasks').textContent = tasks.total ? `${tasks.done} of ${tasks.total} tasks done` : '';
  updateSaveStatus();
  if (state.settings.sidebarPanel === 'outline') renderOutline();
}

function updateSaveStatus() {
  const el = $('#sb-save');
  const t = cur();
  if (!el || !t) return;
  let txt; let cls = '';
  if (t.dirty) { txt = state.settings.autosave ? 'Saving…' : 'Unsaved changes'; cls = 'dirty'; }
  else if (t.savedAt) txt = `Saved ${timeAgo(t.savedAt)}`;
  else txt = state.settings.autosave ? 'Autosave on' : 'Autosave off';
  el.textContent = txt;
  el.className = `sb-save ${cls}`;
  const dot = $('.dirty-dot');
  if (dot) dot.hidden = !t.dirty;
}
function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
setInterval(updateSaveStatus, 15000);

/* ------------------------------------------------------------------ */
/* Editing & saving                                                     */
/* ------------------------------------------------------------------ */
let renderTimer = null;
function onEditorChange(value) {
  const t = cur();
  if (!t) return;
  t.content = value;
  markDirty(t);
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if (t !== cur()) return;
    if (t.kind === 'html') { if (t.mode === 'split') loadFrameSrcdoc(t); }
    else if (t.mode === 'split') renderPreview();
    else { t.render = renderMarkdown(t.content, { plain: t.kind === 'txt' }); updateChrome(); refreshTabChip(t); }
  }, 110);
  if (state.settings.autosave) {
    clearTimeout(t.saveTimer);
    t.saveTimer = setTimeout(() => save(t), 700);
  }
}
function markDirty(t) {
  const was = t.dirty;
  t.dirty = t.content !== t.lastSaved;
  if (was !== t.dirty) {
    if (t === cur()) renderCrumbs();
    refreshTabChip(t);
    updateWindowTitle();
  }
  if (t === cur()) updateSaveStatus();
}

async function save(t, manual = false) {
  if (!t) return;
  clearTimeout(t.saveTimer);
  if (t.content === t.lastSaved) {
    if (manual) toast('Already saved', 'quiet');
    return;
  }
  const content = t.content;
  try {
    await api.writeFile(t.file, content);
    t.lastSaved = content;
    t.savedAt = Date.now();
    markDirty(t);
    if (manual) toast('Saved', 'ok');
  } catch (err) {
    toast(`Save failed: ${err.message || err}`, 'error');
  }
}
async function saveAll() { for (const t of state.tabs) if (t.dirty) await save(t); toast('All files saved', 'ok'); }
async function flushAll() {
  for (const t of state.tabs) {
    if (!t.dirty) continue;
    if (state.settings.autosave) await save(t);
    else if (window.confirm(`Save changes to ${t.doc.name}?`)) await save(t);
  }
}

/** Apply a programmatic change (checkbox, seal) to the active tab and persist it immediately. */
async function applyChange(next, { animateSeal = false } = {}) {
  const t = cur();
  if (!t || next == null || next === t.content) return;
  t.undo.push(t.content);
  if (t.undo.length > 100) t.undo.shift();
  t.redo = [];
  t.content = next;
  if (t.edState) { if (t.mode === 'split' || t.mode === 'source') state.editor.setValue(next); else t.edState = null; }
  if (t.mode === 'write') { reloadWriter(t); t.render = renderMarkdown(next, { plain: t.kind === 'txt' }); updateChrome(); refreshTabChip(t); }
  else if (t.mode !== 'source') renderPreview({ animateSeal });
  else { t.render = renderMarkdown(next, { plain: t.kind === 'txt' }); updateChrome(); refreshTabChip(t); }
  markDirty(t);
  await save(t);
}

function undoAction(redo = false) {
  const t = cur();
  if (!t) return;
  if (t.mode === 'write' && state.writer && state.writer.hasFocus()) { if (redo) state.writer.redo(); else state.writer.undo(); return; }
  const inEditor = (t.mode === 'split' || t.mode === 'source') && state.editor.view.hasFocus;
  if (inEditor) { if (redo) state.editor.redo(); else state.editor.undo(); return; }
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    document.execCommand(redo ? 'redo' : 'undo');
    return;
  }
  const from = redo ? t.redo : t.undo;
  const to = redo ? t.undo : t.redo;
  if (!from.length) { toast(redo ? 'Nothing to redo' : 'Nothing to undo', 'quiet'); return; }
  to.push(t.content);
  t.content = from.pop();
  if (t.edState) { if (t.mode === 'split' || t.mode === 'source') state.editor.setValue(t.content); else t.edState = null; }
  if (t.mode === 'write') { reloadWriter(t); t.render = renderMarkdown(t.content, { plain: t.kind === 'txt' }); updateChrome(); refreshTabChip(t); }
  else if (t.mode !== 'source') renderPreview();
  markDirty(t);
  save(t);
  toast(redo ? 'Redone' : 'Undone', 'quiet');
}

function afterCheck(before, checked) {
  const t = cur();
  const after = t && t.render && t.render.tasks;
  if (checked && after && after.total && after.done === after.total && before && before.done < before.total) {
    celebrate($('#progress'));
    if (!t.render.sealed) toast('Every task complete. Mark it done?', 'ok', { action: 'Mark Done', run: () => toggleSeal() });
  }
}
function toggleTask(box) {
  const t = cur();
  if (!t) return;
  const line = Number(box.dataset.line);
  const res = box.dataset.cell != null ? toggleCellAt(t.content, line, Number(box.dataset.cell)) : toggleTaskAt(t.content, line);
  if (!res) { toast('Could not find that checkbox in the source', 'error'); return; }
  const before = t.render ? { ...t.render.tasks } : null;
  applyChange(res.src).then(() => afterCheck(before, res.checked));
}
function addCheck(line) {
  const t = cur();
  const before = t.render ? { ...t.render.tasks } : null;
  applyChange(addCheckAt(t.content, line, true)).then(() => afterCheck(before, true));
}
function toggleSeal() {
  const t = cur();
  if (!t || t.kind === 'html') return;
  const res = toggleDoneSeal(t.content);
  applyChange(res.src, { animateSeal: res.sealed }).then(() => {
    if (res.sealed) { celebrate($('#btn-seal')); $('#preview-pane').scrollTo({ top: 0, behavior: 'smooth' }); }
  });
}
function completeAll() {
  const t = cur();
  if (!t || t.kind === 'html') return;
  const res = setAllTasks(t.content, true);
  if (!res.changed) { toast('No open tasks here', 'quiet'); return; }
  applyChange(res.src).then(() => { celebrate($('#progress')); toast(`Checked off ${res.changed} task${res.changed > 1 ? 's' : ''}`, 'ok'); });
}
function jumpToNextTask() {
  const t = cur();
  if (t && t.mode === 'source') setMode('read');
  const open = $('#tome .task-box:not(.checked)');
  if (!open) return;
  const pane = $('#preview-pane');
  const row = open.closest('li, tr');
  pane.scrollTo({ top: row.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - pane.clientHeight / 3, behavior: 'smooth' });
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
}

/* ---- disk changes ---- */
async function onDiskChange({ file }) {
  const t = state.tabs.find((x) => x.file === file);
  if (!t) return;
  let fresh;
  try { fresh = await api.readFile(file); } catch {
    if (t === cur()) showBanner('This file was moved or deleted on disk.', [{ label: 'Close tab', run: () => { hideBanner(); closeTab(t.id, { skipConfirm: true }); } }]);
    return;
  }
  if (fresh.content === t.lastSaved || fresh.content === t.content) { t.lastSaved = fresh.content; markDirty(t); return; }
  const reload = () => {
    t.lastSaved = fresh.content;
    t.content = fresh.content;
    t.dirty = false;
    if (t === cur()) {
      if (t.edState) { if (t.mode === 'split' || t.mode === 'source') state.editor.setValue(fresh.content); else t.edState = null; }
      if (t.mode === 'write') { reloadWriter(t); t.render = renderMarkdown(t.content, { plain: t.kind === 'txt' }); updateChrome(); }
      else if (t.kind === 'html') { if (t.mode === 'read') loadFrame(t); else if (t.mode === 'reader') { renderReader(t); updateChrome(); } else loadFrameSrcdoc(t); }
      else if (t.mode !== 'source') renderPreview();
      else { t.render = renderMarkdown(t.content); updateChrome(); }
      renderCrumbs();
      document.body.classList.remove('refreshed'); void document.body.offsetWidth; document.body.classList.add('refreshed');
      toast('Updated from disk', 'magic');
    } else {
      t.edState = null;
      if (t.kind !== 'html') t.render = renderMarkdown(t.content, { plain: t.kind === 'txt' });
    }
    refreshTabChip(t);
  };
  if (!t.dirty) reload();
  else if (t === cur()) {
    showBanner('This file changed on disk while you were editing.', [
      { label: 'Load theirs', run: () => { hideBanner(); reload(); } },
      { label: 'Keep mine', primary: true, run: () => { t.lastSaved = fresh.content; markDirty(t); save(t); hideBanner(); } },
    ]);
  }
}
function showBanner(text, actions, kind = '') {
  const b = $('#banner');
  b.dataset.kind = kind;
  b.innerHTML = `<span>${icon('refresh')}${escapeHtml(text)}</span><span class="banner-actions"></span>`;
  actions.forEach((a) => {
    const btn = document.createElement('button');
    btn.className = `btn sm ${a.primary ? 'btn-primary' : 'btn-ghost'}`;
    btn.textContent = a.label; btn.onclick = a.run;
    b.querySelector('.banner-actions').appendChild(btn);
  });
  b.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

/* ------------------------------------------------------------------ */
/* Scroll sync & outline                                                */
/* ------------------------------------------------------------------ */
let syncRaf = 0;
function syncPreviewToLine(line) {
  const t = cur();
  if (!t || t.mode !== 'split' || t.kind === 'html') return;
  cancelAnimationFrame(syncRaf);
  syncRaf = requestAnimationFrame(() => {
    const pane = $('#preview-pane');
    if (line <= 1) { pane.scrollTop = 0; return; }
    let best = null; let bestLine = -1;
    for (const el of $$('[data-line], [data-item-line]', $('#tome'))) {
      if (el.classList.contains('task-box')) continue;
      const l = Number(el.dataset.line ?? el.dataset.itemLine);
      if (l <= line && l >= bestLine) { best = el; bestLine = l; }
    }
    if (best) pane.scrollTop = best.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 24;
  });
}

function spyOutline() {
  const t = cur();
  if (state.settings.sidebarPanel !== 'outline' || !t || !t.render) return;
  const top = $('#preview-pane').getBoundingClientRect().top + 90;
  let active = null;
  for (const h of $$('#tome h1, #tome h2, #tome h3, #tome h4')) {
    if (h.getBoundingClientRect().top <= top) active = h.id; else break;
  }
  if (active === state.outlineActive) return;
  state.outlineActive = active;
  $$('.outline-item').forEach((el) => el.classList.toggle('active', el.dataset.id === active));
  const act = $('.outline-item.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ */
/* Sidebar: folder tree + outline                                        */
/* ------------------------------------------------------------------ */
function renderSidebar() {
  renderTabs();
  $$('#side-switch button').forEach((b) => b.classList.toggle('active', b.dataset.panel === state.settings.sidebarPanel));
  moveSwitchGlider();
  if (state.settings.sidebarPanel === 'outline') renderOutline();
  else renderFolderPanel();
}

function renderOutline() {
  const body = $('#side-body');
  const t = cur();
  if (!t) { body.innerHTML = empty('Open a file to see its outline.'); return; }
  if (t.kind === 'html' && t.mode !== 'reader') { body.innerHTML = empty('Switch this page to Reader view to see its outline.'); return; }
  const hs = (t.render && t.render.headings) || [];
  if (!hs.length) { body.innerHTML = empty('No headings in this file.'); return; }
  const min = Math.min(...hs.map((h) => h.level));
  const notedHeads = new Set((t.notes || []).filter((n) => n.text.trim()).map((n) => n.anchor.heading));
  body.innerHTML = `<nav class="outline">${hs.map((h) => `<a class="outline-item lvl-${Math.min(3, h.level - min)} ${notedHeads.has(normText(h.text)) ? 'has-note' : ''}" data-id="${h.id}">${escapeHtml(h.text || 'Untitled')}</a>`).join('')}</nav>`;
  state.outlineActive = null;
  spyOutline();
}

async function listCached(dir) {
  if (state.treeCache.has(dir)) return state.treeCache.get(dir);
  const res = await api.listDir(dir);
  state.treeCache.set(dir, res.entries);
  return res.entries;
}

let folderRenderSeq = 0;
async function renderFolderPanel() {
  const body = $('#side-body');
  const root = treeRoot();
  const seq = ++folderRenderSeq;
  if (!root) {
    body.innerHTML = `<div class="side-empty">${icon('folder')}<p>Open a folder to browse all its files here, like a project in VS Code.</p><button class="btn sm btn-primary" id="side-open-folder">${icon('folder')}Open Folder</button></div>`;
    $('#side-open-folder').onclick = () => api.openDialog({ folders: true });
    return;
  }
  const isWorkspace = !!state.folder;
  const activeFile = cur()?.file;
  const rows = [];
  const walk = async (dir, depth) => {
    const entries = await listCached(dir);
    for (const e of entries) {
      if (e.dir) {
        const open = state.expanded.has(e.path);
        rows.push(`<div class="tree-row dir ${open ? 'open' : ''}" data-path="${escapeHtml(e.path)}" data-dir="1" style="--depth:${depth}"><span class="chev">${icon('up', 'chev-i')}</span>${icon(open ? 'open' : 'folder')}<span class="tr-name">${escapeHtml(e.name)}</span></div>`);
        if (open) await walk(e.path, depth + 1);
      } else {
        const openTab = state.tabs.some((t) => t.file === e.path);
        rows.push(`<div class="tree-row file ${e.path === activeFile ? 'active' : ''} ${openTab ? 'is-open' : ''}" data-path="${escapeHtml(e.path)}" style="--depth:${depth}" draggable="false"><span class="chev"></span>${icon(/\.html?$/i.test(e.name) ? 'globe' : 'file')}<span class="tr-name">${escapeHtml(e.name)}</span></div>`);
      }
    }
  };
  await walk(root, 0);
  if (seq !== folderRenderSeq) return;
  const scroll = body.scrollTop;
  body.innerHTML = `
    <div class="tree-head">
      <span class="th-name" title="${escapeHtml(shortPath(root))}">${icon(isWorkspace ? 'open' : 'folder')}<b>${escapeHtml(baseName(root) || '/')}</b>${isWorkspace ? '' : '<small>current folder</small>'}</span>
      <span class="th-actions">
        <button class="icon-btn xs" data-act="new" data-tip="New file here">${icon('plus')}</button>
        <button class="icon-btn xs" data-act="collapse" data-tip="Collapse folders">${icon('list')}</button>
        ${isWorkspace
    ? `<button class="icon-btn xs" data-act="close-folder" data-tip="Close folder">${icon('x')}</button>`
    : `<button class="icon-btn xs" data-act="pin" data-tip="Open as workspace">${icon('open')}</button>`}
      </span>
    </div>
    <div class="tree">${rows.join('') || '<div class="tree-empty">No .md or .html files here.</div>'}</div>`;
  body.scrollTop = scroll;
}

async function revealInTree(file) {
  const root = treeRoot();
  if (root && file.startsWith(`${root}/`)) {
    let d = dirName(file);
    while (d.length > root.length) { state.expanded.add(d); d = dirName(d); }
  }
  await renderFolderPanel();
  const row = $(`.tree-row[data-path="${CSS.escape(file)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

const empty = (t) => `<div class="side-empty">${icon('sparkles')}<p>${t}</p></div>`;

function renderWelcome() {
  const el = $('#welcome-recent');
  const folders = (state.settings.recentFolders || []).slice(0, 4);
  const files = (state.settings.recent || []).slice(0, 6);
  const card = (p, isFolder) => {
    const name = baseName(p);
    const html = /\.html?$/i.test(name);
    const ic = isFolder ? 'folder' : html ? 'globe' : 'file';
    return `<div class="recent-card" role="button" tabindex="0" data-path="${escapeHtml(p)}" data-kind="${isFolder ? 'folder' : 'file'}"><span class="rc-icon ${isFolder ? 'folder' : html ? 'html' : ''}">${icon(ic)}</span><span class="rc-text"><b>${escapeHtml(name)}</b><small>${escapeHtml(shortPath(dirName(p)))}</small></span><button class="rc-remove" type="button" data-tip="Remove from recents (the ${isFolder ? 'folder' : 'file'} stays on your Mac)">${icon('x')}</button></div>`;
  };
  let html = '';
  if (state.folder) {
    html += `<div class="welcome-folder">${icon('open')}<span><b>${escapeHtml(baseName(state.folder))}</b> is open. Pick a file from the sidebar, or press <kbd>⌘P</kbd> to find one fast.</span></div>`;
  }
  const head = (label, which) => `<h3><span>${label}</span><button class="rc-clear" type="button" data-clear="${which}">Clear</button></h3>`;
  if (folders.length) html += `${head('Recent folders', 'folders')}<div class="recent-grid">${folders.map((f) => card(f, true)).join('')}</div>`;
  if (files.length) html += `${head('Recent files', 'files')}<div class="recent-grid">${files.map((f) => card(f, false)).join('')}</div>`;
  el.innerHTML = html;
}

/* ------------------------------------------------------------------ */
/* Find (CSS Custom Highlight API for the preview)                     */
/* ------------------------------------------------------------------ */
function openFind() {
  const t = cur();
  if (!t) return;
  if (t.mode === 'source' || (t.mode === 'split' && state.editor.view.hasFocus)) { state.editor.search(); return; }
  $('#findbar').hidden = false;
  const input = $('#find-input');
  input.focus(); input.select();
  if (input.value) runFind(input.value);
}
function closeFind() {
  $('#findbar').hidden = true;
  state.find = { ranges: [], idx: -1, text: '' };
  if (window.CSS && CSS.highlights) { CSS.highlights.delete('find-hit'); CSS.highlights.delete('find-current'); }
  api.stopFind();
  $('#find-count').textContent = '';
}
function runFind(text, { keepIndex = false, step = 0 } = {}) {
  const t = cur();
  if (!t) return;
  if ((t.kind === 'html' && (t.mode === 'read' || t.mode === 'split')) || t.mode === 'write') {
    if (!text) { api.stopFind(); $('#find-count').textContent = ''; return; }
    api.find(text, { forward: step >= 0, findNext: step !== 0 });
    return;
  }
  const f = state.find;
  const changed = f.text !== text;
  f.text = text;
  if (!CSS.highlights) return;
  if (changed || keepIndex || !f.ranges.length) {
    f.ranges = [];
    if (text) {
      const needle = text.toLowerCase();
      const walker = document.createTreeWalker($('#tome'), NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest('.mermaid-src, .code-head, .ghost-check, .sticky') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let n;
      while ((n = walker.nextNode())) {
        const hay = n.data.toLowerCase();
        let i = hay.indexOf(needle);
        while (i !== -1) {
          const r = new Range(); r.setStart(n, i); r.setEnd(n, i + needle.length);
          f.ranges.push(r);
          i = hay.indexOf(needle, i + needle.length);
        }
      }
    }
    if (!keepIndex || f.idx >= f.ranges.length) f.idx = f.ranges.length ? 0 : -1;
  }
  if (step && f.ranges.length) f.idx = (f.idx + step + f.ranges.length) % f.ranges.length;
  CSS.highlights.set('find-hit', new Highlight(...f.ranges));
  if (f.idx >= 0) {
    const r = f.ranges[f.idx];
    CSS.highlights.set('find-current', new Highlight(r));
    if (!keepIndex) {
      const pane = $('#preview-pane');
      const rect = r.getBoundingClientRect();
      const pr = pane.getBoundingClientRect();
      if (rect.top < pr.top + 60 || rect.bottom > pr.bottom - 40) pane.scrollTo({ top: pane.scrollTop + rect.top - pr.top - pane.clientHeight / 3, behavior: 'smooth' });
    }
  } else CSS.highlights.delete('find-current');
  $('#find-count').textContent = text ? (f.ranges.length ? `${f.idx + 1} of ${f.ranges.length}` : 'No matches') : '';
}
api.onFoundInPage((r) => {
  if (!$('#findbar').hidden) $('#find-count').textContent = r.matches ? `${r.activeMatchOrdinal} of ${r.matches}` : 'No matches';
});

/* ------------------------------------------------------------------ */
/* Command palette + quick open                                         */
/* ------------------------------------------------------------------ */
function commands() {
  const t = cur();
  const md = t && t.kind !== 'html';
  const list = [
    { title: 'Open a file…', icon: 'open', keys: `${MOD}O`, run: () => api.openDialog() },
    { title: 'Open folder…', icon: 'folder', keys: `⇧${MOD}O`, run: () => api.openDialog({ folders: true }) },
    { title: 'Quick open…', icon: 'search', keys: `${MOD}P`, run: () => openPalette('files') },
    { title: 'New file…', icon: 'plus', keys: `${MOD}N`, run: () => api.newFile(state.folder || t?.doc.dir) },
    t && { title: 'Save', icon: 'download', keys: `${MOD}S`, run: () => save(t, true) },
    state.tabs.some((x) => x.dirty) && { title: 'Save all', icon: 'download', keys: `⌥${MOD}S`, run: saveAll },
    md && { title: t.render?.sealed ? 'Remove the done seal' : 'Mark as done', icon: 'seal', keys: `${MOD}D`, run: toggleSeal },
    md && { title: 'Complete all tasks', icon: 'checks', keys: `⇧${MOD}D`, run: completeAll },
    md && { title: 'Tidy formatting (fix spacing, line breaks, bullets)', icon: 'sparkles', keys: `⌥${MOD}T`, run: tidyCurrent },
    md && { title: 'Uncheck all tasks', icon: 'refresh', run: () => { const r = setAllTasks(t.content, false); applyChange(r.src); } },
    md && t.render?.tasks.total && { title: 'Jump to next open task', icon: 'target', run: jumpToNextTask },
    ...(t ? modesFor(t).map((m) => ({ title: `View: ${m.label}`, icon: m.icon, keys: m.tip.split('  ')[1], run: () => setMode(m.id) })) : []),
    t && { title: 'Close tab', icon: 'x', keys: `${MOD}W`, run: () => closeTab(t.id) },
    state.tabs.length > 1 && { title: 'Close other tabs', icon: 'x', run: () => closeOthers(t.id) },
    state.closed.length && { title: 'Reopen closed tab', icon: 'refresh', keys: `⇧${MOD}T`, run: reopenClosed },
    state.folder && { title: 'Close folder', icon: 'folder', run: closeFolder },
    { title: 'Toggle sidebar', icon: 'sidebar', keys: `${MOD}\\`, run: toggleSidebar },
    { title: 'Show folder', icon: 'folder', keys: `⇧${MOD}1`, run: () => showPanel('folder') },
    { title: 'Show outline', icon: 'list', keys: `⇧${MOD}2`, run: () => showPanel('outline') },
    { title: 'Image Studio (optimize photos for the web)', icon: 'image', keys: `⇧${MOD}I`, run: openStudio },
    t && { title: 'Add sticky note to this section', icon: 'sticky', keys: `⌥${MOD}N`, run: () => addNote() },
    t && { title: notesOn() ? 'Hide sticky notes' : 'Show sticky notes', icon: 'sticky', keys: `⇧⌥${MOD}N`, run: toggleNotesVisible },
    t && t.notes && t.notes.some((n) => n.text.trim()) && { title: 'Manage notes on this file (view, jump, delete)', icon: 'sticky', run: openNotesManager },
    t && t.notes && t.notes.some((n) => n.text.trim()) && { title: 'Delete all notes on this file', icon: 'x', run: () => { if (window.confirm(`Delete all notes on ${t.doc.name}? The file itself is not changed.`)) removeNotes(t, t.notes.map((n) => n.id)); } },
    t && t.notes && t.notes.some((n) => n.text.trim()) && { title: 'Copy all notes on this file (Markdown)', icon: 'clipboard', run: copyAllNotes },
    t && { title: 'Focus mode', icon: 'focus', keys: `⇧${MOD}F`, run: toggleFocus },
    t && { title: 'Find in file', icon: 'search', keys: `${MOD}F`, run: openFind },
    { title: 'Theme: Auto (follow macOS)', icon: 'palette', run: () => setSetting({ theme: 'auto' }) },
    { title: 'Theme: Arcane (dark gold)', icon: 'palette', run: () => setSetting({ theme: 'arcane' }) },
    { title: 'Theme: Parchment (light)', icon: 'palette', run: () => setSetting({ theme: 'parchment' }) },
    { title: 'Theme: Nebula (midnight)', icon: 'palette', run: () => setSetting({ theme: 'nebula' }) },
    { title: 'Theme: Wire (cyber-noir)', icon: 'palette', run: () => setSetting({ theme: 'wire' }) },
    { title: 'Bigger text', icon: 'zoomIn', keys: `${MOD}+`, run: () => zoom(1) },
    { title: 'Smaller text', icon: 'zoomOut', keys: `${MOD}−`, run: () => zoom(-1) },
    { title: `Reading width: ${state.settings.width === 'wide' ? 'comfortable' : 'wide'}`, icon: 'split', run: () => setSetting({ width: state.settings.width === 'wide' ? 'comfortable' : 'wide' }) },
    { title: `Body font: ${state.settings.bodyFont === 'serif' ? 'sans-serif' : 'serif'}`, icon: 'reader', run: () => setSetting({ bodyFont: state.settings.bodyFont === 'serif' ? 'sans' : 'serif' }) },
    { title: `Autosave: turn ${state.settings.autosave ? 'off' : 'on'}`, icon: 'download', run: () => setSetting({ autosave: !state.settings.autosave }) },
    t && { title: 'Copy for email (rich text)', icon: 'mail', keys: `⇧${MOD}C`, run: () => copyAs('rich') },
    t && { title: 'Copy for web (clean HTML)', icon: 'code2', keys: `⌥${MOD}H`, run: () => copyAs('html') },
    t && { title: 'Copy for social (plain text)', icon: 'share', keys: `⌥${MOD}C`, run: () => copyAs('plain') },
    md && { title: 'Paste as Markdown (clean up web / Docs text)', icon: 'paste', keys: `⇧${MOD}V`, run: pasteAsMarkdown },
    t && { title: 'Reveal in Finder', icon: 'finder', keys: `⇧${MOD}R`, run: () => api.reveal(t.file) },
    t && { title: 'Export as PDF…', icon: 'download', keys: `⇧${MOD}P`, run: exportPdf },
    md && { title: 'Export as HTML…', icon: 'download', keys: `⇧${MOD}E`, run: exportHtml },
    t && { title: 'Copy file path', icon: 'file', run: () => { navigator.clipboard.writeText(t.file); toast('Path copied', 'ok'); } },
    { title: 'Settings…', icon: 'sliders', keys: `${MOD},`, run: openSettings },
    { title: 'Keyboard shortcuts', icon: 'keyboard', keys: `${MOD}/`, run: openShortcuts },
  ];
  return list.filter(Boolean).map((c) => ({ ...c, group: 'Commands' }));
}

let paletteMode = 'all';
let paletteItems = [];
let paletteIdx = 0;
let paletteFiles = [];
async function openPalette(mode = 'all') {
  closeMenus();
  paletteMode = mode;
  $('#scrim').hidden = false;
  $('#palette').hidden = false;
  $('#palette').classList.toggle('files-mode', mode === 'files');
  const input = $('#palette-input');
  input.value = '';
  input.placeholder = mode === 'files' ? 'Find a file by name…' : 'Search commands, tabs, headings, files…';
  input.focus();
  paletteFiles = [];
  updatePalette();
  const root = treeRoot();
  if (root) {
    if (!state.walkCache || state.walkCache.root !== root) state.walkCache = { root, files: await api.walkDir(root) };
    paletteFiles = state.walkCache.files;
    if (!$('#palette').hidden) updatePalette();
  }
}
function closePalette() {
  $('#palette').hidden = true;
  if ($('#modal').hidden) $('#scrim').hidden = true;
}
function fuzzy(q, text) {
  if (!q) return 1;
  q = q.toLowerCase(); const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx - t.length * 0.1;
  let ti = 0; let score = 0; let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const f = t.indexOf(ch, ti);
    if (f === -1) return 0;
    streak = f === ti ? streak + 1 : 0;
    score += 1 + streak * 2;
    ti = f + 1;
  }
  return score;
}
function updatePalette() {
  const q = $('#palette-input').value.trim();
  const t = cur();
  const tabs = state.tabs.filter((x) => x !== t).map((x) => ({
    title: x.doc.name, sub: 'open tab', icon: x.kind === 'html' ? 'globe' : 'file', group: 'Open tabs', run: () => activate(x.id),
  }));
  const openFiles = new Set(state.tabs.map((x) => x.file));
  const files = paletteFiles.filter((f) => !openFiles.has(f.path)).map((f) => ({
    title: f.name, sub: f.rel.includes('/') ? dirName(f.rel) : '', icon: /\.html?$/i.test(f.name) ? 'globe' : 'file', group: state.folder ? baseName(state.folder) : 'This folder',
    run: () => openTab(f.path),
  }));
  let all;
  if (paletteMode === 'files') {
    const openSet = new Set(state.tabs.map((x) => x.file));
    const recent = (state.settings.recent || []).filter((f) => !openSet.has(f) && !paletteFiles.some((p) => p.path === f)).slice(0, 12).map((f) => ({
      title: baseName(f), sub: shortPath(dirName(f)), icon: /\.html?$/i.test(f) ? 'globe' : 'file', group: 'Recent', run: () => api.open(f),
    }));
    all = [...tabs, ...files, ...recent];
    if (q) all = all.map((it) => ({ it, s: fuzzy(q, `${it.title} ${it.sub || ''}`) + (fuzzy(q, it.title) ? 50 : 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it);
  } else {
    const heads = ((t && t.render && t.render.headings) || []).map((h) => ({
      title: h.text, icon: 'list', group: 'In this file', sub: `H${h.level}`, run: () => scrollToHeading(h.id),
    }));
    all = [...commands(), ...tabs, ...heads, ...files];
    if (q) all = all.map((it) => ({ it, s: fuzzy(q, `${it.title} ${it.sub || ''}`) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it);
    else all = [...tabs.slice(0, 6), ...heads.slice(0, 6), ...commands()];
  }
  paletteItems = all.slice(0, 80);
  paletteIdx = 0;
  const list = $('#palette-list');
  if (!paletteItems.length) { list.innerHTML = `<div class="pl-empty">${paletteMode === 'files' && !treeRoot() ? 'Open a folder to search its files.' : 'Nothing matches that search.'}</div>`; return; }
  let lastGroup = null;
  list.innerHTML = paletteItems.map((it, i) => {
    const head = !q && it.group !== lastGroup ? `<div class="pl-group">${escapeHtml(it.group)}</div>` : '';
    lastGroup = it.group;
    return `${head}<div class="pl-item ${i === 0 ? 'active' : ''}" data-i="${i}">${icon(it.icon)}<span class="pl-title">${escapeHtml(it.title)}</span>${it.sub ? `<span class="pl-sub">${escapeHtml(it.sub)}</span>` : ''}${it.keys ? `<kbd>${it.keys}</kbd>` : ''}</div>`;
  }).join('');
}
function movePalette(d) {
  if (!paletteItems.length) return;
  paletteIdx = (paletteIdx + d + paletteItems.length) % paletteItems.length;
  $$('.pl-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === paletteIdx));
  const a = $('.pl-item.active'); if (a) a.scrollIntoView({ block: 'nearest' });
}
function runPalette(i = paletteIdx) {
  const it = paletteItems[i];
  closePalette();
  if (it) setTimeout(() => it.run(), 10);
}

function scrollToHeading(id) {
  const t = cur();
  if (t && t.mode === 'write') {
    const h = t.render && t.render.headings.find((x) => x.id === id);
    const el = h && [...$$('#write-host h1, #write-host h2, #write-host h3, #write-host h4, #write-host h5, #write-host h6')].find((x) => normText(x.textContent) === normText(h.text));
    if (el) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    return;
  }
  if (t && t.mode === 'source') setMode('read');
  const el = document.getElementById(id);
  if (!el) return;
  const pane = $('#preview-pane');
  pane.scrollTo({ top: el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 24, behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

/* ------------------------------------------------------------------ */
/* Copy for email / web / social  +  paste as markdown                   */
/* ------------------------------------------------------------------ */
/* Clipboard via the standard web API (Electron 44 moved its own clipboard to the same model). */
const clip = {
  async write(html, text) {
    if (!html) return navigator.clipboard.writeText(text);
    return navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  },
  async read() {
    let html = ''; let text = '';
    try {
      for (const item of await navigator.clipboard.read()) {
        if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
    } catch { text = await navigator.clipboard.readText().catch(() => ''); }
    return { html, text };
  },
};

const COPY_KINDS = {
  rich: { label: 'Rich text for email', sub: 'Gmail, Outlook, Mailchimp, Google Docs', icon: 'mail', keys: `⇧${MOD}C` },
  html: { label: 'Clean HTML for web', sub: 'WordPress, Shopify, Wix, Beehiiv', icon: 'code2', keys: `⌥${MOD}H` },
  plain: { label: 'Plain text for social', sub: 'LinkedIn, X, Facebook, texts', icon: 'share', keys: `⌥${MOD}C` },
};

/** What to copy: the selection inside the tome, a given section, or the whole file. */
function copySource(section = null) {
  const t = cur();
  if (!t) return null;
  if (section) return { frag: section, scope: 'section' };
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount && $('#tome').contains(sel.anchorNode)) {
    return { frag: selectionFragment(sel.getRangeAt(0)), scope: 'selection' };
  }
  if (t.kind === 'html') {
    const clean = DOMPurify.sanitize(t.content, { FORBID_TAGS: ['style', 'script', 'nav', 'svg', 'form', 'button'], RETURN_DOM_FRAGMENT: true });
    return { frag: clean, scope: 'page' };
  }
  if (t.mode === 'source' || t.mode === 'write') { if (t.mode === 'write') flushWriter(t); renderPreview(); }
  const frag = document.createDocumentFragment();
  [...$('#tome').childNodes].forEach((n) => frag.appendChild(n.cloneNode(true)));
  return { frag, scope: 'tome' };
}
function sectionFragment(h) {
  const level = Number(h.tagName[1]);
  const frag = document.createDocumentFragment();
  frag.appendChild(h.cloneNode(true));
  let n = h.nextElementSibling;
  while (n && !(/^H[1-6]$/.test(n.tagName) && Number(n.tagName[1]) <= level)) { frag.appendChild(n.cloneNode(true)); n = n.nextElementSibling; }
  return frag;
}
function copyAs(kind, section = null) {
  const src = copySource(section);
  if (!src) return;
  const root = cleanFragment(src.frag);
  const what = { selection: 'Selection', section: 'Section', tome: 'File', page: 'Page' }[src.scope];
  if (kind === 'rich') {
    clip.write(`<meta charset="utf-8">${root.innerHTML}`, toPlain(root));
    toast(`${what} copied for email. Paste into Gmail, Mailchimp or Docs.`, 'ok');
  } else if (kind === 'html') {
    clip.write(null, toHtml(root));
    toast(`${what} copied as clean HTML for your website.`, 'ok');
  } else {
    const text = toPlain(root);
    clip.write(null, text);
    const c = socialCounts(text);
    const xs = c.x <= 280 ? `X ${c.x}/280` : `X ${c.x}/280, too long`;
    const li = c.linkedin <= 3000 ? `LinkedIn ${c.linkedin.toLocaleString()}/3,000` : `LinkedIn ${c.linkedin.toLocaleString()}/3,000, too long`;
    toast(`${what} copied as plain text · ${xs} · ${li}`, c.x <= 280 ? 'ok' : 'info');
  }
}
function openCopyMenu(opts, section = null) {
  const sel = window.getSelection();
  const hasSel = !section && sel && !sel.isCollapsed && $('#tome').contains(sel.anchorNode);
  const scope = section ? 'this section' : hasSel ? 'the selection' : 'the whole file';
  const items = Object.entries(COPY_KINDS).map(([k, v]) => ({ label: v.label, sub: v.sub, icon: v.icon, keys: section ? '' : v.keys, run: () => copyAs(k, section) }));
  popMenu(items, { ...opts, head: `Copy ${scope}` });
}

async function pasteAsMarkdown() {
  const t = cur();
  if (!t || t.kind === 'html') { toast('Paste as Markdown works in Markdown files', 'quiet'); return; }
  const { html, text } = await clip.read();
  const md = html && html.trim() ? htmlToMarkdown(html) : (text || '');
  if (!md) { toast('Clipboard is empty', 'quiet'); return; }
  const wasRead = t.mode === 'read';
  if (wasRead) setMode('split');
  requestAnimationFrame(() => {
    const view = state.editor.view;
    if (wasRead) {
      const doc = view.state.doc.toString();
      const end = doc.length;
      const pre = doc.endsWith('\n\n') || !doc ? '' : doc.endsWith('\n') ? '\n' : '\n\n';
      view.dispatch({ changes: { from: end, insert: `${pre}${md}\n` }, selection: { anchor: end + pre.length + md.length }, scrollIntoView: true });
    } else {
      view.dispatch(view.state.replaceSelection(md));
    }
    view.focus();
    toast(html ? 'Pasted as clean Markdown' : 'Pasted', 'ok');
  });
}

/* selection counter (handy for social posts) */
document.addEventListener('selectionchange', () => {
  const el = $('#sb-sel');
  if (!el) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && $('#tome').contains(sel.anchorNode)) {
    const c = socialCounts(sel.toString().trim());
    el.textContent = `${c.chars.toLocaleString()} chars selected · X ${c.x}/280`;
    el.hidden = false;
  } else el.hidden = true;
});

/* ------------------------------------------------------------------ */
/* Blog-ready WebP optimizer                                             */
/* ------------------------------------------------------------------ */
function relPath(fromDir, to) {
  const a = fromDir.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}
/* ------------------------------------------------------------------ */
/* Image Studio: its own full-screen dock for converting photos in bulk  */
/* ------------------------------------------------------------------ */
const IMG_SIZES = [[800, 'Small', 'Thumbnails, product grids, blog cards'], [1200, 'Medium', 'Email newsletters, side images'], [1600, 'Large', 'Images inside a blog post or product page'], [2400, 'XL', 'Full-width banners across the whole screen'], [0, 'Full', 'Keep the original size, just compress and clean']];
const IMG_SHAPES = [['original', 'As is', 'Keep the photo\'s own shape, no cropping', 0], ['1:1', 'Square', '1:1 · Instagram posts, product photos, profile pictures', 1], ['4:5', 'Portrait', '4:5 · Instagram portrait posts, Facebook feed', 4 / 5], ['2:3', 'Pin', '2:3 · Pinterest pins (1000 × 1500)', 2 / 3], ['16:9', 'Wide', '16:9 · YouTube thumbnails, blog headers, presentations', 16 / 9], ['9:16', 'Story', '9:16 · Stories, Reels, TikTok, Shorts', 9 / 16]];
/* One click presets for beginners: pick what you're making, everything else is set for you. */
const IMG_RECIPES = [
  { id: 'blog', label: 'Blog post image', dims: '1600 wide · WebP', set: { imgMaxWidth: 1600, imgShape: 'original', imgQuality: 82, imgFormat: 'webp' } },
  { id: 'pin', label: 'Pinterest pin', dims: '1000 × 1500 · JPEG', set: { imgMaxWidth: 1000, imgShape: '2:3', imgQuality: 82, imgFormat: 'jpeg' } },
  { id: 'insta', label: 'Instagram post', dims: '1080 × 1080 · JPEG', set: { imgMaxWidth: 1080, imgShape: '1:1', imgQuality: 90, imgFormat: 'jpeg' } },
  { id: 'story', label: 'Story / Reel cover', dims: '1080 × 1920 · JPEG', set: { imgMaxWidth: 1080, imgShape: '9:16', imgQuality: 90, imgFormat: 'jpeg' } },
  { id: 'yt', label: 'YouTube thumbnail', dims: '1280 × 720 · JPEG', set: { imgMaxWidth: 1280, imgShape: '16:9', imgQuality: 90, imgFormat: 'jpeg' } },
  { id: 'product', label: 'Shopify product photo', dims: '2048 × 2048 · WebP', set: { imgMaxWidth: 2048, imgShape: '1:1', imgQuality: 90, imgFormat: 'webp' } },
  { id: 'hero', label: 'Website banner', dims: '2400 wide · WebP', set: { imgMaxWidth: 2400, imgShape: 'original', imgQuality: 82, imgFormat: 'webp' } },
  { id: 'email', label: 'Email newsletter', dims: '1200 wide · JPEG', set: { imgMaxWidth: 1200, imgShape: 'original', imgQuality: 82, imgFormat: 'jpeg' } },
  { id: 'clean', label: 'Just clean my photos', dims: 'Same size · remove private data', set: { imgMaxWidth: 0, imgShape: 'original', imgQuality: 90, imgFormat: 'same' } },
];
const IMG_HELP = {
  recipe: '<b>Not sure what to pick?</b> Choose what the photo is for, and Tomelight sets the size, shape, quality and file type for you. You can still tweak anything below afterwards.',
  size: '<b>Size is the width in pixels.</b> Your camera shoots around 4000 pixels wide, but a blog column is only about 800 wide on screen. Sending the giant version makes pages slow.<br><br><b>Rule of thumb:</b> use about 2× the width it will show at, so it stays sharp on Retina screens.<br>• Small 800: thumbnails, product grids<br>• Medium 1200: emails, side images<br>• Large 1600: inside blog posts (the usual pick)<br>• XL 2400: full-screen banners<br>• Full: keep original size<br><br>Photos are never stretched bigger, and the height follows automatically.',
  shape: '<b>Shape crops the photo to fit a platform.</b> It cuts evenly from both sides (center crop), so keep the important part in the middle.<br><br>• As is: no cropping<br>• Square 1:1: Instagram, product photos<br>• Portrait 4:5: Instagram portrait, Facebook<br>• Pin 2:3: Pinterest<br>• Wide 16:9: YouTube thumbnails, headers<br>• Story 9:16: Stories, Reels, TikTok<br><br><b>The numbers are width : height.</b> 16:9 means 16 across for every 9 down.',
  quality: '<b>Quality trades file size for detail.</b><br>• Small: smallest files, fine for thumbnails<br>• Balanced: looks the same to the eye, much lighter (recommended)<br>• High: for photography, product zoom, or text inside images',
  format: '<b>Format is the file type.</b><br>• WebP: made for the web, about a third smaller than JPEG with the same look. WordPress, Shopify, Wix, Squarespace and all modern browsers support it.<br>• JPEG: works absolutely everywhere, including email apps and social uploads.<br>• Original: keeps each photo\'s own type and only cleans and compresses it.',
  save: '<b>Where the new files go.</b> Your originals are never changed or deleted.<br>• Same folder: next to each original<br>• web-ready/: a new folder next to the originals, so all the upload-ready files are in one place',
};
function recipeActive(r) { return Object.entries(r.set).every(([k, v]) => String(state.settings[k] ?? '') === String(v)); }
function showHelp(btn, key) {
  const pop = $('#help-pop');
  if (!pop.hidden && pop.dataset.key === key) { pop.hidden = true; return; }
  pop.innerHTML = IMG_HELP[key];
  pop.dataset.key = key;
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.left - 14))}px`;
  pop.style.top = `${r.bottom + 10}px`;
  pop.style.setProperty('--arrow', `${Math.max(14, r.left - parseFloat(pop.style.left) + 4)}px`);
}

state.studio = { items: [], running: false, seq: 0, open: false };

function imgLink(r, kind) {
  const t = cur();
  const rel = t ? relPath(t.doc.dir, r.out) : baseName(r.out);
  const alt = altFromName(baseName(r.p));
  if (kind === 'html') return `<img src="${rel.replace(/"/g, '&quot;')}" alt="${alt}" width="${r.w}" height="${r.h}" loading="lazy">`;
  return `![${alt}](${/\s/.test(rel) ? `<${rel}>` : rel})`;
}

/** Convert one image with the current settings. */
async function processImage(p) {
  const s = state.settings;
  const maxWidth = s.imgMaxWidth === 0 ? Infinity : (s.imgMaxWidth || 1600);
  // "Original" keeps each photo's own format (HEIC/TIFF become JPEG, the closest web-safe match).
  let fmt = s.imgFormat || 'webp';
  if (fmt === 'same') fmt = /\.png$/i.test(p) ? 'png' : /\.(jpe?g|heic|heif|tiff?)$/i.test(p) ? 'jpeg' : /\.(gif|bmp)$/i.test(p) ? 'png' : 'webp';
  const type = { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' }[fmt];
  const ext = { webp: '.webp', jpeg: '.jpg', png: '.png' }[fmt];
  const src = await api.imgRead(p);
  const shape = IMG_SHAPES.find(([v]) => v === s.imgShape);
  const enc = await optimizeImage(src.bytes, { maxWidth, quality: (s.imgQuality || 82) / 100, type, aspect: shape ? shape[3] : 0 });
  const clean = scrubMetadata(enc.bytes, type); // belt and braces: no EXIF, XMP, IPTC or ICC left in the file
  const out = { ...enc, bytes: clean, size: clean.length };
  const sameType = s.imgFormat !== 'same' && ((fmt === 'jpeg' && /\.jpe?g$/i.test(p)) || (fmt === 'webp' && /\.webp$/i.test(p)));
  if (sameType && out.size >= src.size) throw new Error('already optimized, left as is');
  const saved = await api.imgWrite(p, out.bytes, {
    ext,
    subdir: s.imgOutput === 'folder' ? 'web-ready' : '',
    name: s.imgSeoNames ? seoName(baseName(p)) : '',
  });
  return {
    out: saved.path, before: src.size, after: out.size, w: out.width, h: out.height,
    format: fmt.toUpperCase().replace('JPEG', 'JPEG'), gif: /\.gif$/i.test(p), bytes: out.bytes,
    thumb: URL.createObjectURL(new Blob([out.bytes], { type })),
  };
}

/* ---- queue ---- */
function optimizeFiles(paths) {
  paths = paths.filter((p) => IMG_RE.test(p));
  if (!paths.length) return;
  for (const p of paths) state.studio.items.unshift({ id: ++state.studio.seq, p, status: 'queued' });
  openStudio();
  runQueue();
}
async function runQueue() {
  const st = state.studio;
  if (st.running) return;
  st.running = true;
  let item;
  // Oldest queued first, so a big drop finishes in the order you dropped it.
  while ((item = [...st.items].reverse().find((i) => i.status === 'queued'))) {
    item.status = 'working';
    renderStudio();
    try { Object.assign(item, await processImage(item.p), { status: 'done' }); } // eslint-disable-line no-await-in-loop
    catch (err) { item.status = 'error'; item.error = String(err.message || err); }
    renderStudio();
  }
  st.running = false;
  state.treeCache.clear();
  if (state.settings.sidebarPanel === 'folder') renderFolderPanel();
  if (!st.open) {
    const done = st.items.filter((i) => i.status === 'done');
    if (done.length) toast(`${done.length} image${done.length > 1 ? 's' : ''} ready in Image Studio`, 'ok', { action: 'Open', run: openStudio });
  }
}
async function pickAndOptimize() {
  const files = await api.imgPick();
  if (files.length) optimizeFiles(files);
}
/** Editor toolbar: pick photos, optimize them, and drop the links right where you're typing. */
async function pickAndInsert() {
  const files = (await api.imgPick()).filter((p) => IMG_RE.test(p));
  if (!files.length) return;
  toast(`Optimizing ${files.length} image${files.length > 1 ? 's' : ''}…`, 'magic');
  const done = [];
  for (const p of files) {
    try { done.push({ p, ...(await processImage(p)) }); } catch (err) { toast(`${baseName(p)}: ${err.message || err}`, 'error'); } // eslint-disable-line no-await-in-loop
  }
  if (!done.length) return;
  const t = cur();
  insertIntoCurrent(done.map((r) => imgLink(r, t && t.kind === 'html' ? 'html' : 'md')).join('\n\n'));
  toast(`${done.length} image${done.length > 1 ? 's' : ''} optimized and inserted`, 'ok');
}
function insertIntoCurrent(text) {
  const t = cur();
  if (!t) { clip.write(null, text); toast('No file open, so the links were copied instead', 'quiet'); return false; }
  if (t.kind !== 'html' && t.kind !== 'txt' && (t.mode === 'write' || t.mode === 'read')) {
    const wasRead = t.mode === 'read';
    if (wasRead) setMode('write');
    requestAnimationFrame(() => {
      if (wasRead) state.writer.editor.commands.focus('end');
      state.writer.insertMarkdown(text);
    });
    return true;
  }
  const wasRead = t.mode === 'read' || t.mode === 'reader';
  if (wasRead) setMode('split');
  requestAnimationFrame(() => {
    const view = state.editor.view;
    if (wasRead) {
      const doc = view.state.doc.toString();
      const pre = !doc || doc.endsWith('\n\n') ? '' : doc.endsWith('\n') ? '\n' : '\n\n';
      view.dispatch({ changes: { from: doc.length, insert: `${pre}${text}\n` }, scrollIntoView: true });
    } else view.dispatch(view.state.replaceSelection(text));
    view.focus();
  });
  return true;
}

/* ---- view ---- */
function openStudio() {
  state.studio.open = true;
  document.body.classList.add('studio-open');
  $('#studio').hidden = false;
  $('#btn-studio').classList.add('active');
  renderStudio();
}
function closeStudio() {
  state.studio.open = false;
  $('#help-pop').hidden = true;
  document.body.classList.remove('studio-open');
  $('#studio').hidden = true;
  $('#btn-studio').classList.remove('active');
}
function toggleStudio() { if (state.studio.open) closeStudio(); else openStudio(); }

function renderStudio() {
  if (!state.studio.open) return;
  const s = state.settings;
  const items = state.studio.items;
  const done = items.filter((i) => i.status === 'done');
  const pending = items.filter((i) => i.status === 'queued' || i.status === 'working').length;
  const before = done.reduce((n, r) => n + r.before, 0);
  const after = done.reduce((n, r) => n + r.after, 0);
  const pct = before ? Math.min(99, Math.max(0, Math.round((1 - after / before) * 100))) : 0;
  const t = cur();
  const seg = (key, opts) => `<div class="mini-seg" data-imgkey="${key}">${opts.map(([v, l, tip]) => `<button data-v="${v}" class="${String(s[key]) === String(v) ? 'active' : ''}" ${tip ? `data-tip="${tip}"` : ''}>${l}</button>`).join('')}</div>`;
  const card = (i) => {
    if (i.status === 'done') {
      const saved = Math.min(99, Math.max(0, Math.round((1 - i.after / i.before) * 100)));
      return `<div class="st-card done" data-id="${i.id}">
        <div class="st-thumb"><img src="${i.thumb}" alt="" /><span class="st-badge">−${saved}%</span></div>
        <div class="st-body"><b title="${escapeHtml(i.out)}">${escapeHtml(baseName(i.out))}</b>
          <small>${i.w}×${i.h} · ${i.format}${i.gif ? ' · first frame' : ''}</small>
          <small class="st-size">${prettyBytes(i.before)} <span>→</span> <em>${prettyBytes(i.after)}</em></small></div>
        <div class="st-actions">
          <button data-act="md" data-tip="Copy Markdown link">${icon('clipboard')}</button>
          <button data-act="html" data-tip="Copy HTML tag">${icon('code2')}</button>
          ${t ? `<button data-act="insert" data-tip="Insert into ${escapeHtml(t.doc.name)}">${icon('plus')}</button>` : ''}
          <button data-act="reveal" data-tip="Show in Finder">${icon('finder')}</button>
        </div></div>`;
    }
    if (i.status === 'error') {
      return `<div class="st-card err" data-id="${i.id}"><div class="st-thumb"><span class="st-icon">${icon('x')}</span></div>
        <div class="st-body"><b>${escapeHtml(baseName(i.p))}</b><small>${escapeHtml(i.error)}</small></div></div>`;
    }
    return `<div class="st-card ${i.status}" data-id="${i.id}"><div class="st-thumb">${i.status === 'working' ? '<span class="spinner"></span>' : `<span class="st-icon">${icon('image')}</span>`}</div>
      <div class="st-body"><b>${escapeHtml(baseName(i.p))}</b><small>${i.status === 'working' ? 'Optimizing…' : 'Waiting'}</small></div></div>`;
  };
  $('#studio').innerHTML = `
    <div class="st-wrap">
      <header class="st-head">
        <div class="st-title"><span class="st-logo">${icon('image')}</span><div><h2>Image Studio</h2><p>Make photos small, fast and clean for your website or socials. Nothing leaves your Mac.</p></div></div>
        <span class="st-head-actions">
          <button class="btn sm btn-ghost" id="st-guide-btn">${icon('question')}${s.studioGuide !== false ? 'Hide guide' : 'How it works'}</button>
          <button class="icon-btn" id="st-close" data-tip="Close  esc">${icon('x')}</button>
        </span>
      </header>
      ${s.studioGuide !== false ? `
      <div class="st-guide">
        <div class="stg-step"><span>1</span><div><b>Pick what you're making</b><small>A blog image, a Pinterest pin, a product photo… Tomelight picks the right size and shape.</small></div></div>
        <div class="stg-step"><span>2</span><div><b>Drop your photos</b><small>One or a hundred, straight from Finder or your iPhone. Originals are never touched.</small></div></div>
        <div class="stg-step"><span>3</span><div><b>Upload the new files</b><small>They're smaller, sharp, and scrubbed of private data like your GPS location. Download them as a zip or copy the links.</small></div></div>
      </div>` : ''}
      <div class="st-recipes">
        <div class="st-label">What are you making? <button class="help-i" data-help="recipe" aria-label="Help">${icon('info')}</button></div>
        <div class="st-recipe-row">${IMG_RECIPES.map((r) => `<button class="st-recipe ${recipeActive(r) ? 'active' : ''}" data-recipe="${r.id}"><b>${r.label}</b><small>${r.dims}</small></button>`).join('')}</div>
      </div>
      <div class="st-controls">
        <div class="st-ctl"><label>Size <button class="help-i" data-help="size" aria-label="What is size?">${icon('info')}</button></label>${seg('imgMaxWidth', [...IMG_SIZES.map(([v, l, tip]) => [v, `${l}${v ? ` <i>${v}</i>` : ''}`, tip]), ...(IMG_SIZES.some(([v]) => v === s.imgMaxWidth) ? [] : [[s.imgMaxWidth, `Custom <i>${s.imgMaxWidth}</i>`, 'Set by the recipe you picked']])])}</div>
        <div class="st-ctl"><label>Shape <button class="help-i" data-help="shape" aria-label="What is shape?">${icon('info')}</button></label>${seg('imgShape', IMG_SHAPES.map(([v, l, tip]) => [v, `${l}${v !== 'original' ? ` <i>${v}</i>` : ''}`, tip]))}</div>
        <div class="st-ctl"><label>Quality <button class="help-i" data-help="quality" aria-label="What is quality?">${icon('info')}</button></label>${seg('imgQuality', [[70, 'Small'], [82, 'Balanced'], [90, 'High']])}</div>
        <div class="st-ctl"><label>Format <button class="help-i" data-help="format" aria-label="What is format?">${icon('info')}</button></label>${seg('imgFormat', [['webp', 'WebP', 'Best for websites and blogs'], ['jpeg', 'JPEG', 'Works everywhere, including email'], ['same', 'Original', 'Keep each photo\'s own type']])}</div>
        <div class="st-ctl"><label>Save to <button class="help-i" data-help="save" aria-label="Where do files go?">${icon('info')}</button></label>${seg('imgOutput', [['beside', 'Same folder'], ['folder', 'web-ready/', 'A web-ready folder next to the originals']])}</div>
        <label class="st-ctl st-seo"><input type="checkbox" class="switch" data-imgbool="imgSeoNames" ${s.imgSeoNames ? 'checked' : ''}/><span><b>SEO names</b><small>IMG_2041 Dog.png → img-2041-dog.webp</small></span></label>
      </div>
      <button class="st-drop ${items.length ? 'compact' : ''}" id="st-drop" type="button">
        ${icon('image')}<span><b>${items.length ? 'Drop more photos, or click to add' : 'Drop photos here'}</b>
        <small>PNG · JPG · HEIC (iPhone) · WebP · GIF · AVIF · TIFF · as many as you like</small></span>
      </button>
      ${items.length ? `
      <div class="st-summary">
        <div class="st-stats">
          ${done.length ? `<span class="st-big">−${pct}%</span><span><b>${done.length} image${done.length > 1 ? 's' : ''} ready</b><small>${prettyBytes(before)} → ${prettyBytes(after)}${pending ? ` · ${pending} to go` : ''}</small><small class="st-clean">${icon('check')}Metadata removed: location, camera, EXIF, XMP, IPTC</small></span>`
    : `<span class="spinner"></span><span><b>Optimizing…</b><small>${pending} in the queue</small></span>`}
        </div>
        <div class="st-bulk">
          ${done.length ? `<button class="btn sm btn-ghost" data-bulk="md">${icon('clipboard')}Copy all links</button>
          <button class="btn sm btn-ghost" data-bulk="html">${icon('code2')}Copy all HTML</button>
          ${t ? `<button class="btn sm btn-ghost" data-bulk="insert">${icon('plus')}Insert all into file</button>` : ''}
          <button class="btn sm btn-ghost" data-bulk="reveal">${icon('finder')}Show in Finder</button>
          <button class="btn sm btn-primary" data-bulk="zip">${icon('download')}Download all (.zip)</button>` : ''}
          <button class="btn sm btn-ghost" data-bulk="clear" ${pending ? 'disabled' : ''}>${icon('x')}Clear</button>
        </div>
      </div>
      <div class="st-grid">${items.map(card).join('')}</div>` : `
      <div class="st-empty"><p>Tip: you can drop photos anywhere in Tomelight and they land here. Settings apply to the photos you add next.</p></div>`}
    </div>`;
}

function bindStudio() {
  const el = $('#studio');
  el.addEventListener('click', async (e) => {
    if (e.target.closest('#st-close')) { closeStudio(); return; }
    if (e.target.closest('#st-drop')) { pickAndOptimize(); return; }
    const help = e.target.closest('[data-help]');
    if (help) { e.stopPropagation(); showHelp(help, help.dataset.help); return; }
    if (e.target.closest('#st-guide-btn')) { await setSetting({ studioGuide: state.settings.studioGuide === false }); return; }
    const recipe = e.target.closest('[data-recipe]');
    if (recipe) {
      const r = IMG_RECIPES.find((x) => x.id === recipe.dataset.recipe);
      await setSetting(r.set);
      toast(`${r.label}: ${r.dims}. Now drop your photos.`, 'ok');
      return;
    }
    const segBtn = e.target.closest('[data-imgkey] button');
    if (segBtn) {
      const key = segBtn.parentElement.dataset.imgkey;
      await setSetting({ [key]: ['imgMaxWidth', 'imgQuality'].includes(key) ? Number(segBtn.dataset.v) : segBtn.dataset.v });
      $('#help-pop').hidden = true;
      return;
    }
    const done = state.studio.items.filter((i) => i.status === 'done');
    const t = cur();
    const kind = t && t.kind === 'html' ? 'html' : 'md';
    const bulk = e.target.closest('[data-bulk]');
    if (bulk) {
      const b = bulk.dataset.bulk;
      if (b === 'md' || b === 'html') { await clip.write(null, done.map((r) => imgLink(r, b)).join('\n\n')); toast(`${done.length} ${b === 'html' ? 'HTML tags' : 'Markdown links'} copied`, 'ok'); }
      if (b === 'insert') { closeStudio(); insertIntoCurrent(done.map((r) => imgLink(r, kind)).join('\n\n')); toast(`${done.length} image${done.length > 1 ? 's' : ''} inserted into ${t.doc.name}`, 'ok'); }
      if (b === 'reveal' && done[0]) api.reveal(done[0].out);
      if (b === 'zip') {
        const files = {};
        for (const r of done) {
          let n = baseName(r.out); let k = 2;
          while (files[n]) { n = baseName(r.out).replace(/(\.[^.]+)$/, `-${k++}$1`); }
          files[n] = [r.bytes, { level: 0 }]; // already compressed images: store, don't re-zip
        }
        const res = await api.saveZip(zipSync(files));
        if (res && res.path) toast(`Saved ${done.length} image${done.length > 1 ? 's' : ''} to ${baseName(res.path)}`, 'ok', { action: 'Reveal', run: () => api.reveal(res.path) });
      }
      if (b === 'clear') {
        state.studio.items.forEach((i) => i.thumb && URL.revokeObjectURL(i.thumb));
        state.studio.items = state.studio.items.filter((i) => i.status === 'queued' || i.status === 'working');
        renderStudio();
      }
      return;
    }
    const act = e.target.closest('[data-act]');
    const cardEl = act && act.closest('.st-card');
    const r = cardEl && state.studio.items.find((i) => i.id === Number(cardEl.dataset.id));
    if (!r) return;
    if (act.dataset.act === 'reveal') api.reveal(r.out);
    else if (act.dataset.act === 'insert') { closeStudio(); insertIntoCurrent(imgLink(r, kind)); toast(`Inserted into ${t.doc.name}`, 'ok'); }
    else { await clip.write(null, imgLink(r, act.dataset.act)); toast(act.dataset.act === 'html' ? 'HTML img tag copied' : 'Markdown image link copied', 'ok'); }
  });
  el.addEventListener('change', (e) => {
    const c = e.target.closest('[data-imgbool]');
    if (c) setSetting({ [c.dataset.imgbool]: c.checked });
  });
  $('#btn-studio').onclick = toggleStudio;
}

/* ------------------------------------------------------------------ */
/* Selection: clean ⌘C, select-all inside the page, floating copy bar     */
/* ------------------------------------------------------------------ */
function tomeSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const tome = $('#tome');
  const r = sel.getRangeAt(0);
  if (!tome.contains(r.commonAncestorContainer) && r.commonAncestorContainer !== tome) return null;
  if (!sel.toString().trim()) return null;
  return r;
}
/** Clone the selected range, re-wrapping partial lists/tables so formatting survives. */
function selectionFragment(range) {
  const frag = range.cloneContents();
  const anc = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const first = frag.firstElementChild;
  const wrapWith = (tag) => { const w = document.createElement(tag); w.appendChild(frag); const f = document.createDocumentFragment(); f.appendChild(w); return f; };
  if (first && first.tagName === 'LI' && /^(UL|OL)$/.test(anc.tagName)) return wrapWith(anc.tagName);
  if (first && first.tagName === 'TR') { const t = document.createElement('table'); const b = document.createElement('tbody'); b.appendChild(frag); t.appendChild(b); const f = document.createDocumentFragment(); f.appendChild(t); return f; }
  return frag;
}
function copySelectionClean() {
  const r = tomeSelection();
  if (!r) return false;
  const root = cleanFragment(selectionFragment(r));
  const text = toPlain(root);
  clip.write(`<meta charset="utf-8">${root.innerHTML}`, text);
  toast(`Copied · ${[...text].length.toLocaleString()} characters`, 'ok');
  return true;
}
function selectAllInPage() {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { ae.select(); return; }
  const t = cur();
  if (t && t.mode === 'write' && state.writer) { state.writer.selectAll(); return; }
  if (t && t.mode !== 'read' && t.mode !== 'reader' && state.editor.view.hasFocus) { state.editor.selectAll(); return; }
  if (!t || (t.kind === 'html' && t.mode === 'read')) { document.execCommand('selectAll'); return; }
  const range = document.createRange();
  range.selectNodeContents($('#tome'));
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  showSelBubble();
}

const bubble = () => $('#sel-bubble');
function showSelBubble() {
  const r = tomeSelection();
  const b = bubble();
  if (!r) { b.hidden = true; return; }
  const text = window.getSelection().toString().trim();
  const c = socialCounts(text);
  b.innerHTML = `
    <button type="button" data-sel="copy" class="sb-main">${icon('clipboard')}<span>Copy</span></button>
    <span class="sb-div"></span>
    <button type="button" data-sel="rich" data-tip="Copy for email">${icon('mail')}</button>
    <button type="button" data-sel="html" data-tip="Copy as clean HTML for web">${icon('code2')}</button>
    <button type="button" data-sel="plain" data-tip="Copy as plain text for social">${icon('share')}</button>
    <span class="sb-div"></span>
    <button type="button" data-sel="note" data-tip="Stick a note on this">${icon('sticky')}</button>
    <span class="sb-count">${c.chars.toLocaleString()} chars</span>`;
  b.hidden = false;
  const rects = [...r.getClientRects()].filter((x) => x.width > 1);
  const box = r.getBoundingClientRect();
  const firstR = rects[0] || box;
  const stage = $('#stage').getBoundingClientRect();
  const bw = b.offsetWidth; const bh = b.offsetHeight;
  let top = firstR.top - bh - 10;
  if (top < stage.top + 6) top = Math.min((rects[rects.length - 1] || box).bottom + 10, stage.bottom - bh - 8);
  let left = (firstR.left + firstR.right) / 2 - bw / 2;
  if (box.height > 120) left = box.left + box.width / 2 - bw / 2;
  left = Math.max(stage.left + 8, Math.min(left, stage.right - bw - 8));
  b.style.top = `${Math.max(stage.top + 6, top)}px`;
  b.style.left = `${left}px`;
}
function hideSelBubble() { const b = bubble(); if (b) b.hidden = true; }

function bindSelection() {
  const tome = $('#tome');
  tome.addEventListener('mouseup', () => setTimeout(showSelBubble, 0));
  tome.addEventListener('mousedown', (e) => { if (!e.target.closest('#sel-bubble')) hideSelBubble(); });
  document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'a') setTimeout(showSelBubble, 0); });
  document.addEventListener('selectionchange', () => { if (!tomeSelection()) hideSelBubble(); });
  $('#preview-pane').addEventListener('scroll', () => { if (!bubble().hidden) showSelBubble(); }, { passive: true });
  const b = bubble();
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection alive
  b.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sel]');
    if (!btn) return;
    if (btn.dataset.sel === 'note') {
      const r = tomeSelection();
      if (!r) return;
      const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      const block = node.closest('p, li, td, th, blockquote, pre, h1, h2, h3, h4, h5, h6') || node;
      const quote = window.getSelection().toString();
      window.getSelection().removeAllRanges();
      hideSelBubble();
      addNote(block, quote);
      return;
    }
    if (btn.dataset.sel === 'copy') copySelectionClean(); else copyAs(btn.dataset.sel);
  });
  // ⌘C inside the page: copy only the selection, without app styling.
  document.addEventListener('copy', (e) => {
    const r = tomeSelection();
    if (!r) return;
    const root = cleanFragment(selectionFragment(r));
    e.clipboardData.setData('text/html', `<meta charset="utf-8">${root.innerHTML}`);
    e.clipboardData.setData('text/plain', toPlain(root));
    e.preventDefault();
  });
  // Clicking "Copy for…" must not wipe out what you highlighted.
  $('#btn-copy').addEventListener('mousedown', (e) => e.preventDefault());
  $('#menu-pop').addEventListener('mousedown', (e) => e.preventDefault());
}

/* ------------------------------------------------------------------ */
/* Sticky notes: live only in the app, never written into the file      */
/* ------------------------------------------------------------------ */
const NOTE_COLORS = ['amber', 'rose', 'sky', 'mint', 'lilac'];
const NOTE_W = 264;
const NOTE_GAP = 28;
state.noteEls = new Map();

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const notesOn = () => state.settings.notesVisible !== false;
const noteDate = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function ensureNotes(t) {
  if (!t.notes) t.notes = (await api.notesGet(t.file)) || [];
  return t.notes;
}
function saveNotes(t) {
  clearTimeout(t.notesTimer);
  t.notesTimer = setTimeout(() => api.notesSet(t.file, t.notes.filter((n) => n.text.trim())), 300);
  updateNoteCount();
}
function updateNoteCount() {
  const t = cur();
  const el = $('#sb-notes');
  if (!el) return;
  const n = t && t.notes ? t.notes.filter((x) => x.text.trim()).length : 0;
  el.hidden = !n;
  el.innerHTML = n ? `${icon('sticky')}${n} note${n > 1 ? 's' : ''}${notesOn() ? '' : ' (hidden)'}` : '';
}

/** Where a note is pinned: the section heading, plus a quote of the text it was attached to. */
function headingBefore(el) {
  const tome = $('#tome');
  let node = el;
  while (node && node.parentElement !== tome) node = node.parentElement;
  for (let n = node; n; n = n.previousElementSibling) if (/^H[1-6]$/.test(n.tagName)) return n;
  return null;
}
function anchorFor(el, quote = '') {
  const isHeading = /^H[1-6]$/.test(el.tagName);
  const h = isHeading ? el : headingBefore(el);
  return {
    heading: h ? normText(h.textContent) : '',
    quote: quote ? normText(quote).slice(0, 140) : isHeading ? '' : normText(el.textContent).slice(0, 140),
    line: Number(el.dataset.line ?? el.dataset.itemLine ?? -1),
  };
}
function findAnchorEl(note) {
  const tome = $('#tome');
  const a = note.anchor || {};
  const heads = $$('h1, h2, h3, h4, h5, h6', tome);
  const byHeading = a.heading ? heads.filter((h) => normText(h.textContent) === a.heading) : [];
  if (a.quote) {
    const blocks = $$('p, li, td, th, blockquote, pre, h1, h2, h3, h4, h5, h6', tome).filter((b) => normText(b.textContent).includes(a.quote));
    if (blocks.length) {
      // the smallest block that holds the quote, preferring ones under the same heading
      blocks.sort((x, y) => x.textContent.length - y.textContent.length);
      const same = blocks.find((b) => !a.heading || normText((headingBefore(b) || {}).textContent) === a.heading);
      return { el: same || blocks[0], exact: true };
    }
    if (byHeading.length) return { el: byHeading[0], exact: false };
  } else if (byHeading.length) return { el: byHeading[0], exact: true };
  return { el: null, exact: false };
}

function noteCard(note) {
  let el = state.noteEls.get(note.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'sticky';
    el.dataset.id = note.id;
    el.innerHTML = `
      <div class="sk-head">
        <span class="sk-where"></span>
        <button class="sk-btn sk-color" data-sk="color" title="Change color"><span></span></button>
        <button class="sk-btn" data-sk="fold" title="Fold">${icon('minus')}</button>
        <button class="sk-btn" data-sk="del" title="Delete note">${icon('x')}</button>
      </div>
      <textarea class="sk-text" rows="2" placeholder="Write a note… (only you see this, the file isn't touched)" spellcheck="true"></textarea>
      <div class="sk-foot"></div>`;
    el.querySelector('.sk-text').value = note.text;
    state.noteEls.set(note.id, el);
  }
  NOTE_COLORS.forEach((c) => el.classList.toggle(`c-${c}`, note.color === c));
  el.classList.toggle('folded', !!note.folded);
  el.classList.toggle('moved', !!note.moved);
  const where = el.querySelector('.sk-where');
  where.textContent = note.moved ? 'Moved: section not found' : (note.anchor.heading || 'Top of file');
  where.dataset.preview = normText(note.text).slice(0, 34) + (note.text.length > 34 ? '…' : '');
  el.querySelector('.sk-foot').textContent = `${note.updated && note.updated !== note.created ? 'Edited' : 'Added'} ${noteDate(note.updated || note.created)}`;
  return el;
}
function sizeText(ta) { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; }

function clearNotesLayout() {
  const tome = $('#tome');
  $$('.sticky', tome).forEach((n) => n.remove());
  $('#notes-layer').replaceChildren();
  $('#notes-tray').replaceChildren();
  $('#notes-tray').hidden = true;
  tome.style.maxWidth = ''; tome.style.marginLeft = ''; tome.style.marginRight = '';
  document.body.classList.remove('notes-margin');
  $$('.noted', tome).forEach((n) => n.classList.remove('noted'));
}

/** Place every note: in the right margin when there's room, inline under its section when there isn't. */
function renderNotes() {
  // Remember a note you're typing in, so a redraw never steals your cursor.
  const ae = document.activeElement;
  const typing = ae && ae.classList && ae.classList.contains('sk-text') ? { id: ae.closest('.sticky').dataset.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
  renderNotesInner();
  if (typing) {
    const ta = state.noteEls.get(typing.id)?.querySelector('.sk-text');
    if (ta && document.activeElement !== ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(typing.s, typing.e); }
  }
}
function renderNotesInner() {
  const t = cur();
  clearNotesLayout();
  updateNoteCount();
  if (!t || !t.notes || !t.notes.length || !notesOn()) return;
  const frameMode = t.kind === 'html' && (t.mode === 'read' || t.mode === 'split');
  if (t.mode === 'source' || t.mode === 'write') return;
  if (frameMode) { renderNotesTray(t); return; }
  const pane = $('#preview-pane');
  const tome = $('#tome');
  const paneW = pane.clientWidth;
  const margin = paneW >= 780;
  const placed = [];
  for (const note of t.notes) {
    const { el, exact } = findAnchorEl(note);
    note.moved = !el || (!exact && !!note.anchor.quote);
    placed.push({ note, el });
  }
  if (margin) {
    document.body.classList.add('notes-margin');
    tome.style.maxWidth = '';
    const natural = parseFloat(getComputedStyle(tome).maxWidth) || 760;
    const tw = Math.min(natural, paneW - NOTE_W - NOTE_GAP * 3);
    const left = Math.max(NOTE_GAP, Math.round((paneW - tw - NOTE_W - NOTE_GAP) / 2));
    tome.style.maxWidth = `${tw}px`;
    tome.style.marginLeft = `${left}px`;
    tome.style.marginRight = '0';
    const layer = $('#notes-layer');
    layer.style.left = `${left + tw + NOTE_GAP}px`;
    layer.style.width = `${NOTE_W}px`;
    for (const p of placed) layer.appendChild(noteCard(p.note));
    layoutMarginNotes(placed);
  } else {
    for (const { note, el } of placed) {
      const card = noteCard(note);
      card.classList.add('inline');
      if (!el) { tome.prepend(card); continue; }
      const host = el.closest('li') || el;
      const tableWrap = el.closest('.table-wrap');
      if (tableWrap) tableWrap.after(card);
      else if (host.tagName === 'LI') host.appendChild(card);
      else host.after(card);
    }
  }
  placed.forEach(({ el }) => el && el.classList.add('noted'));
  $$('.sk-text').forEach(sizeText);
}
function layoutMarginNotes(placed) {
  const pane = $('#preview-pane');
  const pr = pane.getBoundingClientRect();
  const items = (placed || cur().notes.map((note) => ({ note, el: findAnchorEl(note).el })))
    .map((p) => ({ ...p, top: p.el ? p.el.getBoundingClientRect().top - pr.top + pane.scrollTop : 40 }))
    .sort((a, b) => a.top - b.top);
  let bottom = 0;
  for (const it of items) {
    const card = state.noteEls.get(it.note.id);
    if (!card) continue;
    const y = Math.max(it.top, bottom + 12);
    card.style.top = `${y}px`;
    bottom = y + card.offsetHeight;
  }
  $('#notes-layer').style.height = `${bottom + 40}px`;
}
let relayoutRaf = 0;
function relayoutNotes() {
  cancelAnimationFrame(relayoutRaf);
  relayoutRaf = requestAnimationFrame(() => {
    const t = cur();
    if (!t || !t.notes || !t.notes.length) return;
    if (document.body.classList.contains('notes-margin') && $('#preview-pane').clientWidth >= 780) layoutMarginNotes();
    else renderNotes();
  });
}

/* HTML "Page" view runs in a locked frame, so notes live in a tray on the right. */
function renderNotesTray(t) {
  const tray = $('#notes-tray');
  tray.hidden = false;
  tray.innerHTML = `<div class="nt-head">${icon('sticky')}<b>Notes</b><small>Pinned to sections in Reader view</small><button class="icon-btn xs" data-nt="hide" title="Hide notes">${icon('x')}</button></div>`;
  for (const note of t.notes) tray.appendChild(noteCard(note));
  $$('.sk-text', tray).forEach(sizeText);
}

/* ---- creating notes ---- */
async function addNote(anchorEl, quote = '') {
  const t = cur();
  if (!t) return;
  if (t.mode === 'source') { toast('Switch to Read view to add sticky notes', 'quiet'); return; }
  await ensureNotes(t);
  if (!notesOn()) await setSetting({ notesVisible: true });
  const frameMode = t.kind === 'html' && (t.mode === 'read' || t.mode === 'split');
  let anchor = { heading: '', quote: '', line: -1 };
  if (!frameMode) {
    if (!anchorEl) {
      // the section you're looking at: last heading above the middle of the screen
      const pr = $('#preview-pane').getBoundingClientRect();
      anchorEl = [...$$('#tome h1, #tome h2, #tome h3, #tome h4')].filter((h) => h.getBoundingClientRect().top < pr.top + pr.height / 2).pop()
        || $('#tome').firstElementChild;
    }
    if (anchorEl) anchor = anchorFor(anchorEl, quote);
  }
  const now = Date.now();
  const note = { id: `n${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, anchor, text: '', color: t.notes.length ? t.notes[t.notes.length - 1].color : 'amber', created: now, updated: now };
  t.notes.push(note);
  renderNotes();
  const card = state.noteEls.get(note.id);
  if (card) {
    card.classList.add('pop-in');
    const ta = card.querySelector('.sk-text');
    requestAnimationFrame(() => { ta.focus(); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  }
  renderOutlineIfOpen();
}
function deleteNote(id) {
  const t = cur();
  if (t && t.notes) removeNotes(t, [id]);
}
function toggleNotesVisible() {
  setSetting({ notesVisible: !notesOn() }).then(() => { renderNotes(); toast(notesOn() ? 'Sticky notes shown' : 'Sticky notes hidden (they are still saved)', 'quiet'); });
}
function copyAllNotes() {
  const t = cur();
  const list = (t && t.notes || []).filter((n) => n.text.trim());
  if (!list.length) { toast('No notes on this file yet', 'quiet'); return; }
  const md = [`# Notes on ${t.doc.name}`, '', ...list.map((n) => `- **${n.anchor.heading || 'Top of file'}**${n.anchor.quote ? ` (on "${n.anchor.quote.slice(0, 60)}${n.anchor.quote.length > 60 ? '…' : ''}")` : ''}: ${n.text.trim().replace(/\n+/g, ' ')}`)].join('\n');
  clip.write(null, md);
  toast(`${list.length} note${list.length > 1 ? 's' : ''} copied as Markdown`, 'ok');
}
/* ---- notes manager: see, jump to, and clean up every note on a file ---- */
function openNotesManager() {
  const t = cur();
  if (!t) return;
  const list = (t.notes || []).filter((n) => n.text.trim());
  if (!list.length) { toast('No notes on this file yet. Hover a heading and click the note icon to add one.', 'quiet'); return; }
  const groups = new Map();
  for (const n of list) {
    const key = n.anchor.heading || 'Top of file';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const dot = (c) => ({ amber: '#f3c969', rose: '#f58ea8', sky: '#6fc8f2', mint: '#6fe0b0', lilac: '#b69cff' }[c] || '#f3c969');
  const m = openModal(`
    <h2>${icon('sticky')} Notes on ${escapeHtml(t.doc.name)}</h2>
    <p class="modal-foot" style="margin-top:-8px">These live only in Tomelight. Deleting them never changes the file.</p>
    ${[...groups.entries()].map(([head, notes], gi) => `
      <div class="nm-group">
        <div class="nm-group-head"><b>${escapeHtml(head)}</b>
          <button class="btn sm btn-ghost btn-danger" data-nm="del-group" data-g="${gi}">${icon('x')}Delete ${notes.length > 1 ? `these ${notes.length}` : 'this one'}</button></div>
        ${notes.map((n) => `
          <div class="nm-row" data-id="${n.id}">
            <span class="nm-dot" style="background:${dot(n.color)}"></span>
            <span class="nm-text">${escapeHtml(n.text.trim())}<small>${n.anchor.quote ? `on "${escapeHtml(n.anchor.quote.slice(0, 70))}${n.anchor.quote.length > 70 ? '…' : ''}" · ` : ''}${noteDate(n.updated || n.created)}${n.moved ? ' · section moved' : ''}</small></span>
            <span class="nm-actions">
              <button class="icon-btn xs" data-nm="jump" data-tip="Go to note">${icon('target')}</button>
              <button class="icon-btn xs" data-nm="del" data-tip="Delete note">${icon('x')}</button>
            </span>
          </div>`).join('')}
      </div>`).join('')}
    <div class="nm-foot">
      <span>
        <button class="btn sm btn-ghost" data-nm="copy">${icon('clipboard')}Copy all as Markdown</button>
        <button class="btn sm btn-ghost" data-nm="toggle">${icon('sticky')}${notesOn() ? 'Hide notes' : 'Show notes'}</button>
      </span>
      <button class="btn sm btn-ghost btn-danger" data-nm="del-all">${icon('x')}Delete all ${list.length} notes on this file</button>
    </div>`, 'notes-manager');
  const groupList = [...groups.values()];
  m.onclick = (e) => {
    const b = e.target.closest('[data-nm]');
    if (!b) return;
    const k = b.dataset.nm;
    const row = b.closest('.nm-row');
    if (k === 'jump' && row) {
      closeModal();
      const note = t.notes.find((n) => n.id === row.dataset.id);
      const card = state.noteEls.get(row.dataset.id);
      if (note && note.folded) { note.folded = false; saveNotes(t); noteCard(note); }
      if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.classList.remove('pop-in'); void card.offsetWidth; card.classList.add('pop-in'); }
    }
    if (k === 'del' && row) { removeNotes(t, [row.dataset.id]); openNotesManager(); }
    if (k === 'del-group') { removeNotes(t, groupList[Number(b.dataset.g)].map((n) => n.id)); openNotesManager(); }
    if (k === 'del-all') {
      if (!window.confirm(`Delete all ${list.length} notes on ${t.doc.name}? The file itself is not changed.`)) return;
      removeNotes(t, t.notes.map((n) => n.id));
      closeModal();
    }
    if (k === 'copy') copyAllNotes();
    if (k === 'toggle') { closeModal(); toggleNotesVisible(); }
  };
}
/** Remove several notes at once, with a single Undo. */
function removeNotes(t, ids) {
  const set = new Set(ids);
  const removed = t.notes.filter((n) => set.has(n.id));
  if (!removed.length) return;
  const before = t.notes.slice();
  t.notes = t.notes.filter((n) => !set.has(n.id));
  ids.forEach((id) => { state.noteEls.get(id)?.remove(); state.noteEls.delete(id); });
  saveNotes(t);
  renderNotes();
  renderOutlineIfOpen();
  if (!$('#modal').hidden && !t.notes.filter((n) => n.text.trim()).length) closeModal();
  const real = removed.filter((n) => n.text.trim()).length;
  if (real) toast(`${real} note${real > 1 ? 's' : ''} deleted`, 'quiet', { action: 'Undo', run: () => { t.notes = before; saveNotes(t); renderNotes(); renderOutlineIfOpen(); } });
}

function renderOutlineIfOpen() { if (state.settings.sidebarPanel === 'outline') renderOutline(); }

function bindNotes() {
  const onCardEvent = (e) => {
    const card = e.target.closest('.sticky');
    if (!card) return null;
    const t = cur();
    const note = t && t.notes && t.notes.find((n) => n.id === card.dataset.id);
    return note ? { card, note, t } : null;
  };
  document.addEventListener('input', (e) => {
    if (!e.target.classList.contains('sk-text')) return;
    const c = onCardEvent(e);
    if (!c) return;
    c.note.text = e.target.value;
    c.note.updated = Date.now();
    sizeText(e.target);
    saveNotes(c.t);
    if (c.card.parentElement && c.card.parentElement.id === 'notes-layer') relayoutNotes();
  });
  document.addEventListener('focusout', (e) => {
    if (!e.target.classList || !e.target.classList.contains('sk-text')) return;
    const c = onCardEvent(e);
    if (c && !c.note.text.trim()) setTimeout(() => { if (!c.note.text.trim() && document.activeElement !== e.target) deleteNote(c.note.id); }, 150);
  });
  document.addEventListener('click', (e) => {
    const nt = e.target.closest('[data-nt="hide"]');
    if (nt) { toggleNotesVisible(); return; }
    const btn = e.target.closest('.sk-btn');
    const c = onCardEvent(e);
    if (!c) return;
    if (btn) {
      const k = btn.dataset.sk;
      if (k === 'del') deleteNote(c.note.id);
      if (k === 'fold') { c.note.folded = !c.note.folded; saveNotes(c.t); noteCard(c.note); relayoutNotes(); }
      if (k === 'color') { c.note.color = NOTE_COLORS[(NOTE_COLORS.indexOf(c.note.color) + 1) % NOTE_COLORS.length]; saveNotes(c.t); noteCard(c.note); }
      return;
    }
    if (c.note.folded) { c.note.folded = false; saveNotes(c.t); noteCard(c.note); relayoutNotes(); }
  });
  // hovering a note lights up the part of the page it's pinned to
  document.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.sticky');
    $$('.note-hover').forEach((x) => x.classList.remove('note-hover'));
    if (!card) return;
    const t = cur();
    const note = t && t.notes && t.notes.find((n) => n.id === card.dataset.id);
    const el = note && findAnchorEl(note).el;
    if (el) el.classList.add('note-hover');
  });
  $('#sb-notes').onclick = openNotesManager;
  new ResizeObserver(() => relayoutNotes()).observe($('#preview-pane'));
  $('#tome').addEventListener('load', () => relayoutNotes(), true); // images changing height
}

/* ------------------------------------------------------------------ */
/* Write mode: type like Google Docs, saved as clean Markdown           */
/* ------------------------------------------------------------------ */
function bodyParts(content) {
  const { offset } = splitFrontMatter(content);
  if (!offset) return { fm: '', body: content };
  const lines = content.split('\n');
  return { fm: `${lines.slice(0, offset).join('\n').replace(/\n+$/, '')}\n`, body: lines.slice(offset).join('\n').replace(/^\n+/, '') };
}
function resolveSrc(src) {
  const t = cur();
  if (!src || /^(https?:|data:|blob:|file:)/i.test(src)) return src;
  if (src.startsWith('/')) return `file://${src}`;
  try { return new URL(src, t.doc.dirUrl).href; } catch { return src; }
}
const WRITE_ACTIVE = {
  bold: ['bold'], italic: ['italic'], strike: ['strike'], code: ['code'],
  h1: ['heading', { level: 1 }], h2: ['heading', { level: 2 }], h3: ['heading', { level: 3 }],
  ul: ['bulletList'], ol: ['orderedList'], task: ['taskList'], quote: ['blockquote'], link: ['link'],
};
function ensureWriter() {
  if (state.writer) return state.writer;
  state.writer = createWriter($('#write-host'), {
    onChange: () => { clearTimeout(state.writeTimer); state.writeTimer = setTimeout(() => flushWriter(cur()), 250); },
    resolveSrc,
    onLinkClick: (href) => followLink(href),
  });
  const bar = $('#write-toolbar');
  bar.innerHTML = TOOLBAR.filter((b) => b === '|' || b.k !== 'tidy').map((b) => (b === '|' ? '<span class="tb-sep"></span>'
    : `<button type="button" data-wfmt="${b.k}" data-tip="${b.tip}">${b.icon ? icon(b.icon) : `<b>${b.label}</b>`}</button>`)).join('')
    + `<span class="tb-hint">Type <kbd>#</kbd> heading · <kbd>-</kbd> list · <kbd>[ ]</kbd> checkbox · <kbd>${MOD}B</kbd> bold</span>`;
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-wfmt]');
    if (!b) return;
    const k = b.dataset.wfmt;
    if (k === 'image') { pickAndInsert(); return; }
    if (k === 'link') { openLinkPop(b); return; }
    state.writer.cmd(k);
  });
  const sync = () => {
    $$('#write-toolbar button[data-wfmt]').forEach((b) => {
      const a = WRITE_ACTIVE[b.dataset.wfmt];
      b.classList.toggle('on', !!(a && state.writer.isActive(...a)));
    });
  };
  state.writer.editor.on('transaction', sync);
  state.writer.editor.on('blur', () => flushWriter(cur()));
  return state.writer;
}
function enterWrite(t, { focusText = null } = {}) {
  const w = ensureWriter();
  const { fm, body } = bodyParts(t.content);
  t.writeFm = fm;
  w.load(body);
  $('#write-scroll').scrollTop = 0;
  if (t.content.length > 400 && !state.settings.writeTipSeen && !t.writeTipShown) {
    t.writeTipShown = true;
    showBanner('Write mode saves clean Markdown. When you edit, small details like spacing or list symbols may be tidied. Split keeps the file exactly as is.', [
      { label: 'Use Split', run: () => { hideBanner(); setMode('split'); } },
      { label: 'Got it', primary: true, run: () => { hideBanner(); setSetting({ writeTipSeen: true }); } },
    ], 'write-tip');
  }
  requestAnimationFrame(() => {
    if (focusText) {
      const needle = normText(focusText).slice(0, 60);
      const el = [...$$('#write-host .ProseMirror > *, #write-host li, #write-host td')].find((x) => normText(x.textContent).startsWith(needle));
      if (el) {
        try {
          const pos = w.editor.view.posAtDOM(el, 0);
          w.editor.chain().focus().setTextSelection(pos + 1).run();
          el.scrollIntoView({ block: 'center' });
          el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
          return;
        } catch { /* fall through */ }
      }
    }
    w.editor.commands.focus('start', { scrollIntoView: false });
    $('#write-scroll').scrollTop = 0;
  });
}
/** Push what's in the Write editor back into the tab (and let autosave take it from there). */
function flushWriter(t) {
  clearTimeout(state.writeTimer);
  if (!t || t.mode !== 'write' || !state.writer || t !== cur()) return;
  const md = state.writer.getMarkdown().replace(/\s+$/, '');
  const next = `${t.writeFm ? `${t.writeFm}\n` : ''}${md}\n`;
  if (next === t.content) return;
  t.content = next;
  t.render = renderMarkdown(next, { plain: t.kind === 'txt' });
  markDirty(t);
  updateChrome();
  refreshTabChip(t);
  if (state.settings.autosave) { clearTimeout(t.saveTimer); t.saveTimer = setTimeout(() => save(t), 700); }
}
function reloadWriter(t) {
  if (!state.writer || t.mode !== 'write' || t !== cur()) return;
  const { fm, body } = bodyParts(t.content);
  t.writeFm = fm;
  state.writer.load(body);
}
function openLinkPop(btn) {
  const pop = $('#link-pop');
  const r = btn.getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = `${Math.min(window.innerWidth - pop.offsetWidth - 12, r.left - 10)}px`;
  pop.style.top = `${r.bottom + 8}px`;
  const input = $('#link-input');
  input.value = state.writer.isActive('link') ? (state.writer.editor.getAttributes('link').href || '') : '';
  input.focus();
  input.select();
}
function bindLinkPop() {
  const pop = $('#link-pop');
  const input = $('#link-input');
  const apply = () => {
    let v = input.value.trim();
    pop.hidden = true;
    if (!v) return;
    if (!/^(https?:|mailto:|#|\.|\/)/i.test(v) && /\./.test(v)) v = `https://${v}`;
    state.writer.cmd('link', v);
  };
  $('#link-apply').onclick = apply;
  $('#link-remove').onclick = () => { pop.hidden = true; state.writer.cmd('link', ''); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
    if (e.key === 'Escape') { e.preventDefault(); pop.hidden = true; state.writer.focus(); }
  });
  document.addEventListener('mousedown', (e) => { if (!pop.hidden && !e.target.closest('#link-pop, [data-wfmt="link"]')) pop.hidden = true; });
}

/* ---- Tidy: one click to fix spacing, line breaks and bullets ---- */
function tidyCurrent() {
  const t = cur();
  if (!t || t.kind === 'html') { toast('Tidy works on Markdown files', 'quiet'); return; }
  if (t.mode === 'write') flushWriter(t);
  const r = tidyMarkdown(t.content);
  if (!r.changed) { toast('Already tidy, nothing to fix', 'ok'); return; }
  applyChange(r.src).then(() => {
    toast(`Tidied: ${describeFixes(r.fixes) || 'formatting'}`, 'ok', { action: 'Undo', run: () => undoAction(false) });
  });
}

/* ------------------------------------------------------------------ */
/* Menus, modals, toasts                                                */
/* ------------------------------------------------------------------ */
function popMenu(items, { x, y, anchor, head } = {}) {
  const pop = $('#menu-pop');
  items = items.filter(Boolean);
  pop.innerHTML = (head ? `<div class="mp-head">${escapeHtml(head)}</div>` : '')
    + items.map((it, i) => (it.sep ? '<div class="mp-sep"></div>' : `<button data-i="${i}" class="${it.sub ? 'mp-rich' : ''}">${icon(it.icon)}<span>${escapeHtml(it.label)}${it.sub ? `<small>${escapeHtml(it.sub)}</small>` : ''}</span>${it.keys ? `<kbd>${it.keys}</kbd>` : ''}</button>`)).join('');
  pop.hidden = false;
  pop.style.left = ''; pop.style.right = '';
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.right = `${window.innerWidth - r.right}px`;
  } else {
    const w = pop.offsetWidth; const h = pop.offsetHeight;
    pop.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
    pop.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
  }
  pop.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenus();
    items[Number(b.dataset.i)].run();
  };
}
function openMoreMenu(anchor) {
  const t = cur();
  popMenu([
    { label: 'Open folder…', icon: 'folder', keys: `⇧${MOD}O`, run: () => api.openDialog({ folders: true }) },
    { label: 'Quick open…', icon: 'search', keys: `${MOD}P`, run: () => openPalette('files') },
    t && { sep: true },
    t && { label: 'Reveal in Finder', icon: 'finder', run: () => api.reveal(t.file) },
    t && { label: 'Export as PDF…', icon: 'download', run: exportPdf },
    t && t.kind !== 'html' && { label: 'Export as HTML…', icon: 'download', run: exportHtml },
    t && t.kind !== 'html' && { label: 'Complete all tasks', icon: 'checks', run: completeAll },
    t && t.kind !== 'html' && { label: 'Tidy formatting', icon: 'sparkles', keys: `⌥${MOD}T`, run: tidyCurrent },
    t && t.kind !== 'html' && { label: 'Paste as Markdown', icon: 'paste', keys: `⇧${MOD}V`, run: pasteAsMarkdown },
    { label: 'Image Studio', icon: 'image', keys: `⇧${MOD}I`, run: openStudio },
    t && { label: 'Add sticky note', icon: 'sticky', keys: `⌥${MOD}N`, run: () => addNote() },
    t && { label: notesOn() ? 'Hide sticky notes' : 'Show sticky notes', icon: 'sticky', keys: `⇧⌥${MOD}N`, run: toggleNotesVisible },
    t && t.notes && t.notes.some((n) => n.text.trim()) && { label: 'Manage notes…', icon: 'sticky', run: openNotesManager },
    { sep: true },
    { label: 'Focus mode', icon: 'focus', run: toggleFocus },
    { label: 'Settings…', icon: 'sliders', keys: `${MOD},`, run: openSettings },
    { label: 'Keyboard shortcuts', icon: 'keyboard', keys: `${MOD}/`, run: openShortcuts },
  ], { anchor });
}
function closeMenus() { $('#menu-pop').hidden = true; }

function openModal(html, cls = '') {
  const m = $('#modal');
  m.className = `modal ${cls}`;
  m.innerHTML = `<button class="icon-btn sm modal-close">${icon('x')}</button>${html}`;
  m.hidden = false;
  $('#scrim').hidden = false;
  m.querySelector('.modal-close').onclick = closeModal;
  return m;
}
function closeModal() {
  $('#modal').hidden = true;
  if ($('#palette').hidden) $('#scrim').hidden = true;
}

function openSettings() {
  const s = state.settings;
  const themeCard = (id, name, desc) => `
    <button class="theme-card ${s.theme === id ? 'active' : ''}" data-theme="${id}">
      <span class="swatch sw-${id}"><i></i><i></i><i></i></span><b>${name}</b><small>${desc}</small>
    </button>`;
  const toggle = (key, label, desc) => `
    <label class="setting-row"><span><b>${label}</b><small>${desc}</small></span>
      <input type="checkbox" class="switch" data-key="${key}" ${s[key] ? 'checked' : ''}/></label>`;
  const seg = (key, opts) => `<div class="mini-seg" data-key="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${s[key] === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const m = openModal(`
    <h2>${icon('sliders')} Settings</h2>
    <h4>Theme</h4>
    <div class="theme-grid">
      ${themeCard('wire', 'Wire', 'Cyber-noir')}
      ${themeCard('nebula', 'Nebula', 'Midnight starlight')}
      ${themeCard('arcane', 'Arcane', 'Ink and gold')}
      ${themeCard('parchment', 'Parchment', 'Warm paper')}
      ${themeCard('auto', 'Auto', 'Follows macOS')}
    </div>
    <h4>Reading</h4>
    <div class="setting-row"><span><b>Body font</b><small>Headings use the theme's display font</small></span>${seg('bodyFont', [['sans', 'Sans'], ['serif', 'Serif']])}</div>
    <div class="setting-row"><span><b>Reading width</b><small>How wide the page runs</small></span>${seg('width', [['narrow', 'Narrow'], ['comfortable', 'Comfy'], ['wide', 'Wide']])}</div>
    <div class="setting-row"><span><b>Text size</b><small>${Math.round(s.fontScale * 100)}%</small></span>${seg('fontScale', [[0.9, 'S'], [1, 'M'], [1.12, 'L'], [1.25, 'XL']])}</div>
    <h4>Image optimizer</h4>
    <div class="setting-row"><span><b>Max width</b><small>Bigger images are scaled down, smaller ones are never enlarged</small></span>${seg('imgMaxWidth', [[1200, '1200'], [1600, '1600'], [2000, '2000'], [2560, '2560']])}</div>
    <div class="setting-row"><span><b>Quality</b><small>82 is the sweet spot for blogs</small></span>${seg('imgQuality', [[70, 'Small'], [82, 'Balanced'], [90, 'High']])}</div>
    <h4>Behavior</h4>
    ${toggle('autosave', 'Autosave', 'Save edits automatically as you type')}
    ${toggle('restoreSession', 'Reopen last session', 'Bring back your folder and tabs when Tomelight starts')}
    ${toggle('dblClickEdit', 'Double-click to edit', 'Double-click any paragraph to jump into the editor at that line')}
    ${toggle('strikeDone', 'Strike through done tasks', 'Draw a line through checked-off items and rows')}
    ${toggle('notesVisible', 'Show sticky notes', 'Notes stay saved when hidden')}
    ${toggle('showLineBreaks', 'Show line breaks as typed', 'A single Enter starts a new line when reading, like in a normal document')}
    <h4>Sticky notes</h4>
    <div class="setting-row"><span><b>Delete every note in Tomelight</b><small id="notes-total">Counting…</small></span><button class="btn sm btn-ghost btn-danger" id="wipe-notes">Delete all</button></div>
  `, 'settings');
  api.notesCount().then((c) => { const el = m.querySelector('#notes-total'); if (el) el.textContent = c.notes ? `${c.notes} note${c.notes > 1 ? 's' : ''} across ${c.files} file${c.files > 1 ? 's' : ''}. Your files are never touched.` : 'No notes yet.'; });
  m.querySelector('#wipe-notes').onclick = async () => {
    const c = await api.notesCount();
    if (!c.notes) { toast('No notes to delete', 'quiet'); return; }
    if (!window.confirm(`Delete all ${c.notes} sticky notes in every file? This can't be undone. Your files are not changed.`)) return;
    await api.notesClearAll();
    state.tabs.forEach((x) => { x.notes = []; });
    state.noteEls.forEach((el) => el.remove()); state.noteEls.clear();
    renderNotes(); renderOutlineIfOpen();
    toast('All sticky notes deleted', 'ok');
    openSettings();
  };
  m.querySelectorAll('.theme-card').forEach((b) => { b.onclick = async () => { await setSetting({ theme: b.dataset.theme }); openSettings(); }; });
  m.querySelectorAll('.switch').forEach((c) => { c.onchange = () => setSetting({ [c.dataset.key]: c.checked }).then(() => { if (c.dataset.key === 'notesVisible') renderNotes(); }); });
  m.querySelectorAll('.mini-seg').forEach((sg) => sg.querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      const key = sg.dataset.key;
      const v = ['fontScale', 'imgMaxWidth', 'imgQuality'].includes(key) ? Number(b.dataset.v) : b.dataset.v;
      await setSetting({ [key]: v });
      openSettings();
    };
  }));
}

function openShortcuts() {
  const rows = [
    ['Open file', `${MOD}O`], ['Open folder', `⇧${MOD}O`], ['Quick open (find a file)', `${MOD}P`], ['Command palette', `${MOD}K`],
    ['Next / previous tab', '⌃⇥ / ⌃⇧⇥'], ['Close tab', `${MOD}W`], ['Reopen closed tab', `⇧${MOD}T`], ['New file', `${MOD}N`],
    ['Read / Write / Split / Source', `${MOD}1 / 2 / 3 / 4`], ['Switch between Read and Write', `${MOD}E`], ['Tidy formatting', `⌥${MOD}T`], ['Save / Save all', `${MOD}S / ⌥${MOD}S`],
    ['Mark as done', `${MOD}D`], ['Complete all tasks', `⇧${MOD}D`], ['Toggle task on line (editor)', `${MOD}↩`],
    ['Bold / italic (editor)', `${MOD}B / ${MOD}I`], ['Find', `${MOD}F`], ['Undo / redo', `${MOD}Z / ⇧${MOD}Z`],
    ['Toggle sidebar', `${MOD}\\`], ['Folder / Outline panel', `⇧${MOD}1 / ⇧${MOD}2`], ['Focus mode', `⇧${MOD}F`],
    ['Text size', `${MOD}+ / ${MOD}−`], ['Copy for email / web / social', `⇧${MOD}C / ⌥${MOD}H / ⌥${MOD}C`], ['Paste as Markdown', `⇧${MOD}V`], ['Image Studio (or just drop photos in)', `⇧${MOD}I`], ['Add sticky note / show or hide notes', `⌥${MOD}N / ⇧⌥${MOD}N`],
    ['Export PDF / HTML', `⇧${MOD}P / ⇧${MOD}E`], ['Reveal in Finder', `⇧${MOD}R`], ['Settings', `${MOD},`],
  ];
  openModal(`<h2>${icon('keyboard')} Keyboard Shortcuts</h2>
    <div class="kbd-grid">${rows.map(([a, k]) => `<div class="kbd-row"><span>${a}</span><kbd>${k}</kbd></div>`).join('')}</div>
    <p class="modal-foot">Click any checkbox (in lists or tables) to tick it, and it saves straight to the file. Hover a plain bullet and click the ghost circle to check it off. ${state.settings.dblClickEdit ? 'Double-click any paragraph to edit it. ' : ''}Middle-click or ${MOD}W closes a tab. Drag tabs to reorder them.</p>`, 'shortcuts');
}

function toast(text, kind = 'info', action = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const ic = { ok: 'check', error: 'x', magic: 'sparkles', quiet: 'sparkles', info: 'sparkles' }[kind];
  el.innerHTML = `${icon(ic)}<span>${escapeHtml(text)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.action; b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), action ? 5200 : 2200);
  setTimeout(() => el.remove(), action ? 5600 : 2600);
}

function celebrate(anchor) {
  if (!anchor || anchor.hidden) return;
  const r = anchor.getBoundingClientRect();
  const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
  for (let i = 0; i < 22; i++) {
    const s = document.createElement('span');
    s.className = 'spark';
    const a = (Math.PI * 2 * i) / 22 + Math.random() * 0.3;
    const d = 40 + Math.random() * 70;
    s.style.left = `${cx}px`; s.style.top = `${cy}px`;
    s.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * d + 20}px`);
    s.style.animationDelay = `${Math.random() * 80}ms`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 1100);
  }
}

/* ------------------------------------------------------------------ */
/* View helpers                                                         */
/* ------------------------------------------------------------------ */
function toggleSidebar() { setSetting({ sidebar: !state.settings.sidebar }); }
function showPanel(p) { setSetting({ sidebarPanel: p, sidebar: true }); }
function toggleFocus() { document.body.classList.toggle('focus'); if (document.body.classList.contains('focus')) toast(`Focus mode · ⇧${MOD}F or esc to leave`, 'quiet'); }
const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];
function zoom(d) {
  const c = state.settings.fontScale;
  let next;
  if (d === 0) next = 1;
  else if (d > 0) next = ZOOM_STEPS.find((s) => s > c + 0.001) ?? 2;
  else next = [...ZOOM_STEPS].reverse().find((s) => s < c - 0.001) ?? 0.7;
  setScale(next, true);
  flashZoom();
}
/** Apply a text scale instantly; persist it (debounced) so the slider stays smooth. */
let scaleTimer = null;
function setScale(v, persist = true) {
  v = Math.round(Math.max(0.7, Math.min(2, v)) * 100) / 100;
  state.settings.fontScale = v;
  document.documentElement.style.setProperty('--scale', v);
  syncZoomUI();
  if (persist) { clearTimeout(scaleTimer); scaleTimer = setTimeout(() => setSetting({ fontScale: v }), 250); }
}
function syncZoomUI() {
  const pct = Math.round(state.settings.fontScale * 100);
  const r = $('#zoom-range'); if (r && Number(r.value) !== pct) r.value = pct;
  const v = $('#zoom-val'); if (v) v.textContent = `${pct}%`;
  const range = $('#zoom-range');
  if (range) range.style.setProperty('--fill', `${((pct - 70) / 130) * 100}%`);
}
let zoomFlashTimer = null;
function flashZoom() {
  const z = $('#zoom-ctl');
  z.classList.add('flash');
  clearTimeout(zoomFlashTimer);
  zoomFlashTimer = setTimeout(() => z.classList.remove('flash'), 900);
}

async function exportPdf() {
  const t = cur();
  if (!t) return;
  const prevMode = t.mode;
  if (t.kind !== 'html' && t.mode === 'source') setMode('read');
  document.body.classList.add('printing');
  try {
    const res = await api.exportPdf({ file: t.file, isHtml: t.kind === 'html', suggested: t.doc.name.replace(/\.[^.]+$/, '') });
    if (res && res.path) toast('PDF exported', 'ok');
  } catch (err) { toast(`Export failed: ${err.message || err}`, 'error'); }
  document.body.classList.remove('printing');
  if (prevMode !== t.mode) setMode(prevMode);
}
async function exportHtml() {
  const t = cur();
  if (!t || t.kind === 'html') return;
  if (t.mode === 'source') renderPreview();
  const css = await api.assetText('renderer.css');
  const clone = $('#tome').cloneNode(true);
  clone.querySelectorAll('.ghost-check, .code-copy, .mermaid-src').forEach((n) => n.remove());
  const title = t.render?.headings?.[0]?.text || t.doc.name;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style><style>html,body{height:auto;overflow:auto}body{background:var(--bg)}.tome{padding-top:64px}</style></head><body class="theme-parchment exported" data-font="${state.settings.bodyFont}" data-width="comfortable"><article class="tome">${clone.innerHTML}</article></body></html>`;
  const res = await api.exportHtml({ file: t.file, html, suggested: t.doc.name.replace(/\.[^.]+$/, '') });
  if (res && res.path) toast('HTML exported', 'ok');
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                         */
/* ------------------------------------------------------------------ */
function bindUI() {
  /* text zoom: slider, buttons, and trackpad pinch / ⌘-scroll */
  $('#zoom-range').addEventListener('input', (e) => setScale(Number(e.target.value) / 100));
  $('#zoom-in').onclick = () => zoom(1);
  $('#zoom-out').onclick = () => zoom(-1);
  $('#zoom-val').onclick = () => zoom(0);
  window.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; // pinch-to-zoom arrives as ctrl+wheel
    if (!e.target.closest('.stage')) return;
    e.preventDefault();
    setScale(state.settings.fontScale * Math.exp(-e.deltaY * 0.01));
    flashZoom();
  }, { passive: false });

  $('#btn-sidebar').onclick = toggleSidebar;
  $('#btn-palette').onclick = () => openPalette();
  $('#btn-more').onclick = (e) => { e.stopPropagation(); if ($('#menu-pop').hidden) openMoreMenu(e.currentTarget); else closeMenus(); };
  $('#btn-seal').onclick = toggleSeal;
  $('#btn-copy').onclick = (e) => { e.stopPropagation(); if ($('#menu-pop').hidden) openCopyMenu({ anchor: e.currentTarget }); else closeMenus(); };
  $('#btn-close-all').onclick = closeAll;
  $('#progress').onclick = jumpToNextTask;
  $('#w-open').onclick = () => api.openDialog();
  $('#w-folder').onclick = () => api.openDialog({ folders: true });
  $('#w-new').onclick = () => api.newFile(state.folder);
  $('#modes').onclick = (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); };
  $('#side-switch').onclick = (e) => { const b = e.target.closest('button[data-panel]'); if (b) setSetting({ sidebarPanel: b.dataset.panel }); };
  window.addEventListener('resize', () => { moveGlider(); moveSwitchGlider(); });

  /* vertical tabs */
  const tl = $('#tabs-list');
  tl.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) { e.stopPropagation(); closeTab(Number(close.dataset.close)); return; }
    const it = e.target.closest('.tab-item');
    if (it) activate(Number(it.dataset.id));
  });
  tl.addEventListener('auxclick', (e) => {
    const it = e.target.closest('.tab-item');
    if (it && e.button === 1) closeTab(Number(it.dataset.id));
  });
  tl.addEventListener('contextmenu', (e) => {
    const it = e.target.closest('.tab-item');
    if (!it) return;
    e.preventDefault();
    const t = state.tabs.find((x) => x.id === Number(it.dataset.id));
    popMenu([
      { label: 'Close', icon: 'x', keys: `${MOD}W`, run: () => closeTab(t.id) },
      state.tabs.length > 1 && { label: 'Close others', icon: 'x', run: () => closeOthers(t.id) },
      { label: 'Close all', icon: 'x', run: closeAll },
      { sep: true },
      { label: 'Reveal in Finder', icon: 'finder', run: () => api.reveal(t.file) },
      { label: 'Copy path', icon: 'file', run: () => { navigator.clipboard.writeText(t.file); toast('Path copied', 'ok'); } },
    ], { x: e.clientX, y: e.clientY });
  });
  let dragId = null;
  tl.addEventListener('dragstart', (e) => {
    const it = e.target.closest('.tab-item');
    if (!it) return;
    dragId = Number(it.dataset.id);
    e.dataTransfer.setData('application/x-tomelight-tab', String(dragId));
    e.dataTransfer.effectAllowed = 'move';
    it.classList.add('dragging');
  });
  tl.addEventListener('dragend', () => { dragId = null; $$('.tab-item', tl).forEach((x) => x.classList.remove('dragging', 'drop-above', 'drop-below')); });
  tl.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    e.stopPropagation();
    const it = e.target.closest('.tab-item');
    $$('.tab-item', tl).forEach((x) => x.classList.remove('drop-above', 'drop-below'));
    if (!it || Number(it.dataset.id) === dragId) return;
    const r = it.getBoundingClientRect();
    it.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
  });
  tl.addEventListener('drop', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    e.stopPropagation();
    const it = e.target.closest('.tab-item');
    if (it && Number(it.dataset.id) !== dragId) {
      const moving = state.tabs.find((x) => x.id === dragId);
      state.tabs = state.tabs.filter((x) => x !== moving);
      const target = state.tabs.findIndex((x) => x.id === Number(it.dataset.id));
      const r = it.getBoundingClientRect();
      state.tabs.splice(e.clientY < r.top + r.height / 2 ? target : target + 1, 0, moving);
      renderTabs();
      saveSession();
    }
    dragId = null;
  });

  /* sidebar body: tree + outline */
  $('#side-body').addEventListener('click', (e) => {
    const o = e.target.closest('.outline-item');
    if (o) { scrollToHeading(o.dataset.id); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'new') api.newFile(treeRoot());
      if (a === 'collapse') { state.expanded = new Set(); renderFolderPanel(); saveSession(); }
      if (a === 'close-folder') closeFolder();
      if (a === 'pin') api.open(treeRoot());
      return;
    }
    const row = e.target.closest('.tree-row');
    if (!row) return;
    if (row.dataset.dir) {
      const p = row.dataset.path;
      if (state.expanded.has(p)) state.expanded.delete(p); else state.expanded.add(p);
      renderFolderPanel();
      saveSession();
    } else openTab(row.dataset.path);
  });
  $('#side-body').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    e.preventDefault();
    const p = row.dataset.path;
    popMenu([
      !row.dataset.dir && { label: 'Open', icon: 'file', run: () => openTab(p) },
      !row.dataset.dir && { label: 'Open in new window', icon: 'open', run: () => api.open(p, { newWindow: true }) },
      row.dataset.dir && { label: 'Open as workspace', icon: 'open', run: () => api.open(p) },
      row.dataset.dir && { label: 'New file here…', icon: 'plus', run: () => api.newFile(p) },
      { label: 'Reveal in Finder', icon: 'finder', run: () => api.reveal(p) },
      { label: 'Copy path', icon: 'file', run: () => { navigator.clipboard.writeText(p); toast('Path copied', 'ok'); } },
    ], { x: e.clientX, y: e.clientY });
  });

  /* sidebar resize: drag the edge; drag it far left to hide the sidebar */
  const rz = $('#side-resizer');
  rz.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { rz.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add('resizing');
    let lastX = e.clientX;
    let raf = 0;
    const move = (ev) => {
      lastX = ev.clientX;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = Math.max(200, Math.min(560, lastX));
        document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
        document.body.classList.toggle('will-collapse', lastX < 140);
      });
    };
    const end = () => {
      rz.removeEventListener('pointermove', move);
      rz.removeEventListener('pointerup', end);
      rz.removeEventListener('pointercancel', end);
      rz.removeEventListener('lostpointercapture', end);
      window.removeEventListener('blur', end);
      if (!document.body.classList.contains('resizing')) return;
      cancelAnimationFrame(raf);
      document.body.classList.remove('resizing', 'will-collapse');
      if (lastX < 140) {
        document.documentElement.style.setProperty('--sidebar-w', `${state.settings.sidebarWidth || 290}px`);
        setSetting({ sidebar: false });
        toast(`Sidebar hidden · ${MOD}\\ or the tab on the left brings it back`, 'quiet');
      } else setSetting({ sidebarWidth: Math.max(200, Math.min(560, lastX)) });
    };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', end);
    rz.addEventListener('pointercancel', end);
    rz.addEventListener('lostpointercapture', end);
    window.addEventListener('blur', end);
  });
  rz.addEventListener('dblclick', () => setSetting({ sidebarWidth: 290 }));
  $('#btn-hide-side').onclick = () => setSetting({ sidebar: false });
  $('#sidebar-reveal').onclick = () => setSetting({ sidebar: true });

  // Segmented highlights re-measure whenever their box changes size (sidebar drags, window resizes, zoom).
  const ro = new ResizeObserver(() => { moveGlider(); moveSwitchGlider(); });
  ro.observe($('#side-switch'));
  ro.observe($('#modes'));

  $('#welcome-recent').addEventListener('click', (e) => {
    const clear = e.target.closest('[data-clear]');
    if (clear) { setSetting(clear.dataset.clear === 'folders' ? { recentFolders: [] } : { recent: [] }); return; }
    const c = e.target.closest('.recent-card');
    if (!c) return;
    if (e.target.closest('.rc-remove')) {
      const p = c.dataset.path;
      c.classList.add('removing');
      setTimeout(() => {
        if (c.dataset.kind === 'folder') setSetting({ recentFolders: (state.settings.recentFolders || []).filter((x) => x !== p) });
        else setSetting({ recent: (state.settings.recent || []).filter((x) => x !== p) });
      }, 160);
      return;
    }
    api.open(c.dataset.path);
  });
  $('#welcome-recent').addEventListener('keydown', (e) => {
    const c = e.target.closest('.recent-card');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); api.open(c.dataset.path); }
  });

  /* preview interactions */
  const tome = $('#tome');
  tome.addEventListener('click', (e) => {
    const box = e.target.closest('.task-box');
    if (box) { e.preventDefault(); toggleTask(box); return; }
    const hn = e.target.closest('.heading-note');
    if (hn) { e.preventDefault(); e.stopPropagation(); addNote(hn.parentElement); return; }
    const hc = e.target.closest('.heading-copy');
    if (hc) {
      e.preventDefault(); e.stopPropagation();
      const r = hc.getBoundingClientRect();
      openCopyMenu({ x: r.left, y: r.bottom + 6 }, sectionFragment(hc.parentElement));
      return;
    }
    const ghost = e.target.closest('.ghost-check');
    if (ghost) { e.preventDefault(); addCheck(Number(ghost.dataset.line)); return; }
    const copy = e.target.closest('.code-copy');
    if (copy) {
      const code = copy.closest('.code-block').querySelector('pre');
      navigator.clipboard.writeText(code.innerText);
      copy.textContent = 'Copied'; copy.classList.add('done');
      setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('done'); }, 1400);
      return;
    }
    const img = e.target.closest('img');
    if (img && !img.closest('a')) { openLightbox(img.src); return; }
    const a = e.target.closest('a[href]');
    if (a) { e.preventDefault(); followLink(a.getAttribute('href'), e.metaKey); }
  });
  tome.addEventListener('keydown', (e) => {
    const box = e.target.closest && e.target.closest('.task-box');
    if (box && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggleTask(box); }
  });
  tome.addEventListener('dblclick', (e) => {
    const t = cur();
    if (!t || !state.settings.dblClickEdit || t.kind === 'html' || t.mode !== 'read') return;
    if (e.target.closest('.task-box, .ghost-check, a, .code-copy, img, .heading-copy, .heading-note, .sticky')) return;
    const el = e.target.closest('[data-item-line], tr, [data-line]');
    if (!el) return;
    let line = Number(el.dataset.itemLine ?? el.dataset.line);
    if (el.tagName === 'TR') { const b = el.querySelector('.task-box'); const tbl = el.closest('[data-line]'); line = b ? Number(b.dataset.line) : tbl ? Number(tbl.dataset.line) : NaN; }
    if (Number.isNaN(line)) return;
    window.getSelection()?.removeAllRanges();
    if (t.kind === 'md') setMode('write', { focusText: el.textContent });
    else setMode('split', { line });
  });
  $('#preview-pane').addEventListener('scroll', () => requestAnimationFrame(spyOutline), { passive: true });

  $('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
  $('#scrim').onclick = () => { closePalette(); closeModal(); };

  /* palette */
  const pin = $('#palette-input');
  pin.addEventListener('input', updatePalette);
  pin.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  $('#palette-list').addEventListener('mousemove', (e) => {
    const it = e.target.closest('.pl-item');
    if (it && Number(it.dataset.i) !== paletteIdx) { paletteIdx = Number(it.dataset.i); $$('.pl-item').forEach((el) => el.classList.toggle('active', el === it)); }
  });
  $('#palette-list').addEventListener('click', (e) => { const it = e.target.closest('.pl-item'); if (it) runPalette(Number(it.dataset.i)); });

  /* find */
  const fin = $('#find-input');
  fin.addEventListener('input', () => runFind(fin.value));
  fin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runFind(fin.value, { step: e.shiftKey ? -1 : 1 }); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('#find-next').onclick = () => runFind(fin.value, { step: 1 });
  $('#find-prev').onclick = () => runFind(fin.value, { step: -1 });
  $('#find-close').onclick = closeFind;

  /* global keys */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#help-pop').hidden) $('#help-pop').hidden = true;
      else if (!$('#palette').hidden) closePalette();
      else if (state.studio.open && $('#modal').hidden && $('#menu-pop').hidden) closeStudio();
      else if (!$('#modal').hidden) closeModal();
      else if (!$('#menu-pop').hidden) closeMenus();
      else if (!$('#lightbox').hidden) $('#lightbox').hidden = true;
      else if (!$('#findbar').hidden) closeFind();
      else if (document.body.classList.contains('focus')) toggleFocus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu-pop, #btn-more, #btn-copy, .heading-copy')) closeMenus();
    if (!e.target.closest('#help-pop, [data-help]')) $('#help-pop').hidden = true;
  });

  /* tooltips */
  let tipTimer;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    clearTimeout(tipTimer);
    const tip = $('#tooltip');
    if (!el) { tip.hidden = true; return; }
    tipTimer = setTimeout(() => {
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2))}px`;
      tip.style.top = `${r.bottom + 8}px`;
    }, 450);
  });
  document.addEventListener('mousedown', () => { clearTimeout(tipTimer); $('#tooltip').hidden = true; });

  /* drag & drop files and folders */
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#dropzone').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $('#dropzone').hidden = true;
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    let opened = 0;
    const images = paths.filter((p) => IMG_RE.test(p));
    if (images.length) { optimizeFiles(images); opened += images.length; }
    for (const p of paths.filter((x) => !IMG_RE.test(x))) {
      // eslint-disable-next-line no-await-in-loop
      const info = await api.pathInfo(p);
      if (info.dir || DOC_RE.test(p)) { api.open(p); opened++; }
    }
    if (!opened) toast('Tomelight opens folders, .md, .html and .txt files, and turns dropped images into WebP', 'quiet');
  });
}

function followLink(href, newWindow = false) {
  if (!href) return;
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1));
    const el = document.getElementById(id) || document.getElementById(slugify(id));
    if (el) scrollToHeading(el.id);
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) { api.openExternal(href); return; }
  const u = resolveUrl(href);
  if (!u || u.protocol !== 'file:') return;
  const p = decodeURIComponent(u.pathname);
  if (DOC_RE.test(p)) { if (newWindow) api.open(p, { newWindow: true }); else openTab(p); }
  else api.openPath(p);
}

function openLightbox(src) {
  const lb = $('#lightbox');
  lb.querySelector('img').src = src;
  lb.hidden = false;
}

function bindCommands() {
  api.onCommand((cmd, arg) => {
    const t = cur();
    switch (cmd) {
      case 'file:save': save(t, true); break;
      case 'file:save-all': saveAll(); break;
      case 'file:new': api.newFile(state.folder || t?.doc.dir); break;
      case 'file:reveal': if (t) api.reveal(t.file); break;
      case 'export:pdf': exportPdf(); break;
      case 'export:html': exportHtml(); break;
      case 'edit:undo': undoAction(false); break;
      case 'edit:redo': undoAction(true); break;
      case 'ui:find': openFind(); break;
      case 'ui:palette': if ($('#palette').hidden) openPalette(); else closePalette(); break;
      case 'ui:quick-open': if ($('#palette').hidden) openPalette('files'); else closePalette(); break;
      case 'ui:toggle-sidebar': toggleSidebar(); break;
      case 'ui:panel': if (arg === 'images') toggleStudio(); else showPanel(arg); break;
      case 'ui:focus': toggleFocus(); break;
      case 'ui:settings': openSettings(); break;
      case 'ui:shortcuts': openShortcuts(); break;
      case 'view:set-mode': setMode(arg); break;
      case 'view:toggle-edit': if (t) setMode(t.mode === 'read' || t.mode === 'reader' ? (t.kind === 'md' ? 'write' : 'split') : 'read'); break;
      case 'doc:tidy': tidyCurrent(); break;
      case 'view:zoom': zoom(arg); break;
      case 'doc:toggle-done': toggleSeal(); break;
      case 'doc:complete-all': completeAll(); break;
      case 'copy:as': copyAs(arg); break;
      case 'edit:paste-md': pasteAsMarkdown(); break;
      case 'edit:select-all': selectAllInPage(); break;
      case 'img:optimize': toggleStudio(); break;
      case 'note:add': addNote(); break;
      case 'note:toggle': toggleNotesVisible(); break;
      case 'tab:close': if (t) closeTab(t.id); else api.closeWindow(); break;
      case 'tab:cycle': cycleTab(arg); break;
      case 'tab:reopen': reopenClosed(); break;
      case 'tab:close-others': if (t) closeOthers(t.id); break;
      case 'tab:close-all': closeAll(); break;
      default: break;
    }
  });
}

window.__tomelightDebug = { optimizeFiles };
boot();
