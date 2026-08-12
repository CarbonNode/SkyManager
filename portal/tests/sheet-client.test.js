/* ====================================================================== *
 *  Character Sheet phone-client contract test.
 *
 *      node portal/tests/sheet-client.test.js
 *
 *  No browser package is required. We execute the real Character Sheet
 *  functions extracted from index.html against a tiny DOM surface, then
 *  inspect the HTML they paint and the body they send to /api/sheet-meta.
 *  This catches payload-shape regressions (notably "[object Object]" for
 *  magicka/stamina/carry) without copying the production renderer into a
 *  fixture that could drift away from it.
 * ====================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.resolve(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');
let pass = 0, fail = 0;
function T(name, ok) {
  if (ok) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.error('FAIL  ' + name); }
}

// Compile the complete inline client first: a missing quote in this 600 KB
// single-file SPA should fail loudly before the focused harness runs.
const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');
const fullScript = html.slice(scriptStart + '<script>'.length, scriptEnd);
try {
  new Function(fullScript);
  T('the complete portal client parses', true);
} catch (e) {
  T('the complete portal client parses (' + e.message + ')', false);
}

const start = fullScript.indexOf('var SH_META_FIELDS =');
const renderEnd = fullScript.indexOf('/* ---- meta save:', start);
const saveStart = fullScript.indexOf('function shSaveMeta()', renderEnd);
const saveEnd = fullScript.indexOf('/* ---- profile picture:', saveStart);
if (start < 0 || renderEnd < 0 || saveStart < 0 || saveEnd < 0) {
  console.error('FAIL  could not locate Character Sheet client functions');
  process.exit(1);
}

const host = { innerHTML: '' };
const fields = {};
const document = {
  activeElement: null,
  getElementById(id) {
    if (id === 'sheet-tab-body') return host;
    return fields[id] || null;
  },
};
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const sheet = {
  name: 'Test Dragonborn', race: 'Nord', level: 51,
  hp: { cur: 540, max: 600 }, mag: { cur: 210, max: 260 },
  sta: { cur: 300, max: 340 }, carry: { cur: 480, max: 525 },
  gold: 128340, souls: { dragon: 12 }, bounty: 0, beast: false,
  skills: [{ name: 'Destruction', level: 100 }], effects: [],
  inventory: { potions: { health: 18, magicka: 9, stamina: 7, other: 5, total: 39 }, lockpicks: 46 },
  meta: { charClass: 'Battlemage', title: 'The Ashen Crown', alignment: 'Lawful evil',
    eyeColor: 'Ice blue', height: '188 cm', age: '34', homeland: 'The Reach', deity: 'Nocturnal',
    background: '', history: '', portrait: '' },
};
const state = { charsheet: { ok: true, sheet, meta: sheet.meta,
  pendingMeta: { alignment: true }, ageMs: 0, pendingEdits: 1 } };
const context = vm.createContext({ console, document, state, esc, shUi: { fx: '' },
  Math, Number, String, Object, Array, isFinite });
vm.runInContext(fullScript.slice(start, renderEnd), context, { filename: 'portal-character-client.js' });

// A repaint must keep a half-typed value and caret. The tiny DOM returns the
// same stand-in before/after innerHTML replacement, which directly exercises
// the renderer's preservation loop.
fields['sh-title-in'] = {
  value: 'Half-typed title', selectionStart: 7, focused: false,
  focus() { this.focused = true; },
  setSelectionRange(a, b) { this.range = [a, b]; },
};
document.activeElement = fields['sh-title-in'];
context.renderSheetTab();

T('object-shaped magicka renders current / max', host.innerHTML.includes('210 / 260'));
T('object-shaped stamina renders current / max', host.innerHTML.includes('300 / 340'));
T('object-shaped carry renders current / max', host.innerHTML.includes('480 / 525'));
T('a full object-shaped carry value still shows its capacity', context.shPairText({ cur: 525, max: 525 }) === '525 / 525');
T('no object payload leaks into the UI', !host.innerHTML.includes('[object Object]'));
T('all four potion groups and lockpicks render',
  ['health', 'magicka', 'stamina', 'other', 'lockpicks'].every((k) => host.innerHTML.includes('sh-inv ' + k)) &&
  ['18', '9', '7', '5', '46'].every((n) => host.innerHTML.includes('sh-inv-n">' + n)));
T('all eight compact profile inputs render', context.SH_META_FIELDS.every((f) => host.innerHTML.includes('id="' + f.id + '"')));
T('alignment suggestions include the nine-axis choices', host.innerHTML.includes('value="Lawful evil"') &&
  host.innerHTML.includes('value="Chaotic good"') && host.innerHTML.includes('value="True neutral"'));
T('per-field pending state renders', host.innerHTML.includes('Alignment <span class="sh-pend">· pending</span>'));
T('a repaint preserves the focused value and caret', fields['sh-title-in'].value === 'Half-typed title' &&
  fields['sh-title-in'].focused && fields['sh-title-in'].range.join() === '7,7');

// Execute the real save function and prove all compact fields join the two
// prose fields in one POST body.
vm.runInContext(fullScript.slice(saveStart, saveEnd), context, { filename: 'portal-character-save.js' });
const inputValues = {
  'sh-cls-in': 'Nightblade', 'sh-title-in': 'Shadow of Riften',
  'sh-align-in': 'Chaotic neutral', 'sh-deity-in': 'Hermaeus Mora',
  'sh-eye-in': 'Violet', 'sh-height-in': '185 cm', 'sh-age-in': '37',
  'sh-home-in': 'Riften', 'sh-bg-in': 'Raised by thieves.', 'sh-hist-in': 'A long road.',
};
Object.keys(inputValues).forEach((id) => { fields[id] = { value: inputValues[id] }; });
fields['sh-save'] = { disabled: false, textContent: 'Save' };
let posted = null;
context.api = function (method, url, body) {
  if (method === 'POST') { posted = { method, url, body }; return Promise.resolve({ ok: true }); }
  return Promise.resolve(state.charsheet);
};
context.toast = function () {};
context.render = function () {};
context.shSaveMeta();

setImmediate(function () {
  const want = ['charClass', 'title', 'alignment', 'deity', 'eyeColor', 'height', 'age', 'homeland', 'background', 'history'];
  T('save posts every changed profile field in one request', posted && posted.url === '/api/sheet-meta' &&
    want.every((k) => Object.prototype.hasOwnProperty.call(posted.body, k)) && Object.keys(posted.body).length === want.length);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
