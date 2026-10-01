// Static checks for translations and page integrity. Zero dependencies:
//   node --test tests/unit/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = f => readFileSync(root + f, 'utf8');

// Load the translation files the same way the browser does (in order, sharing `window`).
const ctx = { console };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['i18n.js', 'i18n-help.js', 'i18n-guide.js', 'i18n-fields.js']) vm.runInContext(read(f), ctx, { filename: f });
const { I18N, HELP_META } = ctx;
const S = I18N.strings;
const langs = I18N.languages.map(l => String(l.code)).join(',').split(',');   // copy out of the vm realm
const en = S.en;
const html = read('index.html');
const placeholders = s => (String(s).match(/\{\w+\}/g) || []).sort();

test('offers the 10 expected languages, and no Russian', () => {
  assert.deepEqual(langs, ['en', 'uk', 'es', 'de', 'fr', 'pt', 'it', 'pl', 'zh', 'ja']);
  assert.ok(!('ru' in S), 'no Russian strings');
  assert.deepEqual(Object.keys(S).sort(), [...langs].sort(), 'every string table is a listed language');
});

test('every language has every English key', () => {
  for (const l of langs) {
    const missing = Object.keys(en).filter(k => !(k in S[l]));
    assert.deepEqual(missing, [], `${l} is missing keys`);
  }
});

test('no language has keys English does not', () => {
  for (const l of langs) {
    const extra = Object.keys(S[l]).filter(k => !(k in en));
    assert.deepEqual(extra, [], `${l} has stray keys`);
  }
});

test('no empty translations', () => {
  for (const l of langs) {
    const empty = Object.entries(S[l]).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
    assert.deepEqual(empty, [], `${l} has empty strings`);
  }
});

test('{placeholders} match English in every language', () => {
  for (const l of langs) {
    const bad = Object.keys(en).filter(k => k in S[l] && JSON.stringify(placeholders(en[k])) !== JSON.stringify(placeholders(S[l][k])));
    assert.deepEqual(bad, [], `${l} placeholder mismatch`);
  }
});

test('HTML-bearing strings keep their tags in every language', () => {
  const tags = s => (String(s).match(/<\/?(code|b|a)\b/g) || []).sort();
  for (const k of Object.keys(en).filter(k => /<\w/.test(en[k]))) {
    for (const l of langs) assert.deepEqual(tags(S[l][k]), tags(en[k]), `${l} ${k}`);
  }
});

test('every help entry has a description and every description has an entry', () => {
  const described = Object.keys(en).filter(k => k.startsWith('help.') && !k.startsWith('help.ui.')).map(k => k.slice(5));
  const noText = Object.keys(HELP_META).filter(k => !described.includes(k) && k !== 'obstructionFraction');   // alias
  const noMeta = described.filter(k => !(k in HELP_META));
  assert.deepEqual(noText, [], 'HELP_META keys without text');
  assert.deepEqual(noMeta, [], 'help texts without HELP_META entry');
});

test('every data-i18n* key used in index.html exists', () => {
  const keys = [...html.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria)?="([^"]+)"/g)].map(m => m[1]);
  assert.ok(keys.length > 50, 'found the static keys');
  const missing = [...new Set(keys)].filter(k => !(k in en));
  assert.deepEqual(missing, []);
});

test('every literal t("…") key used in index.html exists', () => {
  // skip prefixes that are completed at runtime, e.g. t('help.' + key)
  const keys = [...html.matchAll(/\bt\(\s*'([a-z][\w.]*)'/g)].map(m => m[1]).filter(k => !k.endsWith('.'));
  assert.ok(keys.length > 100, 'found the dynamic keys');
  const missing = [...new Set(keys)].filter(k => !(k in en));
  assert.deepEqual(missing, []);
});

test('templated keys (tabs, dialogs, guide) resolve for every value', () => {
  const tabs = [...html.matchAll(/data-tab="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(tabs)], ['overview', 'history', 'obstruction', 'router', 'speedtest', 'debug', 'raw']);
  const bullets = JSON.parse(html.match(/const GUIDE_BULLETS = (\{[^}]+\})/)[1].replace(/(\w+):/g, '"$1":'));
  for (const tab of tabs) {
    for (const k of [`tab.${tab}`, `guide.${tab}.intro`, ...Array.from({ length: bullets[tab] }, (_, i) => `guide.${tab}.${i + 1}`)]) {
      assert.ok(k in en, k);
    }
  }
  const dlg = html.match(/const ACTION_DLG = \{([^}]+)\}/)[1];
  for (const [, id] of dlg.matchAll(/\['(\w+)'/g)) for (const part of ['title', 'body', 'ok']) assert.ok(`dlg.${id}.${part}` in en, `dlg.${id}.${part}`);
  for (const target of ['dish', 'router']) assert.ok(`dlg.target.${target}` in en);
});

test('status codes and field labels exist in every language', () => {
  for (const l of langs) {
    for (const k of ['v.CONNECTED', 'v.FILTER_CONVERGED', 'v.HAS_ACTUATORS_NO', 'f.tiltAngleDeg', 'f.hasActuators', 'f.motorsStuck']) {
      assert.ok(S[l][k], `${l} ${k}`);
    }
  }
});

test('the page loads only local scripts and styles (no CDN, no trackers)', () => {
  const external = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https?:)?\/\/[^"]+"/g)].map(m => m[0]);
  assert.deepEqual(external, []);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['i18n.js', 'i18n-help.js', 'i18n-guide.js', 'i18n-fields.js']);
});

test('fields are loaded after the other translation files', () => {
  // i18n-fields.js merges into I18N.strings, so it must come after i18n.js defines them.
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(order.indexOf('i18n.js') < order.indexOf('i18n-fields.js'));
});
