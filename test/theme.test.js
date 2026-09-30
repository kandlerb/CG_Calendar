// The dark theme is written twice in styles.css: once for a device set to
// dark, once for someone who picked dark with the toggle. They must match.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function declarations(selectorStart) {
  const start = css.indexOf(selectorStart);
  assert.ok(start >= 0, `no ${selectorStart} in styles.css`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return body
    .split(';')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('the dark theme', () => {
  it('is the same whether it comes from the device or the toggle', () => {
    const fromDevice = declarations(':root:not([data-theme="light"])');
    const fromToggle = declarations(':root[data-theme="dark"]');
    assert.ok(fromDevice.length > 20, 'the dark block looks empty');
    assert.deepEqual(fromToggle, fromDevice);
  });

  it('lets a chosen light theme win over a dark device', () => {
    assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  });
});
