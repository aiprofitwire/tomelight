/**
 * Markdown engine: markdown-it + task lists that map back to source lines,
 * GitHub-style callouts, the DONE seal, mermaid fences, highlighted code.
 */
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import anchor from 'markdown-it-anchor';
import hljs from 'highlight.js/lib/common';
import * as yaml from 'js-yaml';

export const slugify = (s) => String(s).trim().toLowerCase()
  .replace(/<[^>]+>/g, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-');

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Regexes that operate on raw source lines (shared with the editor side). */
export const TASK_RE = /^(\s*(?:>\s*)*\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?=\s|$)/;
export const LIST_RE = /^(\s*(?:>\s*)*\s*(?:[-*+]|\d+[.)])\s+)(?!\[[ xX]\](?:\s|$))/;
export const DONE_RE = /^>\s*✅\s*\*\*DONE\*\*.*$/;

/** Split YAML front matter from the body, keeping the line offset. */
export function splitFrontMatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(src);
  if (!m) return { meta: null, body: src, offset: 0, raw: null };
  let meta = null;
  try { meta = yaml.load(m[1]); } catch { meta = null; }
  if (meta && typeof meta !== 'object') meta = null;
  const offset = m[0].split('\n').length - 1;
  return { meta, body: src.slice(m[0].length), offset, raw: m[1] };
}

function createMd({ breaks = false } = {}) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    breaks,
    highlight: (code, lang) => {
      const l = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      if (l && hljs.getLanguage(l)) {
        try { return hljs.highlight(code, { language: l, ignoreIllegals: true }).value; } catch {}
      }
      return escapeHtml(code);
    },
  });
  md.use(footnote);
  md.use(anchor, { slugify, tabIndex: false });

  /* ---- source line annotations (for scroll sync and dbl-click-to-edit) ---- */
  const BLOCKS = new Set(['paragraph_open', 'heading_open', 'blockquote_open', 'table_open', 'bullet_list_open', 'ordered_list_open', 'hr']);
  md.core.ruler.push('source_lines', (state) => {
    const off = state.env.lineOffset || 0;
    for (const t of state.tokens) {
      if (t.map && BLOCKS.has(t.type) && t.level === 0) t.attrSet('data-line', String(t.map[0] + off));
    }
  });

  /* ---- task lists + plain list items ---- */
  md.core.ruler.after('inline', 'tomelight_tasks', (state) => {
    const off = state.env.lineOffset || 0;
    const tokens = state.tokens;
    const stats = state.env.tasks || (state.env.tasks = { total: 0, done: 0 });
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'list_item_open') continue;
      const line = t.map ? t.map[0] + off : -1;
      t.attrSet('data-item-line', String(line));
      const inline = tokens[i + 2];
      const para = tokens[i + 1];
      if (!inline || inline.type !== 'inline' || !para || para.type !== 'paragraph_open') {
        t.attrJoin('class', 'plain-item');
        continue;
      }
      const m = /^\[([ xX])\](?:\s+|$)/.exec(inline.content);
      if (!m) { t.attrJoin('class', 'plain-item'); continue; }
      const checked = m[1] !== ' ';
      stats.total += 1; if (checked) stats.done += 1;
      t.attrJoin('class', `task-item${checked ? ' is-done' : ''}`);
      // strip the marker from the first text child
      inline.content = inline.content.slice(m[0].length);
      const first = inline.children && inline.children[0];
      if (first && first.type === 'text') first.content = first.content.replace(/^\[([ xX])\]\s*/, '');
      const box = new state.Token('html_inline', '', 0);
      box.content = `<span class="task-box${checked ? ' checked' : ''}" role="checkbox" tabindex="0" aria-checked="${checked}" data-line="${line}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span>`;
      inline.children.unshift(box);
      // mark parent list so bullets hide
      for (let j = i - 1; j >= 0; j--) {
        if ((tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') && tokens[j].level === t.level - 1) {
          tokens[j].attrJoin('class', 'has-tasks');
          break;
        }
      }
    }
  });

  /* ---- checkboxes inside table cells:  | [ ] | Mon | ... | ---- */
  md.core.ruler.after('tomelight_tasks', 'tomelight_table_boxes', (state) => {
    const off = state.env.lineOffset || 0;
    const stats = state.env.tasks;
    let tr = null; let rowLine = -1; let idx = 0; let rowAll = 0; let rowDone = 0;
    for (const t of state.tokens) {
      if (t.type === 'tr_open') { tr = t; rowLine = t.map ? t.map[0] + off : -1; idx = 0; rowAll = 0; rowDone = 0; continue; }
      if (t.type === 'tr_close') {
        if (tr && rowAll && rowDone === rowAll) tr.attrJoin('class', 'row-done');
        tr = null; continue;
      }
      if (!tr || t.type !== 'inline' || rowLine < 0 || !t.children) continue;
      const out = [];
      for (const child of t.children) {
        if (child.type !== 'text' || !/\[( |x|X)?\]/.test(child.content)) { out.push(child); continue; }
        const parts = child.content.split(/(\[(?: |x|X)?\])/);
        for (const part of parts) {
          if (!part) continue;
          const m = /^\[( |x|X)?\]$/.exec(part);
          if (!m) { const tx = new state.Token('text', '', 0); tx.content = part; out.push(tx); continue; }
          const checked = !!m[1] && m[1] !== ' ';
          stats.total += 1; if (checked) stats.done += 1;
          rowAll += 1; if (checked) rowDone += 1;
          const box = new state.Token('html_inline', '', 0);
          box.content = `<span class="task-box cell-box${checked ? ' checked' : ''}" role="checkbox" tabindex="0" aria-checked="${checked}" data-line="${rowLine}" data-cell="${idx}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></span>`;
          out.push(box);
          idx += 1;
        }
      }
      t.children = out;
    }
  });

  /* ---- callouts: > [!NOTE] ... and the DONE seal ---- */
  md.core.ruler.after('tomelight_table_boxes', 'tomelight_callouts', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue;
      const inline = tokens[i + 2];
      if (!inline || inline.type !== 'inline') continue;
      const c = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO|SUCCESS|DANGER|QUESTION|TODO)\][+-]?[ \t]*([^\n]*)\n?/i.exec(inline.content);
      if (c) {
        const kind = c[1].toLowerCase();
        const title = c[2] || c[1][0] + c[1].slice(1).toLowerCase();
        tokens[i].attrJoin('class', `callout callout-${kind}`);
        const head = new state.Token('html_inline', '', 0);
        head.content = `<span class="callout-title"><span class="callout-icon" data-kind="${kind}"></span>${escapeHtml(title)}</span>`;
        // drop the marker line from inline children
        const kids = inline.children;
        let k = 0;
        while (k < kids.length && kids[k].type !== 'softbreak' && kids[k].type !== 'hardbreak') k++;
        inline.children = [head, ...kids.slice(k + 1)];
        continue;
      }
      if (/^✅\s*\*\*DONE\*\*/.test(inline.content) || /^✅\s*DONE/.test(inline.content)) {
        tokens[i].attrJoin('class', 'done-seal');
        state.env.sealed = true;
      }
    }
  });

  /* ---- fences: mermaid + code chrome ---- */
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const lang = (t.info || '').trim().split(/\s+/)[0].toLowerCase();
    const line = t.map ? t.map[0] + (env.lineOffset || 0) : '';
    if (lang === 'mermaid') {
      env.hasMermaid = true;
      return `<div class="mermaid-block" data-line="${line}"><div class="mermaid-src" hidden>${escapeHtml(t.content)}</div><div class="mermaid-out"></div></div>`;
    }
    const inner = defaultFence(tokens, idx, options, env, self);
    const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
    return `<div class="code-block" data-line="${line}"><div class="code-head">${label}<button class="code-copy" type="button" title="Copy code">Copy</button></div>${inner}</div>`;
  };

  /* ---- tables get a scroll wrapper ---- */
  md.renderer.rules.table_open = (tokens, idx, options, env, self) => `<div class="table-wrap">${self.renderToken(tokens, idx, options)}`;
  md.renderer.rules.table_close = (tokens, idx, options, env, self) => `${self.renderToken(tokens, idx, options)}</div>`;

  /* ---- hr as an ornament ---- */
  md.renderer.rules.hr = (tokens, idx) => {
    const l = tokens[idx].attrGet('data-line');
    return `<div class="ornament" role="separator"${l ? ` data-line="${l}"` : ''}><span>✦</span></div>`;
  };
  return md;
}

const engines = { md: createMd(), mdBreaks: createMd({ breaks: true }), txt: createMd({ breaks: true }) };

/**
 * Render a markdown source string.
 * Returns { html, meta, tasks, headings, sealed, hasMermaid, words }.
 */
export function renderMarkdown(src, { plain = false, breaks = renderMarkdown.breaks } = {}) {
  const { meta, body, offset } = splitFrontMatter(src);
  const env = { lineOffset: offset, tasks: { total: 0, done: 0 } };
  const md = plain ? engines.txt : breaks ? engines.mdBreaks : engines.md;
  const tokens = md.parse(body, env);
  const headings = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      const level = Number(t.tag.slice(1));
      const text = tokens[i + 1].children.filter((c) => c.type === 'text' || c.type === 'code_inline' || c.type === 'emoji').map((c) => c.content).join('');
      headings.push({ level, text, id: t.attrGet('id'), line: (t.map ? t.map[0] : 0) + offset });
    }
  }
  const html = md.renderer.render(tokens, md.options, env);
  const words = (body.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}’']+/gu) || []).length;
  return { html, meta, tasks: env.tasks, headings, sealed: !!env.sealed, hasMermaid: !!env.hasMermaid, words, offset };
}

/* ------------------------------------------------------------------ */
/* Source edits (pure functions over the raw text)                      */
/* ------------------------------------------------------------------ */
const EOL = (src) => (src.includes('\r\n') ? '\r\n' : '\n');

export function toggleTaskAt(src, line) {
  const eol = EOL(src);
  const lines = src.split(/\r?\n/);
  const l = lines[line];
  if (l == null) return null;
  const m = TASK_RE.exec(l);
  if (!m) return null;
  const next = m[2] === ' ' ? 'x' : ' ';
  lines[line] = l.replace(TASK_RE, `$1[${next}]`);
  return { src: lines.join(eol), checked: next === 'x' };
}

/** Toggle the n-th [ ] / [] / [x] on a table row line. */
const CELL_RE = /\[( |x|X)?\](?!\()/g;
export function toggleCellAt(src, line, n) {
  const eol = EOL(src);
  const lines = src.split(/\r?\n/);
  const l = lines[line];
  if (l == null) return null;
  let i = -1; let checked = false;
  lines[line] = l.replace(CELL_RE, (m, c) => {
    i += 1;
    if (i !== n) return m;
    checked = !c || c === ' ';
    return checked ? '[x]' : '[ ]';
  });
  if (i < n) return null;
  return { src: lines.join(eol), checked };
}

export function addCheckAt(src, line, checked = true) {
  const eol = EOL(src);
  const lines = src.split(/\r?\n/);
  const l = lines[line];
  if (l == null || !LIST_RE.test(l) || TASK_RE.test(l)) return null;
  lines[line] = l.replace(LIST_RE, `$1[${checked ? 'x' : ' '}] `);
  return lines.join(eol);
}

export function setAllTasks(src, checked) {
  const eol = EOL(src);
  const lines = src.split(/\r?\n/);
  let inFence = false;
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    if (/^\s*\|/.test(lines[i])) {
      lines[i] = lines[i].replace(CELL_RE, (mm, c) => {
        const isOn = !!c && c !== ' ';
        if (isOn === checked) return mm;
        changed++;
        return checked ? '[x]' : '[ ]';
      });
      continue;
    }
    const m = TASK_RE.exec(lines[i]);
    if (m && (m[2] === ' ') === checked) {
      lines[i] = lines[i].replace(TASK_RE, `$1[${checked ? 'x' : ' '}]`);
      changed++;
    }
  }
  return { src: lines.join(eol), changed };
}

const fmtDate = () => new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Toggle the "✅ DONE" seal right below the front matter / at the top. */
export function toggleDoneSeal(src) {
  const eol = EOL(src);
  const { offset } = splitFrontMatter(src);
  const lines = src.split(/\r?\n/);
  // look for an existing seal in the first few content lines
  for (let i = offset; i < Math.min(lines.length, offset + 6); i++) {
    if (DONE_RE.test(lines[i])) {
      lines.splice(i, 1);
      if (lines[i] !== undefined && lines[i].trim() === '') lines.splice(i, 1);
      return { src: lines.join(eol), sealed: false };
    }
  }
  lines.splice(offset, 0, `> ✅ **DONE** · ${fmtDate()}`, '');
  return { src: lines.join(eol), sealed: true };
}

/* ------------------------------------------------------------------ */
/* Tidy: conservative auto-fix for messy Markdown (AI output, pastes)   */
/* Never touches code blocks or front matter.                            */
/* ------------------------------------------------------------------ */
export function tidyMarkdown(src) {
  const fixes = { blank: 0, spaces: 0, headings: 0, bullets: 0, tasks: 0, bold: 0, invisible: 0, numbers: 0 };
  let text = src.replace(/\r\n?/g, '\n');
  const inv = text.match(/[​-‍﻿]/g);
  if (inv) { fixes.invisible += inv.length; text = text.replace(/[​-‍﻿]/g, ''); }
  const nb = text.match(/ /g);
  if (nb) { fixes.invisible += nb.length; text = text.replace(/ /g, ' '); }
  const { offset } = splitFrontMatter(text);
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  let fenceMark = '';
  const isBlank = (l) => l == null || !l.trim();
  const isHeading = (l) => /^#{1,6}\s/.test(l);
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (i < offset) { out.push(l); continue; }
    const fence = /^\s*(```+|~~~+)/.exec(l);
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[1][0]; if (out.length && !isBlank(out[out.length - 1]) && !/^\s*[-*+]|^\s*\d+[.)]/.test(out[out.length - 1])) { out.push(''); fixes.blank++; } }
      else if (fence[1][0] === fenceMark) inFence = false;
      out.push(l.replace(/[ \t]+$/, ''));
      continue;
    }
    if (inFence) { out.push(l); continue; }
    // trailing spaces
    const trimmed = l.replace(/[ \t]+$/, '');
    if (trimmed !== l) { fixes.spaces++; l = trimmed; }
    // "#Heading" -> "# Heading" (only one # group and an uppercase/number start, so hashtags are left alone)
    const hm = /^(#{1,6})([A-Z0-9][^#]*\s[^#]*)$/.exec(l);
    if (hm) { l = `${hm[1]} ${hm[2]}`; fixes.headings++; }
    // pasted bullets: • ◦ ▪ ‣ – — * + -> "- "
    const bm = /^(\s*)(?:[•◦▪‣●○■]|[–—](?=\s))\s*(\S.*)$/.exec(l);
    if (bm) { l = `${bm[1]}- ${bm[2]}`; fixes.bullets++; }
    const sm = /^(\s*)[*+](\s+)(?!\*)(\S.*)$/.exec(l);
    if (sm && !/^\s*\*\s*\*\s*\*\s*$/.test(l)) { l = `${sm[1]}-${sm[2]}${sm[3]}`; fixes.bullets++; }
    // "1)" -> "1."
    const nm = /^(\s*)(\d+)\)(\s+\S.*)$/.exec(l);
    if (nm) { l = `${nm[1]}${nm[2]}.${nm[3]}`; fixes.numbers++; }
    // "- []" -> "- [ ]"
    const tm = /^(\s*(?:[-*+]|\d+[.)])\s+)\[\](\s|$)/.exec(l);
    if (tm) { l = l.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[\]/, '$1[ ]'); fixes.tasks++; }
    // "** bold **" -> "**bold**"
    const before = l;
    l = l.replace(/(^|[^*])\*\*[ \t]+([^*\n]*?\S)[ \t]*\*\*(?!\*)/g, '$1**$2**').replace(/(^|[^*])\*\*([^*\n]*?\S)[ \t]+\*\*(?!\*)/g, '$1**$2**');
    if (l !== before) fixes.bold++;
    // blank line before headings
    if (isHeading(l) && out.length && !isBlank(out[out.length - 1]) && i > offset) { out.push(''); fixes.blank++; }
    // blank line after headings
    if (out.length && isHeading(out[out.length - 1]) && !isBlank(l)) { out.push(''); fixes.blank++; }
    // collapse runs of blank lines
    if (isBlank(l) && out.length && isBlank(out[out.length - 1])) { fixes.blank++; continue; }
    out.push(l);
  }
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  const result = `${out.join('\n')}\n`;
  const total = Object.values(fixes).reduce((a, b) => a + b, 0);
  return { src: result, fixes, total, changed: result !== src };
}

export function describeFixes(f) {
  const parts = [];
  if (f.blank) parts.push(`${f.blank} spacing`);
  if (f.spaces) parts.push(`${f.spaces} trailing space${f.spaces > 1 ? 's' : ''}`);
  if (f.bullets) parts.push(`${f.bullets} bullet${f.bullets > 1 ? 's' : ''}`);
  if (f.headings) parts.push(`${f.headings} heading${f.headings > 1 ? 's' : ''}`);
  if (f.numbers) parts.push(`${f.numbers} numbered item${f.numbers > 1 ? 's' : ''}`);
  if (f.tasks) parts.push(`${f.tasks} checkbox${f.tasks > 1 ? 'es' : ''}`);
  if (f.bold) parts.push(`${f.bold} bold`);
  if (f.invisible) parts.push(`${f.invisible} hidden character${f.invisible > 1 ? 's' : ''}`);
  return parts.join(', ');
}
