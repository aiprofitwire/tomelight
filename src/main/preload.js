'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

const COMMANDS = [
  'file:save', 'file:save-all', 'file:reveal', 'file:new', 'export:pdf', 'export:html', 'edit:undo', 'edit:redo',
  'ui:find', 'ui:palette', 'ui:quick-open', 'ui:toggle-sidebar', 'ui:panel', 'ui:focus', 'ui:settings', 'ui:shortcuts',
  'view:set-mode', 'view:toggle-edit', 'view:zoom', 'doc:toggle-done', 'doc:complete-all',
  'copy:as', 'edit:paste-md', 'edit:select-all', 'note:add', 'note:toggle', 'doc:tidy', 'img:optimize',
  'tab:close', 'tab:cycle', 'tab:reopen', 'tab:close-others', 'tab:close-all',
];

contextBridge.exposeInMainWorld('tomelight', {
  platform: process.platform,
  ready: () => ipcRenderer.send('renderer:ready'),
  // settings & session
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setSession: (s) => ipcRenderer.send('session:set', s),
  onSettings: on('settings:changed'),
  // files & folders
  readFile: (file) => ipcRenderer.invoke('file:read', file),
  writeFile: (file, content) => ipcRenderer.invoke('file:write', { file, content }),
  watchFiles: (files) => ipcRenderer.send('file:watch', files),
  watchFolder: (dir) => ipcRenderer.send('folder:watch', dir),
  pathInfo: (p) => ipcRenderer.invoke('path:info', p),
  listDir: (dir) => ipcRenderer.invoke('dir:list', dir),
  walkDir: (dir) => ipcRenderer.invoke('dir:walk', dir),
  open: (p, opts) => ipcRenderer.send('path:open', p, opts),
  openDialog: (opts) => ipcRenderer.send('dialog:open', opts),
  newFile: (dir) => ipcRenderer.send('file:new', dir),
  reveal: (file) => ipcRenderer.send('file:reveal', file),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  openPath: (p) => ipcRenderer.send('shell:open-path', p),
  pathForFile: (f) => webUtils.getPathForFile(f),
  clearRecent: () => ipcRenderer.send('recent:clear'),
  onOpenFile: on('file:open'),
  onOpenFolder: on('folder:open'),
  onChangedOnDisk: on('file:changed-on-disk'),
  onFolderChanged: on('folder:changed'),
  // window
  setTitle: (title, file) => ipcRenderer.send('win:set-title', { title, file }),
  setEdited: (v) => ipcRenderer.send('win:set-edited', v),
  closeOk: () => ipcRenderer.send('win:close-ok'),
  closeWindow: () => ipcRenderer.send('win:close'),
  onBeforeClose: on('app:before-close'),
  // find
  find: (text, opts = {}) => ipcRenderer.send('find:start', { text, ...opts }),
  stopFind: () => ipcRenderer.send('find:stop'),
  onFoundInPage: on('found-in-page'),
  // export
  exportPdf: (opts) => ipcRenderer.invoke('export:pdf', opts),
  exportHtml: (opts) => ipcRenderer.invoke('export:html', opts),
  imgRead: (file) => ipcRenderer.invoke('img:read', file),
  imgWrite: (source, bytes, opts = {}) => ipcRenderer.invoke('img:write', { source, bytes, ...opts }),
  imgPick: () => ipcRenderer.invoke('img:pick'),
  notesGet: (file) => ipcRenderer.invoke('notes:get', file),
  notesSet: (file, notes) => ipcRenderer.invoke('notes:set', { file, notes }),
  notesCount: () => ipcRenderer.invoke('notes:count'),
  notesClearAll: () => ipcRenderer.invoke('notes:clear-all'),
  pageUrl: (file) => ipcRenderer.invoke('page:url', file),
  pagePreview: (file, html) => ipcRenderer.invoke('page:preview', { file, html }),
  saveZip: (bytes) => ipcRenderer.invoke('img:save-zip', bytes),
  assetText: (rel) => ipcRenderer.invoke('app:asset-text', rel),
  // menu commands
  onCommand: (cb) => {
    COMMANDS.forEach((c) => ipcRenderer.on(c, (_e, ...args) => cb(c, ...args)));
  },
});
