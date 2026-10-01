/**
 * Write mode: a Google-Docs-style editor that reads and writes Markdown.
 * TipTap (ProseMirror) + tiptap-markdown. What you see is formatted; what's saved is clean Markdown.
 */
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { HardBreak } from '@tiptap/extension-hard-break';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from 'tiptap-markdown';

/* Single Enter inside a paragraph stays a plain line break in the file (no trailing backslashes). */
const SoftBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state, node, parent, index) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) { state.write(state.inTable ? '<br>' : '\n'); return; }
          }
        },
        parse: {},
      },
    };
  },
});

export function createWriter(host, { onChange, resolveSrc = (s) => s, onLinkClick } = {}) {
  // Images keep their relative path in the file, but display from the document's folder.
  const LocalImage = Image.extend({
    addNodeView() {
      return ({ node }) => {
        const img = document.createElement('img');
        const apply = (n) => { img.src = resolveSrc(n.attrs.src || ''); img.alt = n.attrs.alt || ''; if (n.attrs.title) img.title = n.attrs.title; };
        apply(node);
        return { dom: img, update: (n) => { if (n.type.name !== 'image') return false; apply(n); return true; } };
      };
    },
  });

  let silent = false;
  const editor = new Editor({
    element: host,
    extensions: [
      StarterKit.configure({
        hardBreak: false,
        // Only real web addresses become links (so "notes.md" or "file.io" in your text stays plain text).
        link: { openOnClick: false, autolink: true, linkOnPaste: true, shouldAutoLink: (url) => /^https?:\/\//i.test(url) },
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      SoftBreak,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow, TableHeader, TableCell,
      LocalImage.configure({ inline: false }),
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : 'Start writing… type # for a heading, - for a list, [ ] for a checkbox'), showOnlyWhenEditable: true }),
      Markdown.configure({ html: true, tightLists: true, bulletListMarker: '-', linkify: false, breaks: true, transformPastedText: true, transformCopiedText: true }),
    ],
    editorProps: {
      attributes: { class: 'tome write-doc', spellcheck: 'true' },
      handleClickOn: (view, pos, node, nodePos, event) => {
        const a = event.target.closest && event.target.closest('a[href]');
        if (a && (event.metaKey || event.ctrlKey) && onLinkClick) { onLinkClick(a.getAttribute('href')); return true; }
        return false;
      },
    },
    onUpdate: () => { if (!silent && onChange) onChange(); },
  });

  /* Keep saved Markdown as close as possible to how people (and AI) write it by hand. */
  const tidyOut = (text) => {
    let out = text
      .replace(/\\([\[\]])/g, '$1')                       // \[ \] -> [ ]  (checkboxes, callouts)
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')             // <https://x> -> https://x
      .replace(/^\s+/, '')
      .replace(/^\|(?: :?-{3,}:? \|)+$/gm, (row) => row.replace(/ (:?-{3,}:?) /g, '$1')); // | --- | -> |---|
    let prev;
    do { // tight checklists: no blank lines between consecutive checkbox items
      prev = out;
      out = out.replace(/^(\s*[-*+] \[[ xX]\] .*)\n\n(?=\s*[-*+] \[[ xX]\] )/gm, '$1\n');
    } while (out !== prev);
    return out;
  };
  const md = () => tidyOut(editor.storage.markdown.getMarkdown());

  return {
    editor,
    /** Replace the document (no undo history carried over, no change event). */
    load(markdown) {
      silent = true;
      editor.commands.setContent(markdown || '', { emitUpdate: false });
      silent = false;
    },
    getMarkdown: md,
    focus: () => editor.commands.focus(),
    hasFocus: () => editor.isFocused,
    undo: () => editor.commands.undo(),
    redo: () => editor.commands.redo(),
    selectAll: () => editor.commands.selectAll(),
    insertMarkdown: (text) => editor.chain().focus().insertContent(text).run(),
    isActive: (name, attrs) => editor.isActive(name, attrs),
    cmd(kind, arg) {
      const c = editor.chain().focus();
      switch (kind) {
        case 'bold': c.toggleBold().run(); break;
        case 'italic': c.toggleItalic().run(); break;
        case 'strike': c.toggleStrike().run(); break;
        case 'code': c.toggleCode().run(); break;
        case 'h1': c.toggleHeading({ level: 1 }).run(); break;
        case 'h2': c.toggleHeading({ level: 2 }).run(); break;
        case 'h3': c.toggleHeading({ level: 3 }).run(); break;
        case 'ul': c.toggleBulletList().run(); break;
        case 'ol': c.toggleOrderedList().run(); break;
        case 'task': c.toggleTaskList().run(); break;
        case 'quote': c.toggleBlockquote().run(); break;
        case 'hr': c.setHorizontalRule().run(); break;
        case 'table': c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
        case 'check-table': c.insertContent('<table><tr><th>Done</th><th>Task</th><th>Due</th></tr><tr><td>[ ]</td><td></td><td></td></tr><tr><td>[ ]</td><td></td><td></td></tr></table>').run(); break;
        case 'link':
          if (!arg) c.unsetLink().run();
          else if (editor.state.selection.empty && !editor.isActive('link')) c.insertContent(`<a href="${arg.replace(/"/g, '&quot;')}">${arg}</a>`).run();
          else c.extendMarkRange('link').setLink({ href: arg }).run();
          break;
        case 'clear': c.unsetAllMarks().clearNodes().run(); break;
        default: break;
      }
    },
    destroy: () => editor.destroy(),
  };
}
