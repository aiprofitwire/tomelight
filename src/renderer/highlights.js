/**
 * Highlights: pure helpers (no DOM). A highlight is stored as a text quote with a little
 * context on each side, so it finds its sentence again after the file is re-rendered or
 * rewritten by an AI. Nothing here ever touches the file on disk.
 */

/** The 4 colors, each with a meaning that carries into the AI feedback prompt. */
export const HL_COLORS = [
  { id: 'yellow', label: 'Important', heading: 'Pay attention to these' },
  { id: 'red', label: 'Fix this', heading: 'Fix these' },
  { id: 'cyan', label: 'Question', heading: 'Answer these questions' },
  { id: 'green', label: 'Keep', heading: 'Keep these as they are' },
];
export const HL_ORDER = ['red', 'cyan', 'yellow', 'green'];
export const hlColor = (id) => HL_COLORS.find((c) => c.id === (id === 'pink' ? 'red' : id)) || HL_COLORS[0];

const CTX = 32;

/** Build a stored anchor for text[start, end). */
export function quoteAnchor(text, start, end) {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CTX), start),
    suffix: text.slice(end, end + CTX),
    pos: text.length ? start / text.length : 0,
  };
}

const sharedTail = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
const sharedHead = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };

/**
 * Find the anchor in text again. Every occurrence of the quote is scored by how much of the
 * surrounding context still matches and how close it sits to where it was. Returns
 * { start, end } or null when the quoted words are gone.
 */
export function resolveAnchor(text, a) {
  if (!a || !a.exact) return null;
  let exact = a.exact;
  let hits = [];
  for (let i = text.indexOf(exact); i !== -1; i = text.indexOf(exact, i + 1)) hits.push(i);
  if (!hits.length) {
    // Whitespace can change when a file is reformatted; fall back to a whitespace-tolerant match.
    const pattern = a.exact.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    if (!pattern) return null;
    const re = new RegExp(pattern, 'g');
    let m;
    while ((m = re.exec(text))) { hits.push(m.index); exact = m[0]; if (hits.length > 200) break; }
    if (!hits.length) return null;
    // with a regex match the length can differ per hit; recompute below
    let best = null;
    for (const s of hits) {
      re.lastIndex = s; const mm = re.exec(text); if (!mm) continue;
      const e = s + mm[0].length;
      const score = sharedTail(text.slice(Math.max(0, s - CTX), s), a.prefix || '') + sharedHead(text.slice(e, e + CTX), a.suffix || '') - Math.abs(s / (text.length || 1) - (a.pos || 0)) * 20;
      if (!best || score > best.score) best = { start: s, end: e, score };
    }
    return best ? { start: best.start, end: best.end } : null;
  }
  let best = null;
  for (const s of hits) {
    const e = s + exact.length;
    const score = sharedTail(text.slice(Math.max(0, s - CTX), s), a.prefix || '') + sharedHead(text.slice(e, e + CTX), a.suffix || '') - Math.abs(s / (text.length || 1) - (a.pos || 0)) * 20;
    if (!best || score > best.score) best = { start: s, end: e, score };
  }
  return { start: best.start, end: best.end };
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Sort highlights the way they appear in the document. */
export const inDocOrder = (list) => list.slice().sort((a, b) => (a.pos || 0) - (b.pos || 0));

/**
 * Turn highlights into a message you can paste straight back into ChatGPT, Claude or Gemini.
 * Grouped by meaning: fixes first, then questions, then what matters, then what to keep.
 */
export function feedbackPrompt(fileName, list) {
  const items = inDocOrder(list).filter((h) => clean(h.exact));
  if (!items.length) return '';
  const out = [`Here's my feedback on "${fileName}". I highlighted these passages while reading it. Please revise the document with these notes in mind.`];
  let n = 0;
  for (const id of HL_ORDER) {
    const group = items.filter((h) => hlColor(h.color).id === id);
    if (!group.length) continue;
    out.push('', `${hlColor(id).heading}:`);
    for (const h of group) {
      n += 1;
      const note = clean(h.note);
      out.push(`${n}. "${clip(clean(h.exact), 400)}"${note ? `\n   My note: ${note}` : ''}`);
    }
  }
  return out.join('\n');
}

/** A Markdown summary of the highlights, for keeping or sharing. */
export function highlightsMarkdown(fileName, list) {
  const items = inDocOrder(list).filter((h) => clean(h.exact));
  if (!items.length) return '';
  const out = [`## Highlights from ${fileName}`, ''];
  for (const h of items) {
    const note = clean(h.note);
    out.push(`> ${clip(clean(h.exact), 600)}`, '', `${hlColor(h.color).label}${note ? `: ${note}` : ''}`, '');
  }
  return `${out.join('\n').trim()}\n`;
}
