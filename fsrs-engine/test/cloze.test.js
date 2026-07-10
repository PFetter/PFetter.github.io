// M9 — Code-cloze rendering: parse `{{cN::answer}}` / `{{cN::answer::hint}}`
// markers and render to HTML with selective reveal. Pure string in, string
// out — no DOM API calls, so it runs headless and the same module renders
// unchanged in the browser (index.html attaches the HTML string to a node).
//
// Known limitation (documented, not a bug): the parser assumes cloze markers
// don't nest and that cloze answers don't themselves contain the literal
// substring "}}" — reasonable for short code-token deletions, not for
// arbitrary code blocks containing double braces (e.g. some template syntax).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCloze, clozeNumbers, renderClozeHtml, renderCodeCloze, escapeHtml } from '../lib/cloze.js';

// --- parseCloze --------------------------------------------------------------

test('M9: plain text with no cloze markers parses to a single text segment', () => {
  assert.deepEqual(parseCloze('const x = 1;'), [{ type: 'text', value: 'const x = 1;' }]);
});

test('M9: a single cloze extracts its number and answer', () => {
  const segments = parseCloze('return {{c1::a + b}};');
  assert.deepEqual(segments, [
    { type: 'text', value: 'return ' },
    { type: 'cloze', num: 1, answer: 'a + b', hint: null },
    { type: 'text', value: ';' },
  ]);
});

test('M9: a cloze with a hint splits on the first "::" after the answer', () => {
  const segments = parseCloze('{{c1::a + b::sum of args}}');
  assert.deepEqual(segments[0], { type: 'cloze', num: 1, answer: 'a + b', hint: 'sum of args' });
});

test('M9: multiple distinct clozes are parsed in document order', () => {
  const segments = parseCloze('function {{c1::add}}(a, b) { return {{c2::a + b}}; }');
  const clozes = segments.filter((s) => s.type === 'cloze');
  assert.deepEqual(clozes.map((c) => [c.num, c.answer]), [
    [1, 'add'],
    [2, 'a + b'],
  ]);
});

test('M9: a cloze can span multiple lines', () => {
  const segments = parseCloze('{{c1::line one\nline two}}');
  assert.equal(segments[0].answer, 'line one\nline two');
});

test('M9: an unclosed cloze marker is left as plain text, no crash', () => {
  const segments = parseCloze('function add(a, b) { {{c1::unclosed');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 'text');
});

test('M9: empty string parses to an empty segment list', () => {
  assert.deepEqual(parseCloze(''), []);
});

test('M9: non-string input is rejected', () => {
  assert.throws(() => parseCloze(null), TypeError);
  assert.throws(() => parseCloze(42), TypeError);
});

test('M9: clozeNumbers returns sorted unique cloze numbers', () => {
  const segments = parseCloze('{{c2::b}} {{c1::a}} {{c2::b again}}');
  assert.deepEqual(clozeNumbers(segments), [1, 2]);
});

// --- escapeHtml ---------------------------------------------------------------

test('M9: escapeHtml neutralizes HTML-significant characters', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a && b'), 'a &amp;&amp; b');
  assert.equal(escapeHtml(`"quoted" & 'single'`), '&quot;quoted&quot; &amp; &#39;single&#39;');
});

// --- renderClozeHtml -----------------------------------------------------------

test('M9: hidden cloze renders a bracketed placeholder, not the answer', () => {
  const html = renderClozeHtml(parseCloze('{{c1::secret}}'));
  assert.ok(!html.includes('secret'), 'answer text must not leak while hidden');
  assert.equal(html, '<span class="cloze cloze-hidden" data-cloze="1">[...]</span>');
});

test('M9: hidden cloze with a hint shows the hint, not the answer', () => {
  const html = renderClozeHtml(parseCloze('{{c1::secret::a clue}}'));
  assert.ok(html.includes('a clue'));
  assert.ok(!html.includes('secret'));
});

test('M9: revealing a cloze number shows its answer', () => {
  const segments = parseCloze('{{c1::secret}}');
  const html = renderClozeHtml(segments, { revealed: new Set([1]) });
  assert.equal(html, '<span class="cloze cloze-revealed" data-cloze="1">secret</span>');
});

test('M9: revealed:"all" reveals every cloze regardless of number', () => {
  const segments = parseCloze('{{c1::a}} {{c2::b}}');
  const html = renderClozeHtml(segments, { revealed: 'all' });
  assert.ok(html.includes('>a<') && html.includes('>b<'));
  assert.ok(!html.includes('cloze-hidden'));
});

test('M9: revealing one cloze number leaves others hidden', () => {
  const segments = parseCloze('{{c1::a}} {{c2::b}}');
  const html = renderClozeHtml(segments, { revealed: new Set([1]) });
  assert.ok(html.includes('cloze-revealed'));
  assert.ok(html.includes('cloze-hidden'));
});

test('M9: surrounding text is HTML-escaped in the rendered output', () => {
  const segments = parseCloze('if (a < b) { return {{c1::true}}; }');
  const html = renderClozeHtml(segments);
  assert.ok(html.includes('a &lt; b'));
});

test('M9: cloze answers are HTML-escaped even when revealed', () => {
  const segments = parseCloze('{{c1::<b>bold</b>}}');
  const html = renderClozeHtml(segments, { revealed: 'all' });
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'));
  assert.ok(!html.includes('<b>bold</b>'));
});

// --- renderCodeCloze (thin wrapper) --------------------------------------------

test('M9: renderCodeCloze wraps output in a pre/code block', () => {
  const html = renderCodeCloze('return {{c1::42}};');
  assert.ok(html.startsWith('<pre class="code-cloze"><code>'));
  assert.ok(html.endsWith('</code></pre>'));
  assert.ok(html.includes('cloze-hidden'));
});
