// Code-cloze card type (M9): `{{cN::answer}}` / `{{cN::answer::hint}}` markers
// parsed to segments, rendered to HTML with per-number reveal.
//
// Pure string in, string out — no DOM API calls. Runs headless under
// node --test; the same module renders unchanged in the browser, where a
// thin adapter (index.html) assigns the HTML string to an element.
//
// Known limitation (documented, not fixed here): the parser assumes cloze
// markers don't nest and that an answer never contains the literal "}}".
// That's fine for short code-token deletions (the v1 use case) but would
// break on code containing double-brace syntax.

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)\}\}/g;

export function parseCloze(text) {
  if (typeof text !== 'string') throw new TypeError('parseCloze expects a string');

  const segments = [];
  let lastIndex = 0;
  for (const match of text.matchAll(CLOZE_RE)) {
    const [full, numStr, body] = match;
    const { index } = match;
    if (index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, index) });

    const sep = body.indexOf('::');
    const answer = sep === -1 ? body : body.slice(0, sep);
    const hint = sep === -1 ? null : body.slice(sep + 2);
    segments.push({ type: 'cloze', num: Number(numStr), answer, hint });

    lastIndex = index + full.length;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments;
}

export function clozeNumbers(segments) {
  return [...new Set(segments.filter((s) => s.type === 'cloze').map((s) => s.num))].sort((a, b) => a - b);
}

export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// revealed: Set<number> of cloze numbers to reveal, or the string 'all'.
export function renderClozeHtml(segments, { revealed = new Set() } = {}) {
  return segments
    .map((seg) => {
      if (seg.type === 'text') return escapeHtml(seg.value);

      const isRevealed = revealed === 'all' || revealed.has(seg.num);
      if (isRevealed) {
        return `<span class="cloze cloze-revealed" data-cloze="${seg.num}">${escapeHtml(seg.answer)}</span>`;
      }
      const placeholder = seg.hint ? escapeHtml(seg.hint) : '...';
      return `<span class="cloze cloze-hidden" data-cloze="${seg.num}">[${placeholder}]</span>`;
    })
    .join('');
}

// Thin convenience wrapper for the code-snippet-cloze card type (v1 scope §4.2).
export function renderCodeCloze(text, opts) {
  return `<pre class="code-cloze"><code>${renderClozeHtml(parseCloze(text), opts)}</code></pre>`;
}
