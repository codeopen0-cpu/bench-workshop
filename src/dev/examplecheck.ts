// The example check: runs every example (the app's own and each installed library's) for a few
// seconds of simulated time and records what happened, so a change to the simulator that breaks one
// shows up before a release: problems opening it, warnings and errors, programs that crash, what the
// boards printed, how far each moving piece went and whether it tipped over or fell off the bench.
// tools/check_examples.mjs runs it in a browser and compares the result with the last good one
// (tools/examples-baseline.json). In the page: await bench.checkExamples({ seconds: 8 })
import type { App } from '../app';
import { EXAMPLES } from '../examples';
import { libMailbox } from '../lib/runtime';
import { installed, installLibrary } from '../lib/store';
import { validate } from '../project';
import { SketchHost } from '../sketch/host';

export interface PieceResult {
  /** where it ended up minus where it started (cm), and the largest distance from the start on the way */
  moved: number;
  maxAway: number;
  /** its up direction's height at the end: 1 upright, 0 on its side, -1 upside down */
  up: number;
  /** below the bench top by more than 20 cm at the end */
  fell: boolean;
  /** a part's moving piece (a motor's hub, a servo's horn): it turns by design, so "up" says nothing */
  turns?: boolean;
}
export interface ExampleResult {
  id: string; // "app/<name>" or "<library id>/<name>"
  name: string;
  opened: boolean;
  problems: string[];
  warnings: string[];
  errors: string[];
  /** lines each board printed */
  serial: Record<string, number>;
  /** its last line (for the report) */
  lastLine: Record<string, string>;
  pieces: Record<string, PieceResult>;
  simSeconds: number;
  wallMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every example there is now: the app's own and the installed libraries'. */
export function allExamples(): { id: string; name: string; raw: () => any }[] {
  const out: { id: string; name: string; raw: () => any }[] = [];
  for (const x of EXAMPLES) out.push({ id: `app/${x.name}`, name: x.name, raw: () => JSON.parse(x.text) });
  for (const lib of [...installed.values()].sort((a, b) => a.id.localeCompare(b.id)))
    for (const ex of lib.examples ?? []) out.push({ id: `${lib.id}/${ex.name}`, name: ex.name, raw: () => structuredClone(ex.project) });
  return out;
}

/** Install the libraries from a packed list (an index.json as registry/tools/pack.mjs writes it, with
 *  libraries/<id>.benchlib beside it), so the check runs the versions about to be published, not
 *  whatever this browser had. tools/check_examples.mjs packs them into tools/examplecheck-libs/. */
export async function installFromPacked(base = '/tools/examplecheck-libs/') {
  const index = await fetch(`${base}index.json?${Date.now()}`).then((r) => r.json());
  const list: { id: string; url?: string }[] = Array.isArray(index) ? index : index.libraries ?? [];
  const done: string[] = [];
  for (const e of list) {
    const raw = await fetch(`${base}${e.url ?? `libraries/${e.id}.benchlib`}?${Date.now()}`).then((r) => r.json());
    const r = await installLibrary(raw);
    if (!r.ok) console.warn(`[examples] couldn't install ${e.id}: ${r.message}`);
    else done.push(`${raw.id} ${raw.version}`);
  }
  console.info(`[examples] installed ${done.length} libraries from ${base}: ${done.join(', ')}`);
  return done;
}

export interface CheckOptions {
  seconds?: number;
  /** only examples whose id has this in it */
  only?: string;
  /** exactly these ids */
  ids?: string[];
  /** install the libraries packed at this address first (true: tools/examplecheck-libs) */
  fromPacked?: boolean | string;
  /** just install (fromPacked) and say which examples there are, without running any */
  listOnly?: boolean;
  oldTiming?: boolean;
  onResult?: (r: ExampleResult) => void;
}

export async function checkExamples(app: App, opts: CheckOptions = {}): Promise<ExampleResult[] | string[]> {
  const seconds = opts.seconds ?? 8;
  if (opts.fromPacked) await installFromPacked(typeof opts.fromPacked === 'string' ? opts.fromPacked : undefined);
  // (only: one text, or several separated by commas: "ESP32 speaker,Line-following")
  const wanted = (opts.only ?? '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const list = allExamples().filter((x) => (!wanted.length || wanted.some((w) => x.id.toLowerCase().includes(w))) && (!opts.ids || opts.ids.includes(x.id)));
  if (opts.listOnly) return list.map((x) => x.id);
  SketchHost.fineTiming = !opts.oldTiming;
  libMailbox.on = !opts.oldTiming;
  if (opts.oldTiming) console.info('[examples] with the old program timing (every wait and bus transfer a whole step)');
  console.info(`[examples] checking ${list.length} examples, ${seconds} s each`);
  const results: ExampleResult[] = [];
  // (dialogs would stop the check: answer them)
  const realConfirm = window.confirm, realAlert = window.alert;
  window.confirm = () => false;
  window.alert = () => {};
  const realLog = app.log.bind(app);
  let logs: { level: string; msg: string }[] = [];
  (app as any).log = (msg: string, level: 'info' | 'warn' | 'bad' = 'info') => {
    logs.push({ level, msg });
    realLog(msg, level);
  };
  try {
    for (const ex of list) {
      const t0 = performance.now();
      const r: ExampleResult = { id: ex.id, name: ex.name, opened: false, problems: [], warnings: [], errors: [], serial: {}, lastLine: {}, pieces: {}, simSeconds: 0, wallMs: 0 };
      logs = [];
      try {
        const { project, problems } = validate(ex.raw());
        r.problems = problems;
        if (project) {
          app.load(project, null);
          r.opened = true;
          await sleep(300);
          app.run();
          if (app.mode === 'run') app.pause(); // (only advance() moves it: the same steps every time)
          const sim = app.sim;
          if (sim) {
            // every moving piece: one per rigid body
            const rbs = new Map<number, { key: string; rb: any; start: { x: number; y: number; z: number }; maxAway: number }>();
            for (const p of app.project.parts) {
              const v = app.views.get(p.uid);
              for (const body of v?.bodies.keys() ?? []) {
                const rb = sim.rigidOf(p.uid, body);
                if (!rb || rbs.has(rb.handle) || !rb.isDynamic()) continue;
                const t = rb.translation();
                rbs.set(rb.handle, { key: `${p.name}${body === 'body' ? '' : ` (${body})`}`, rb, start: { x: t.x, y: t.y, z: t.z }, maxAway: 0 });
              }
            }
            const chunk = 0.5;
            for (let s = 0; s < seconds - 1e-9; s += chunk) {
              await app.advance(chunk);
              for (const x of rbs.values()) {
                const t = x.rb.translation();
                x.maxAway = Math.max(x.maxAway, Math.hypot(t.x - x.start.x, t.y - x.start.y, t.z - x.start.z));
              }
              if (!app.sim) break; // (it stopped itself)
            }
            r.simSeconds = app.circuit?.time ?? seconds;
            for (const x of rbs.values()) {
              const t = x.rb.translation(), q = x.rb.rotation();
              const up = 1 - 2 * (q.x * q.x + q.z * q.z); // (the y of the body's own up, turned by q)
              r.pieces[x.key] = {
                moved: +Math.hypot(t.x - x.start.x, t.y - x.start.y, t.z - x.start.z).toFixed(1),
                maxAway: +x.maxAway.toFixed(1),
                up: +up.toFixed(2),
                fell: t.y < -20,
                ...(x.key.endsWith(')') ? { turns: true } : {}),
              };
            }
          }
          for (const p of app.project.parts) {
            const all = app.dock.serialText(p.uid);
            if (!all) continue;
            // (only this run's: a board's monitor keeps what earlier runs printed)
            const text = all.split('--- run started ---').pop() ?? '';
            const lines = text.split('\n').filter((l) => l.trim());
            r.serial[p.name] = lines.length;
            r.lastLine[p.name] = (lines[lines.length - 1] ?? '').slice(0, 160);
          }
          app.stop();
        }
      } catch (e) {
        r.errors.push(`the check itself failed: ${(e as Error).message}`);
        try { app.stop(); } catch { /* */ }
      }
      for (const l of logs) {
        if (l.level === 'bad') r.errors.push(l.msg);
        else if (l.level === 'warn') r.warnings.push(l.msg);
      }
      r.wallMs = Math.round(performance.now() - t0);
      const fell = Object.entries(r.pieces).filter(([, p]) => p.fell).map(([k]) => k);
      console.info(`[examples] ${r.id}: ${r.opened ? 'ran' : 'did NOT open'} ${r.simSeconds.toFixed(1)} s in ${(r.wallMs / 1000).toFixed(1)} s; ${r.errors.length} errors, ${r.warnings.length} warnings, ${Object.values(r.serial).reduce((a, b) => a + b, 0)} serial lines${fell.length ? `, FELL: ${fell.join(', ')}` : ''}`);
      results.push(r);
      opts.onResult?.(r);
    }
  } finally {
    SketchHost.fineTiming = true;
    libMailbox.on = true;
    (app as any).log = realLog;
    window.confirm = realConfirm;
    window.alert = realAlert;
  }
  return results;
}
