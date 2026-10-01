// Highlights: anchoring and the AI feedback prompt. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteAnchor, resolveAnchor, feedbackPrompt, highlightsMarkdown } from '../src/renderer/highlights.js';

const doc = 'Launch on Friday. Budget is $750. Launch on Friday again if the test works. Ship the demo.';

test('an anchor finds its own text again', () => {
  const s = doc.indexOf('Budget is $750');
  const a = quoteAnchor(doc, s, s + 'Budget is $750'.length);
  assert.deepEqual(resolveAnchor(doc, a), { start: s, end: s + 14 });
});

test('context picks the right copy when the same words appear twice', () => {
  const second = doc.lastIndexOf('Launch on Friday');
  const a = quoteAnchor(doc, second, second + 16);
  assert.equal(resolveAnchor(doc, a).start, second);
  const first = doc.indexOf('Launch on Friday');
  assert.equal(resolveAnchor(doc, quoteAnchor(doc, first, first + 16)).start, first);
});

test('an anchor survives text added before it (an AI rewrite)', () => {
  const s = doc.indexOf('Ship the demo');
  const a = quoteAnchor(doc, s, s + 13);
  const edited = `New intro paragraph from the AI. ${doc}`;
  const r = resolveAnchor(edited, a);
  assert.equal(edited.slice(r.start, r.end), 'Ship the demo');
});

test('whitespace changes still resolve', () => {
  const a = quoteAnchor('Budget is $750 today', 0, 14);
  const r = resolveAnchor('Budget  is\n$750 today', a);
  assert.equal(r.start, 0);
  assert.equal(r.end, 15);
});

test('a deleted quote returns null instead of guessing', () => {
  const a = quoteAnchor(doc, 0, 6);
  assert.equal(resolveAnchor('Completely different text', a), null);
});

test('feedbackPrompt groups by meaning, fixes first, with notes', () => {
  const list = [
    { color: 'green', exact: 'Ship the demo', pos: 0.9 },
    { color: 'pink', exact: 'Budget is $750', note: 'Should be $900', pos: 0.2 },
    { color: 'cyan', exact: 'if the test works', pos: 0.7 },
  ];
  const p = feedbackPrompt('plan.md', list);
  assert.match(p, /^Here's my feedback on "plan\.md"/);
  assert.ok(p.indexOf('Fix these:') < p.indexOf('Answer these questions:'));
  assert.ok(p.indexOf('Answer these questions:') < p.indexOf('Keep these as they are:'));
  assert.match(p, /1\. "Budget is \$750"\n {3}My note: Should be \$900/);
  assert.match(p, /3\. "Ship the demo"/);
  assert.doesNotMatch(p, /—/);
});

test('empty lists give empty output', () => {
  assert.equal(feedbackPrompt('x.md', []), '');
  assert.equal(highlightsMarkdown('x.md', []), '');
});

test('highlightsMarkdown quotes each passage with its meaning', () => {
  const md = highlightsMarkdown('plan.md', [{ color: 'pink', exact: 'Budget is $750', note: 'raise it' }]);
  assert.match(md, /## Highlights from plan\.md/);
  assert.match(md, /> Budget is \$750\n\nFix this: raise it/);
});
