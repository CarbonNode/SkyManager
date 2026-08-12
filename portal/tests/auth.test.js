/* ====================================================================== *
 *  Deck Portal — AUTH / EXPOSURE suite.
 *
 *      node portal/tests/auth.test.js        (exits 0 pass / 1 fail)
 *
 *  Guards the release decision (2026-08-11): the portal binds 127.0.0.1 by
 *  default, and a wider bind REFUSES to start without DECK_PORTAL_PASSWORD.
 *  Everything here is asserted against a real socket from a real NON-loopback
 *  address (the box's own LAN IP), because the gate's whole behaviour hinges
 *  on req.socket.remoteAddress — a test that connects to 127.0.0.1 takes the
 *  exempt path and proves nothing about what a phone or an attacker sees.
 * ====================================================================== */
const { execFile } = require('child_process');
const http = require('http'); const path = require('path');
const os = require('os'); const fs = require('fs');
const SERVER = '/workspace/SkyrimModdingPersonal/modding/hotkey-deck/portal/server.js';
const LAN = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal).address;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
const PORT = 8975;
let pass = 0, fail = 0;
const T = (n, ok, x) => { ok ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? ' — ' + x : ''))); };

const req = (opts, body) => new Promise((resolve) => {
  const r = http.request(Object.assign({ host: LAN, port: PORT, path: '/api/roster', method: 'GET' }, opts),
    (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ s: res.statusCode, b, h: res.headers })); });
  r.on('error', (e) => resolve({ s: 0, b: String(e.message) }));
  if (body) r.write(body); r.end();
});

(async () => {
  const p = execFile(process.execPath, [SERVER], { env: Object.assign({}, process.env, {
    DECK_PORTAL_MOD_HD: tmp, DECK_PORTAL_FO_JSON: path.join(tmp, 'fo.json'), DECK_PORTAL_OVERWRITE: tmp,
    DECK_PORTAL_PORT: String(PORT), DECK_PORTAL_BIND: '0.0.0.0', DECK_PORTAL_PASSWORD: 'hunter2' }) });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  await new Promise(r => setTimeout(r, 1200));
  console.log('bind banner:', (out.match(/REACHABLE FROM THE NETWORK.*/) || ['(none)'])[0].trim());
  console.log('\nfrom ' + LAN + ' (a real non-loopback peer):');

  const anon = await req({});
  T('unauthenticated API call is refused 401', anon.s === 401, 'status ' + anon.s);
  T('refusal is JSON, not an HTML login page', /^\s*\{/.test(anon.b), anon.b.slice(0, 60));
  T('refusal does not leak roster data', !/categories/.test(anon.b));

  const page = await req({ path: '/' });
  T('a browser hit gets the login PAGE (401)', page.s === 401 && /type="password"/.test(page.b));

  const badPw = await req({ path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 'password=wrong');
  T('wrong password rejected', badPw.s === 401);
  T('wrong password sets NO cookie', !badPw.h['set-cookie']);

  const good = await req({ path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 'password=hunter2');
  T('right password redirects', good.s === 303, 'status ' + good.s);
  const cookie = (good.h['set-cookie'] || [''])[0];
  T('sets an HttpOnly SameSite cookie', /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie), cookie);
  T('cookie carries no password', !/hunter2/.test(cookie));

  const withC = await req({ headers: { Cookie: cookie.split(';')[0] } });
  T('the cookie now grants access', withC.s === 200, 'status ' + withC.s);

  const forged = await req({ headers: { Cookie: 'deckportal=' + (Date.now() + 99999999) + '.' + 'f'.repeat(64) } });
  T('a forged signature is rejected', forged.s === 401, 'status ' + forged.s);

  const expired = await req({ headers: { Cookie: 'deckportal=1.' + 'f'.repeat(64) } });
  T('an expired cookie is rejected', expired.s === 401, 'status ' + expired.s);

  p.kill();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
