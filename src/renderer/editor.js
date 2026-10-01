/**
 * Source editor built on CodeMirror 6, themed to match Tomelight.
 */
import { EditorState, EditorSelection } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

const highlight = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-h cm-h1' },
  { tag: t.heading2, class: 'cm-h cm-h2' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], class: 'cm-h cm-h3' },
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-em' },
  { tag: t.strikethrough, class: 'cm-strike' },
  { tag: [t.link, t.url], class: 'cm-link' },
  { tag: t.monospace, class: 'cm-mono' },
  { tag: t.quote, class: 'cm-quote' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], class: 'cm-marker' },
  { tag: t.list, class: 'cm-list' },
  { tag: [t.keyword, t.tagName], class: 'cm-kw' },
  { tag: [t.string, t.attributeValue], class: 'cm-str' },
  { tag: [t.attributeName, t.propertyName], class: 'cm-attr' },
  { tag: t.comment, class: 'cm-comment' },
  { tag: [t.number, t.bool, t.atom], class: 'cm-num' },
  { tag: t.angleBracket, class: 'cm-marker' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontSize: 'calc(13.5px * var(--scale))',
    lineHeight: '1.75',
    padding: '28px 0 40vh',
  },
  '.cm-content': { caretColor: 'var(--accent)', maxWidth: '860px', padding: '0 28px 0 8px' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--faint)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 18px', minWidth: '44px' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--match)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--match)', outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-search input, .cm-search button': { fontFamily: 'var(--font-ui)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--faint)', cursor: 'pointer' },
  '.cm-placeholder': { color: 'var(--faint)', fontStyle: 'italic' },
});

export function createEditor(parent, { onChange, onScrollLine, onSave }) {
  let silent = false;
  const extensions = (lang) => [
    lineNumbers(),
    foldGutter({ openText: '▾', closedText: '▸' }),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    placeholder('Start writing… (the toolbar above formats for you)'),
    lang === 'html' ? html() : markdown({ base: markdownLanguage }),
    syntaxHighlighting(highlight),
    theme,
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { onSave && onSave(); return true; } },
      { key: 'Mod-b', run: wrap('**') },
      { key: 'Mod-i', run: wrap('*') },
      { key: 'Mod-Enter', run: toggleTaskLine },
      indentWithTab,
      ...defaultKeymap, ...historyKeymap, ...searchKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !silent && onChange) onChange(u.state.doc.toString());
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: extensions('markdown') }) });

  view.scrollDOM.addEventListener('scroll', () => {
    if (!onScrollLine) return;
    const top = view.scrollDOM.getBoundingClientRect().top + 30;
    const pos = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 20, y: top }, false);
    const line = view.state.doc.lineAt(pos).number - 1;
    onScrollLine(line);
  }, { passive: true });

  return {
    view,
    get value() { return view.state.doc.toString(); },
    /** Fresh editor state for a tab. */
    newState(doc, lang) { return EditorState.create({ doc, extensions: extensions(lang) }); },
    /** Swap in a tab's state (keeps its own undo history and cursor). */
    load(st, scrollTop = 0) {
      view.setState(st);
      requestAnimationFrame(() => { view.scrollDOM.scrollTop = scrollTop; });
    },
    get state() { return view.state; },
    get scrollTop() { return view.scrollDOM.scrollTop; },
    /** Replace the doc text (disk reload, checkbox click) with a minimal diff. */
    setValue(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let start = 0;
      while (start < cur.length && start < text.length && cur[start] === text[start]) start++;
      let endA = cur.length; let endB = text.length;
      while (endA > start && endB > start && cur[endA - 1] === text[endB - 1]) { endA--; endB--; }
      silent = true;
      view.dispatch({ changes: { from: start, to: endA, insert: text.slice(start, endB) } });
      silent = false;
    },
    focusLine(line) {
      const l = view.state.doc.line(Math.min(Math.max(1, line + 1), view.state.doc.lines));
      view.dispatch({ selection: { anchor: l.to }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
      view.focus();
    },
    focus() { view.focus(); },
    undo() { return undo(view); },
    selectAll() { selectAll(view); view.focus(); },
    redo() { return redo(view); },
    search() { openSearchPanel(view); },
  };
}

function wrap(mark) {
  return (view) => {
    const changes = view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: mark + text + mark },
        range: EditorSelection_range(range.from + mark.length, range.to + mark.length),
      };
    });
    view.dispatch(changes);
    return true;
  };
}
function EditorSelection_range(a, b) { return EditorSelection.range(a, b); }

function toggleTaskLine(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const text = line.text;
  let next;
  const task = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/.exec(text);
  if (task) next = text.replace(task[0], `${task[1]}[${task[2] === ' ' ? 'x' : ' '}]`);
  else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(text)) next = text.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)/, '$1[ ] ');
  else next = `- [ ] ${text}`;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
  return true;
}

/* ------------------------------------------------------------------ */
/* Formatting toolbar actions (so nobody has to know Markdown)          */
/* ------------------------------------------------------------------ */
const LISTISH = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;
const HEADING = /^(\s*)#{1,6}\s+/;
const QUOTE = /^(\s*)>\s?/;

function linePrefix(view, prefix, family) {
  const { state } = view;
  const lines = new Set();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
  }
  const nums = [...lines].sort((a, b) => a - b);
  // If every line already has exactly this prefix, toggle it off.
  const allHave = nums.every((n) => {
    const t = state.doc.line(n).text;
    const ind = /^\s*/.exec(t)[0];
    return t.slice(ind.length).startsWith(prefix);
  });
  const changes = nums.map((n) => {
    const line = state.doc.line(n);
    const t = line.text;
    const ind = /^\s*/.exec(t)[0];
    const m = family.exec(t);
    const bodyStart = m ? m[0].length : ind.length;
    const body = t.slice(bodyStart);
    const next = allHave ? ind + body : ind + prefix + body;
    return { from: line.from, to: line.to, insert: next };
  });
  view.dispatch({ changes, scrollIntoView: true });
  return true;
}

function insertBlock(view, block) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const before = line.text.trim() ? '\n\n' : '';
  const insert = `${before}${block}\n`;
  view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length }, scrollIntoView: true });
  return true;
}

function insertLink(view) {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to) || 'link text';
  const isUrl = /^https?:\/\//.test(text);
  const insert = isUrl ? `[link text](${text})` : `[${text}](https://)`;
  const urlStart = isUrl ? r.from + 1 : r.from + text.length + 3;
  const urlEnd = isUrl ? r.from + 10 : urlStart + 8;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.single(urlStart, urlEnd), scrollIntoView: true });
  return true;
}

export function format(view, kind) {
  switch (kind) {
    case 'bold': wrap('**')(view); break;
    case 'italic': wrap('*')(view); break;
    case 'strike': wrap('~~')(view); break;
    case 'code': wrap('`')(view); break;
    case 'h1': linePrefix(view, '# ', HEADING); break;
    case 'h2': linePrefix(view, '## ', HEADING); break;
    case 'h3': linePrefix(view, '### ', HEADING); break;
    case 'ul': linePrefix(view, '- ', LISTISH); break;
    case 'ol': linePrefix(view, '1. ', LISTISH); break;
    case 'task': linePrefix(view, '- [ ] ', LISTISH); break;
    case 'quote': linePrefix(view, '> ', QUOTE); break;
    case 'link': insertLink(view); break;
    case 'table': insertBlock(view, '| Column 1 | Column 2 | Column 3 |\n|---|---|---|\n|  |  |  |\n|  |  |  |'); break;
    case 'check-table': insertBlock(view, '| Done | Task | Due |\n|---|---|---|\n| [ ] |  |  |\n| [ ] |  |  |'); break;
    case 'hr': insertBlock(view, '---'); break;
    default: return;
  }
  view.focus();
}
