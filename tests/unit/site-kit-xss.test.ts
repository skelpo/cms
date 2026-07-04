// Regression tests for the content-render XSS hardening (fable-audit.md §3.1).
// renderMarkdown / renderTipTap must never emit live raw HTML or dangerous URL
// schemes from author-controlled content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderTipTap } from '../../packages/site-kit/src/index.js';

test('renderMarkdown escapes raw HTML instead of emitting it live', () => {
  const out = renderMarkdown('hi <script>alert(1)</script> there');
  assert.ok(!/<script>/i.test(out), out);
  assert.ok(out.includes('&lt;script&gt;'), out);
});

test('renderMarkdown neutralizes javascript: links', () => {
  const out = renderMarkdown('[x](javascript:alert(document.cookie))');
  assert.ok(!/href="javascript:/i.test(out), out);
  assert.ok(out.includes('href="#"'), out);
});

test('renderMarkdown blocks control-char-obfuscated schemes', () => {
  const out = renderMarkdown('[x](java\tscript:alert(1))');
  assert.ok(!/javascript:/i.test(out), out);
});

test('renderMarkdown blocks javascript: image sources', () => {
  const out = renderMarkdown('![a](javascript:alert(1))');
  assert.ok(!/src="javascript:/i.test(out), out);
});

test('renderMarkdown preserves safe links + formatting', () => {
  const out = renderMarkdown('# Title\n\n**bold** and [ok](https://example.com)');
  assert.ok(out.includes('<h1>Title</h1>'), out);
  assert.ok(out.includes('<strong>bold</strong>'), out);
  assert.ok(out.includes('href="https://example.com"'), out);
});

test('renderTipTap neutralizes javascript: link marks', () => {
  const out = renderTipTap({
    type: 'doc',
    content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'hi', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
    ] }],
  });
  assert.ok(!/href="javascript:/i.test(out), out);
  assert.ok(out.includes('href="#"'), out);
});

test('renderTipTap keeps https link marks', () => {
  const out = renderTipTap({
    type: 'doc',
    content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'hi', marks: [{ type: 'link', attrs: { href: 'https://ok.com' } }] },
    ] }],
  });
  assert.ok(out.includes('href="https://ok.com"'), out);
});
