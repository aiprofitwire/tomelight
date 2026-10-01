/**
 * "Copy for…" helpers: turn rendered tome content into
 *  - rich text for email (semantic HTML, zero styling, so it adopts the destination's font)
 *  - clean HTML for websites (WordPress, Shopify, Wix, Beehiiv)
 *  - plain text for social (LinkedIn, X, Facebook)
 * plus the reverse: messy web / Google Docs HTML into clean Markdown.
 */
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const KEEP_ATTR = { a: ['href'], img: ['src', 'alt'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], ol: ['start'] };

/** Build a clean, style-free copy of a DOM fragment. */
export function cleanFragment(fragment) {
  const root = document.createElement('div');
  root.appendChild(fragment);
  // app chrome & things that don't travel
  root.querySelectorAll('.sticky, .ghost-check, .code-head, .mermaid-block, .meta-card, .footnote-backref, script, style, button, svg:not(.task-box svg)').forEach((n) => n.remove());
  // checkboxes become characters
  root.querySelectorAll('.task-box').forEach((b) => b.replaceWith(document.createTextNode(b.classList.contains('checked') ? '☑ ' : '☐ ')));
  // done seal: keep its words only
  root.querySelectorAll('.wax').forEach((n) => n.remove());
  // callout titles: make them bold paragraphs
  root.querySelectorAll('.callout-title').forEach((t) => { const b = document.createElement('strong'); b.textContent = t.textContent.trim(); t.replaceWith(b, document.createElement('br')); });
  // unwrap presentational wrappers
  root.querySelectorAll('.table-wrap, .code-block').forEach((w) => w.replaceWith(...w.childNodes));
  // ornaments -> hr
  root.querySelectorAll('.ornament').forEach((o) => o.replaceWith(document.createElement('hr')));
  // strip every attribute except the meaningful ones
  root.querySelectorAll('*').forEach((el) => {
    const keep = KEEP_ATTR[el.tagName.toLowerCase()] || [];
    [...el.attributes].forEach((a) => { if (!keep.includes(a.name)) el.removeAttribute(a.name); });
  });
  // syntax-highlight spans inside code are just noise
  root.querySelectorAll('pre span, code span').forEach((s) => s.replaceWith(...s.childNodes));
  return root;
}

/** Pretty-ish HTML source for pasting into a website editor. */
export function toHtml(root) {
  const BLOCK = /^(p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|hr|div)$/i;
  let html = root.innerHTML
    .replace(/\n{2,}/g, '\n')
    .replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (m, slash, tag) => (BLOCK.test(tag) && tag.toLowerCase() !== 'li' && !slash ? `\n${m}` : m))
    .replace(/<\/(p|h[1-6]|ul|ol|blockquote|pre|table|li|tr)>/gi, '</$1>\n');
  html = html.split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n');
  return html.trim();
}

/** Plain text for social platforms: no markdown symbols, real bullets, blank line between paragraphs. */
export function toPlain(root) {
  const out = [];
  const inline = (el) => {
    let s = '';
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) s += n.data;
      else if (n.nodeName === 'BR') s += '\n';
      else if (n.nodeName === 'A') {
        const text = n.textContent.trim();
        const href = n.getAttribute('href') || '';
        s += href && /^https?:/.test(href) && text !== href && !text.startsWith('http') ? `${text} (${href})` : text;
      } else if (n.nodeName === 'IMG') s += '';
      else if (!/^(UL|OL|TABLE|PRE|BLOCKQUOTE)$/.test(n.nodeName)) s += inline(n);
    });
    return s.replace(/[ \t]+/g, ' ');
  };
  const block = (el, depth = 0) => {
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) { if (n.data.trim()) out.push(n.data.trim()); return; }
      const tag = n.nodeName;
      if (/^H[1-6]$/.test(tag) || tag === 'P') out.push(inline(n).trim());
      else if (tag === 'UL' || tag === 'OL') {
        const items = [];
        let i = Number(n.getAttribute('start') || 1);
        [...n.children].forEach((li) => {
          let text = inline(li).trim();
          const boxed = /^[☑☐]/.test(text);
          const bullet = boxed ? '' : tag === 'OL' ? `${i++}. ` : '• ';
          if (boxed) text = text.replace(/^☑/, '✅').replace(/^☐/, '⬜');
          items.push(`${'   '.repeat(depth)}${bullet}${text}`);
          li.querySelectorAll(':scope > ul, :scope > ol').forEach((sub) => {
            const before = out.length;
            block({ childNodes: [sub] }, depth + 1);
            items.push(...out.splice(before).join('\n').split('\n'));
          });
        });
        out.push(items.join('\n'));
      } else if (tag === 'BLOCKQUOTE') { const before = out.length; block(n, depth); out.push(out.splice(before).join('\n\n')); }
      else if (tag === 'PRE') out.push(n.textContent.replace(/\n$/, ''));
      else if (tag === 'TABLE') out.push([...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => inline(c).trim()).join(' | ')).join('\n'));
      else if (tag === 'HR') out.push('· · ·');
      else if (tag === 'DIV' || tag === 'SECTION') block(n, depth);
      else { const t = inline(n).trim(); if (t) out.push(t); }
    });
  };
  block(root);
  return out.filter((s) => s && s.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Character counts the way the platforms count them. */
export function socialCounts(text) {
  const chars = [...text].length;
  // X counts every link as 23 characters.
  const urls = text.match(/https?:\/\/[^\s)]+/g) || [];
  const x = urls.reduce((n, u) => n - [...u].length + 23, chars);
  return { chars, x, linkedin: chars };
}

/* ------------------------------------------------------------------ */
/* Paste as Markdown                                                    */
/* ------------------------------------------------------------------ */
let td = null;
export function htmlToMarkdown(html) {
  if (!td) {
    td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**', hr: '---' });
    td.use(gfm);
    td.addRule('tightListItem', {
      filter: 'li',
      replacement: (content, node, options) => {
        content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n  ');
        let prefix = `${options.bulletListMarker} `;
        const parent = node.parentNode;
        if (parent.nodeName === 'OL') {
          const start = parent.getAttribute('start');
          const index = Array.prototype.indexOf.call(parent.children, node);
          prefix = `${start ? Number(start) + index : index + 1}. `;
        }
        return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
      },
    });
    td.remove(['style', 'script', 'meta', 'title', 'head', 'noscript']);
    // Google Docs wraps everything in <b style="font-weight:normal">; unwrap it
    td.addRule('gdocsWrapper', {
      filter: (node) => node.nodeName === 'B' && /font-weight:\s*normal/.test(node.getAttribute('style') || ''),
      replacement: (content) => content,
    });
    // spans styled bold/italic (Google Docs, Word)
    td.addRule('styledSpans', {
      filter: (node) => node.nodeName === 'SPAN' && /font-weight:\s*(700|bold)|font-style:\s*italic/.test(node.getAttribute('style') || ''),
      replacement: (content, node) => {
        if (!content.trim()) return content;
        const st = node.getAttribute('style') || '';
        let c = content;
        if (/font-style:\s*italic/.test(st)) c = `*${c}*`;
        if (/font-weight:\s*(700|bold)/.test(st)) c = `**${c}**`;
        return c;
      },
    });
  }
  return td.turndown(html)
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
