// The example check, before each release: every example (the app's own and every library's in
// registry/src) runs for a few seconds of simulated time in a hidden Edge window, and what happened is
// compared with the last good run (tools/examples-baseline.json).
//
//   node tools/check_examples.mjs              check (exit code 1 if something broke)
//   node tools/check_examples.mjs --update     check, then keep this run as the new good one
//   options: --seconds 8  --only <text in the example's id>  --show (a visible window)
//            --old-timing (programs as before 0.14: every wait and bus transfer a whole step)
//            --baseline <file> (compare with / keep in another file)
//
// It uses the dev server at http://localhost:1420 (started here if it isn't running) and Microsoft
// Edge, which comes with Windows (or set EDGE=<path to a Chromium browser>). The report goes to
// tools/examples-report.md.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { libraryFolders, readFolder } from '../registry/tools/pack.mjs';
import { checkLibrarySafety } from '../registry/tools/safety.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const seconds = Number(opt('seconds', 8));
const only = opt('only', '');
const BASE = resolve(opt('baseline', join(here, 'examples-baseline.json')));
const REPORT = join(here, 'examples-report.md');
const VITE_PORT = 1421; // (its own: 1420 is the one you develop with)
const URL_ = `http://localhost:${VITE_PORT}/`;
const PORT = 9335;

// 1. the libraries as they are now, packed (the same steps as the list's pack tool)
const libDir = join(here, 'examplecheck-libs');
rmSync(libDir, { recursive: true, force: true });
mkdirSync(join(libDir, 'libraries'), { recursive: true });
const entries = [];
for (const dir of libraryFolders()) {
  const lib = readFolder(dir);
  const text = JSON.stringify(lib);
  if (!checkLibrarySafety(lib, text.length).ok) { console.error(`${lib.id} fails the safety check: left out`); continue; }
  writeFileSync(join(libDir, 'libraries', `${lib.id}.benchlib`), text);
  entries.push({ id: lib.id, version: lib.version, url: `libraries/${lib.id}.benchlib` });
}
writeFileSync(join(libDir, 'index.json'), JSON.stringify({ format: 'bench-library-index', libraries: entries }));
console.log(`packed ${entries.length} libraries into ${libDir}`);

// 2. a dev server of its own, that doesn't reload the page when files change (BENCH_STILL)
const up = async () => { try { return (await fetch(URL_)).ok; } catch { return false; } };
if (await up()) throw new Error(`something already answers on ${URL_}: an example check still running? (stop it first)`);
console.log(`starting its own dev server on ${URL_} ...`);
// (its output goes to tools/examplecheck-vite.log: when examples can't load their files, it says why)
const viteLog = openSync(join(here, 'examplecheck-vite.log'), 'w');
const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], { cwd: root, stdio: ['ignore', viteLog, viteLog], shell: process.platform === 'win32', env: { ...process.env, BENCH_STILL: '1' } });
vite.on('exit', (code) => console.log(`  (its dev server stopped, code ${code}: see tools/examplecheck-vite.log)`));
for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 1000));
if (!(await up())) throw new Error(`its dev server did not start on port ${VITE_PORT}`);

// 3. a browser of its own (a fresh profile: only the libraries packed above)
const edge = process.env.EDGE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => existsSync(p));
if (!edge) throw new Error('no Edge or Chromium found: set EDGE=<path to one>');
const profile = mkdtempSync(join(tmpdir(), 'bench-examples-'));
const browser = spawn(edge, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required',
  ...(flag('show') ? [] : ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  URL_,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** the page, through the browser's debugging port (connected again after the page crashes) */
let ws = null, id = 0, pageErrors = 0;
const pending = new Map();
async function connect() {
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && t.url.startsWith(URL_)); } catch { /* not yet */ }
    if (!page) {
      if (i === 10) await fetch(`http://127.0.0.1:${PORT}/json/new?${URL_}`, { method: 'PUT' }).catch(() => {}); // (a crashed tab: a new one)
      await sleep(500);
    }
  }
  if (!page) throw new Error('the browser did not open the page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const t = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (t.startsWith('[examples]')) console.log(t);
    }
    if (msg.method === 'Inspector.targetCrashed') console.log('  (the page crashed)');
    if (msg.method === 'Runtime.exceptionThrown' && pageErrors++ < 5) {
      const d = msg.params.exceptionDetails;
      console.log(`  (page error: ${d.exception?.description?.split('\n').slice(0, 3).join(' | ') ?? d.text} at ${d.url ?? ''}:${d.lineNumber ?? ''})`);
    }
  };
  ws.onclose = () => { for (const res of pending.values()) res({ error: { message: 'the page went away' } }); pending.clear(); };
  await call('Runtime.enable');
  await call('Inspector.enable');
}
const call = (method, params = {}, timeoutMs = 30000) => new Promise((res) => {
  const n = ++id;
  const t = setTimeout(() => { pending.delete(n); res({ error: { message: `no answer within ${timeoutMs / 1000} s` } }); }, timeoutMs);
  pending.set(n, (m) => { clearTimeout(t); res(m); });
  try { ws.send(JSON.stringify({ id: n, method, params })); } catch (e) { clearTimeout(t); pending.delete(n); res({ error: { message: String(e) } }); }
});
const evaluate = async (expression, timeoutMs = 30000) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (r.error) throw new Error(r.error.message);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
/** (re)open the page and install the packed libraries; the examples there are */
async function ready() {
  await connect();
  // (a cold dev server on a busy or low-memory PC can take a minute to build the page)
  const t = Date.now();
  let loaded = false;
  while (!loaded && Date.now() - t < 120000) {
    try { loaded = !!(await evaluate('typeof window.bench === "object" && !!window.bench.checkExamples')); } catch { /* loading */ }
    if (!loaded) await sleep(500);
  }
  if (!loaded) {
    const st = await evaluate('({ ready: document.readyState, url: location.href, title: document.title, scripts: document.scripts.length })').catch((e) => e.message);
    throw new Error(`the app page did not finish loading within 120 s (a busy or low-memory PC?): ${JSON.stringify(st)}`);
  }
  console.log(`page loaded in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  return evaluate(`bench.checkExamples(${JSON.stringify({ only, fromPacked: '/tools/examplecheck-libs/', listOnly: true })})`, 120000);
}

// 4. run them, one at a time (a page that crashes on one is opened again for the next)
const t0 = Date.now();
const results = [];
let expected = 0;
try {
  const ids = await ready();
  expected = ids.length;
  const info = await evaluate('({ webgl: !!document.createElement("canvas").getContext("webgl2"), isolated: self.crossOriginIsolated })');
  console.log(`page ready (WebGL ${info?.webgl ? 'yes' : 'NO: cameras see nothing'}, threads ${info?.isolated ? 'yes' : 'NO'}); ${ids.length} examples, ${seconds} s each`);
  for (const ex of ids) {
    let r = null, why = '';
    try {
      const got = await evaluate(`bench.checkExamples(${JSON.stringify({ ids: [ex], seconds, oldTiming: flag('old-timing') })})`, Math.max(120, seconds * 20) * 1000);
      r = got?.[0] ?? null;
      if (!r) why = 'the check returned nothing';
    } catch (e) {
      why = e.message;
    }
    if (!r) {
      console.log(`  ${ex}: the check failed (${why}): opening the page again`);
      r = { id: ex, name: ex.split('/').slice(1).join('/'), opened: false, problems: [`the check failed: ${why}`], warnings: [], errors: [`the check failed: ${why}`], serial: {}, lastLine: {}, pieces: {}, simSeconds: 0, wallMs: 0 };
      try { await call('Page.reload', {}, 5000); } catch { /* */ }
      try { ws.close(); } catch { /* */ }
      await sleep(1500);
      try { await ready(); } catch (e) {
        results.push(r); // (it failed: leaving it out made a run of 7 in 49 pass)
        console.log(`  couldn't open the page again: ${e.message}`);
        break;
      }
    }
    results.push(r);
  }
} finally {
  try { ws?.close(); } catch { /* */ }
  browser.kill();
  // (the server and everything it started: on Windows npx runs it under a shell)
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
  else vite.kill();
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ } }, 1500);
}
console.log(`ran ${results.length} examples in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// 5. compare with the last good run
const norm = (s) => s.replace(/-?\d+(\.\d+)?/g, '#');
const base = existsSync(BASE) ? JSON.parse(readFileSync(BASE, 'utf8')) : { results: [] };
const byId = new Map(base.results.map((r) => [r.id, r]));
const rows = [];
let failed = 0, changed = 0;
for (const r of results) {
  const b = byId.get(r.id);
  const fail = [], look = [];
  if (!r.opened) fail.push(`didn't open: ${r.problems.join('; ')}`);
  for (const e of r.errors) if (!b || !b.errors.map(norm).includes(norm(e))) fail.push(`error: ${e}`);
  for (const [k, p] of Object.entries(r.pieces)) {
    const bp = b?.pieces?.[k];
    if (p.fell && !bp?.fell) fail.push(`${k} fell off the bench`);
    if (!bp) continue;
    const d = Math.abs(p.maxAway - bp.maxAway);
    if (d > Math.max(8, 0.4 * Math.max(p.maxAway, bp.maxAway))) look.push(`${k} went ${p.maxAway} cm from its start (before: ${bp.maxAway})`);
    // (a motor's hub or a servo's horn turns by design: only whole parts can tip over)
    if (!p.turns && !/\)$/.test(k) && bp.up > 0.5 && p.up < 0) fail.push(`${k} tipped over (before it stayed up)`);
  }
  if (b) {
    for (const [k, n] of Object.entries(b.serial ?? {})) {
      const now = r.serial[k] ?? 0;
      if (n > 0 && now === 0) fail.push(`${k} printed nothing (before: ${n} lines)`);
      else if (Math.abs(now - n) > Math.max(10, 0.5 * n)) look.push(`${k} printed ${now} lines (before: ${n})`);
    }
    for (const w of r.warnings) if (!b.warnings.map(norm).includes(norm(w))) look.push(`new warning: ${w}`);
  } else look.push('new: nothing to compare with');
  if (fail.length) failed++;
  else if (look.length) changed++;
  rows.push({ r, fail, look });
}

const md = [`# Example check`, '', `${new Date().toLocaleString('en-US')}: ${results.length} examples, ${seconds} s each. **${failed} broken, ${changed} to look at.**`, ''];
for (const { r, fail, look } of rows) {
  const mark = fail.length ? 'BROKEN' : look.length ? 'look' : 'ok';
  md.push(`## ${mark}: ${r.id}`, '');
  for (const f of fail) md.push(`- **${f}**`);
  for (const l of look) md.push(`- ${l}`);
  const pcs = Object.entries(r.pieces).filter(([, p]) => p.maxAway > 1).map(([k, p]) => `${k} ${p.maxAway} cm`);
  md.push(`- ran ${r.simSeconds.toFixed(1)} s (${(r.wallMs / 1000).toFixed(1)} s real); moved: ${pcs.join(', ') || 'nothing'}`);
  for (const [k, l] of Object.entries(r.lastLine)) md.push(`- ${k} last printed: \`${l.replace(/`/g, "'")}\``);
  md.push('');
}
writeFileSync(REPORT, md.join('\n'));
console.log(`${failed} broken, ${changed} to look at, ${results.length - failed - changed} ok. Report: ${REPORT}`);
for (const { r, fail } of rows) for (const f of fail) console.log(`  BROKEN ${r.id}: ${f}`);

if (flag('update')) {
  // (with --only, the others' last good runs are kept)
  const keep = base.results.filter((x) => !results.some((r) => r.id === x.id));
  writeFileSync(BASE, JSON.stringify({ seconds, saved: new Date().toISOString(), results: [...keep, ...results].sort((a, b) => a.id.localeCompare(b.id)) }, null, 1) + '\n');
  console.log(`kept this run as the good one: ${BASE}`);
}
const missed = expected - results.length;
if (missed > 0 || !expected) console.log(`INCOMPLETE: only ${results.length} of ${expected} examples ran, so this is not a pass`);
process.exit(missed > 0 || !expected || (failed && !flag('update')) ? 1 : 0);
