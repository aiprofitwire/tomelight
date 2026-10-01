// Unit tests for the pure text and byte helpers. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toggleTaskAt, toggleCellAt, addCheckAt, setAllTasks, toggleDoneSeal,
  splitFrontMatter, tidyMarkdown, renderMarkdown,
} from '../src/renderer/markdown.js';
import { seoName, altFromName, scrubMetadata } from '../src/renderer/webp.js';

test('toggleTaskAt flips a list checkbox and keeps the rest of the line', () => {
  const src = '# Plan\n\n- [ ] Email the client\n- [x] Book the room\n';
  const a = toggleTaskAt(src, 2);
  assert.equal(a.checked, true);
  assert.equal(a.src.split('\n')[2], '- [x] Email the client');
  const b = toggleTaskAt(a.src, 3);
  assert.equal(b.checked, false);
  assert.equal(b.src.split('\n')[3], '- [ ] Book the room');
  assert.equal(toggleTaskAt(src, 0), null, 'headings are not tasks');
});

test('toggleTaskAt keeps Windows line endings', () => {
  const src = '- [ ] one\r\n- [ ] two\r\n';
  assert.equal(toggleTaskAt(src, 1).src, '- [ ] one\r\n- [x] two\r\n');
});

test('toggleCellAt flips the n-th checkbox inside a table row only', () => {
  const src = '| Channel | Draft | Live |\n|---|---|---|\n| LinkedIn | [x] | [ ] |\n';
  const r = toggleCellAt(src, 2, 1);
  assert.equal(r.checked, true);
  assert.equal(r.src.split('\n')[2], '| LinkedIn | [x] | [x] |');
  assert.equal(toggleCellAt(src, 2, 5), null);
});

test('toggleCellAt ignores Markdown links', () => {
  const src = '| [Docs](https://example.com) | [ ] |';
  assert.equal(toggleCellAt(src, 0, 0).src, '| [Docs](https://example.com) | [x] |');
});

test('addCheckAt turns a plain bullet into a task', () => {
  assert.equal(addCheckAt('- Buy milk', 0), '- [x] Buy milk');
  assert.equal(addCheckAt('- [ ] Already a task', 0), null);
});

test('setAllTasks completes everything outside code fences', () => {
  const src = '- [ ] a\n- [ ] b\n```\n- [ ] not me\n```\n| x | [ ] |';
  const out = setAllTasks(src, true);
  const text = typeof out === 'string' ? out : out.src;
  assert.match(text, /- \[x\] a/);
  assert.match(text, /- \[x\] b/);
  assert.match(text, /- \[ \] not me/);
});

test('toggleDoneSeal adds and removes the seal after front matter', () => {
  const src = '---\ntitle: X\n---\n\n# Doc\n';
  const on = toggleDoneSeal(src);
  assert.equal(on.sealed, true);
  assert.ok(on.src.startsWith('---\ntitle: X\n---\n'));
  assert.match(on.src, /\*\*DONE\*\*/);
  const off = toggleDoneSeal(on.src);
  assert.equal(off.sealed, false);
  assert.equal(off.src, src);
});

test('splitFrontMatter reads YAML and reports the body offset', () => {
  const r = splitFrontMatter('---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body');
  assert.equal(r.meta.title, 'Hello');
  assert.equal(r.body.trim(), '# Body');
  assert.ok(r.offset >= 4);
});

test('tidyMarkdown fixes common AI and paste damage', () => {
  const messy = '#Launch plan\n• one\n• two\n1) first\n- [] todo\n** bold **\n\n\n\nend   ';
  const { src, total } = tidyMarkdown(messy);
  assert.ok(total > 0);
  assert.match(src, /^# Launch plan$/m);
  assert.match(src, /^- one$/m);
  assert.match(src, /^1\. first$/m);
  assert.match(src, /^- \[ \] todo$/m);
  assert.match(src, /\*\*bold\*\*/);
  assert.doesNotMatch(src, /\n\n\n/);
  assert.ok(src.endsWith('end\n'));
});

test('tidyMarkdown leaves hashtags, code and clean files alone', () => {
  const clean = '# Title\n\n#launchday is a hashtag\n\n```\n#not a heading\n• keep\n```\n';
  const r = tidyMarkdown(clean);
  assert.equal(r.src, clean);
  assert.equal(r.changed, false);
});

test('tidyMarkdown is idempotent', () => {
  const once = tidyMarkdown('#A\n* b\n+ c\n\n\n\nd').src;
  assert.equal(tidyMarkdown(once).src, once);
});

test('renderMarkdown renders tasks as clickable boxes with line numbers', () => {
  const html = renderMarkdown('- [ ] one\n- [x] two').html;
  assert.match(html, /data-line="0"/);
  assert.match(html, /data-line="1"/);
});

test('seoName and altFromName make clean names', () => {
  assert.equal(seoName('IMG_2041 Dog Treats.PNG'), 'img-2041-dog-treats');
  assert.equal(altFromName('hero_banner-final.jpg'), 'hero banner final');
});

test('scrubMetadata strips EXIF from a JPEG and keeps the image data', () => {
  const seg = (marker, body) => { const len = body.length + 2; return [0xff, marker, len >> 8, len & 255, ...body]; };
  const exif = seg(0xe1, [...Buffer.from('Exif\0\0'), 1, 2, 3, 4]);
  const app0 = seg(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sos = [0xff, 0xda, 0, 2, 9, 9, 9, 0xff, 0xd9];
  const jpg = new Uint8Array([0xff, 0xd8, ...app0, ...exif, ...sos]);
  const out = scrubMetadata(jpg, 'image/jpeg');
  const s = Buffer.from(out).toString('latin1');
  assert.ok(!s.includes('Exif'), 'EXIF removed');
  assert.ok(s.includes('JFIF'), 'JFIF kept');
  assert.equal(out[out.length - 1], 0xd9);
});
