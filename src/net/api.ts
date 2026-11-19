// The control API: the bench driven by your own programs (Python, a test script, another app) at
// http://127.0.0.1:7420/ (this PC only). Off until switched on (toolbar: API). Everything is JSON.
// A request from a web page (it carries an Origin header) is refused: only programs on this PC.
//
//   GET  /                      what it can do (this list)
//   GET  /state                 mode, time, the parts (uid, type, name), the boards
//   POST /run   /stop   /pause  start, stop (back to building), pause or resume
//   POST /step  {"seconds": 0.5}   pause the live run and step it exactly this long (repeatable tests)
//   GET  /parts/<uid>           where it is: position (cm), rotation (quaternion), speed, spin
//   GET  /parts/<uid>/status    its status lines, its run-panel controls, its pins' volts
//   POST /parts/<uid>/control  {"label": "Speed", "value": 0.5}  a slider / switch / button (true = down) / text box
//   POST /parts/<uid>/push     {"impulse": [x, y, z]}  give it a shove (g*cm/s)
//   GET  /serial/<uid>          what the board printed;  POST /serial/<uid> "text"  type into its serial
//   GET  /project               the bench (a .bench file's JSON);  POST /project {...}  open one
//   POST /program/<uid>        {"source": "...", "lang": "arduino"}  set a board's program
import type { Project } from '../project';
import type { Control } from '../elec/circuit';
import { closeBoardServer, openBoardServer, type WebReq, type WebResp } from './bridge';

export const API_PORT = 7420;
const API_NAME = '__api';

/** what the API needs from the app */
export interface ApiHost {
  mode(): string;
  time(): number;
  project(): Project;
  run(): void;
  stop(): void;
  pause(): void;
  advance(seconds: number): Promise<void>;
  /** a part's rigid bodies while running, by body name */
  bodies(uid: string): { name: string; rb: any }[];
  /** build mode: the part's world pose */
  pose(uid: string): { pos: number[]; rot: number[] } | null;
  device(uid: string): { status?(): string[]; controls?(): Control[]; sendSerial?(t: string): void } | undefined;
  pinVolts(uid: string): Record<string, number | null>;
  serialText(uid: string): string;
  load(json: unknown): string[];
  setProgram(uid: string, source: string, lang: string): void;
  isBoard(uid: string): boolean;
  log(msg: string, level?: 'info' | 'warn' | 'bad'): void;
}

const json = (status: number, data: unknown): WebResp => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(data, null, 1), headers: {} });
const err = (status: number, message: string) => json(status, { error: message });
const round = (v: number) => Math.round(v * 1000) / 1000;
const v3 = (v: { x: number; y: number; z: number }) => [round(v.x), round(v.y), round(v.z)];

export class ControlApi {
  on = false;
  url = `http://127.0.0.1:${API_PORT}/`;
  calls = 0;
  constructor(private host: ApiHost) {}

  async start() {
    if (this.on) return this.url;
    const { url } = await openBoardServer(API_NAME, (r) => this.handle(r), API_PORT);
    this.url = url;
    this.on = true;
    this.host.log(`control API on at ${url} (this PC only)`);
    return url;
  }
  async stopApi() {
    if (!this.on) return;
    this.on = false;
    await closeBoardServer(API_NAME);
    this.host.log('control API off');
  }

  private body(r: WebReq): any {
    if (!r.body) return {};
    try { return JSON.parse(r.body); } catch { return r.body; }
  }

  async handle(r: WebReq): Promise<WebResp> {
    // (a web page can reach 127.0.0.1 too: browsers say where they come from; programs don't)
    if (r.headers.origin) return err(403, 'the control API is for programs on this PC, not web pages');
    this.calls++;
    const h = this.host;
    const parts = r.path.split('/').filter(Boolean);
    const [a, uid, sub] = parts;
    const M = r.method;
    console.info(`[api] ${M} ${r.url}`);
    try {
      if (!a) return { status: 200, type: 'text/plain; charset=utf-8', body: HELP, headers: {} };
      if (a === 'state' && M === 'GET') {
        const p = h.project();
        return json(200, {
          mode: h.mode(), time: round(h.time()), name: p.name,
          parts: p.parts.map((x) => ({ uid: x.uid, type: x.type, name: x.name, ...(x.parent ? { on: x.parent.uid } : {}) })),
          boards: p.parts.filter((x) => h.isBoard(x.uid)).map((x) => x.uid),
        });
      }
      if (M === 'POST' && a === 'run') { h.run(); return json(200, { mode: h.mode() }); }
      if (M === 'POST' && a === 'stop') { h.stop(); return json(200, { mode: h.mode() }); }
      if (M === 'POST' && a === 'pause') { h.pause(); return json(200, { mode: h.mode() }); }
      if (M === 'POST' && a === 'step') {
        const s = Number(this.body(r).seconds ?? r.args.seconds ?? 0.1);
        if (!(s > 0 && s <= 60)) return err(400, 'seconds: more than 0, at most 60');
        if (h.mode() === 'build') h.run();
        if (h.mode() === 'run') h.pause(); // (stepped by hand from now on: the same each time)
        await h.advance(s);
        return json(200, { mode: h.mode(), time: round(h.time()) });
      }
      const p = h.project();
      const inst = uid ? p.parts.find((x) => x.uid === uid) ?? p.parts.find((x) => x.name === decodeURIComponent(uid)) : undefined;
      if ((a === 'parts' || a === 'serial' || a === 'program') && !inst) return err(404, `no part "${uid}" (GET /state lists them)`);
      if (a === 'parts' && inst) {
        const id = inst.uid;
        if (!sub && M === 'GET') {
          const bodies = h.bodies(id);
          if (!bodies.length) return json(200, { uid: id, name: inst.name, running: false, ...h.pose(id) });
          const out: Record<string, unknown> = { uid: id, name: inst.name, running: true };
          const b0 = bodies[0].rb;
          Object.assign(out, { pos: v3(b0.translation()), rot: [round(b0.rotation().x), round(b0.rotation().y), round(b0.rotation().z), round(b0.rotation().w)], vel: v3(b0.linvel()), spin: v3(b0.angvel()) });
          if (bodies.length > 1) out.bodies = Object.fromEntries(bodies.map((b) => [b.name, { pos: v3(b.rb.translation()), vel: v3(b.rb.linvel()) }]));
          return json(200, out);
        }
        if (sub === 'status' && M === 'GET') {
          const d = h.device(id);
          return json(200, { uid: id, status: d?.status?.() ?? [], controls: (d?.controls?.() ?? []).map((c) => ({ label: c.label, kind: c.kind ?? 'slider', ...('get' in c ? { value: c.get() } : {}), ...('min' in c ? { min: c.min, max: c.max } : {}) })), pins: h.pinVolts(id) });
        }
        if (sub === 'control' && M === 'POST') {
          const b = this.body(r);
          const c = (h.device(id)?.controls?.() ?? []).find((x) => x.label.toLowerCase() === String(b.label ?? '').toLowerCase());
          if (!c) return err(404, `no control "${b.label}" (GET /parts/${id}/status lists them)`);
          if (c.kind === 'button') c.press(!!b.value);
          else if (c.kind === 'switch') c.set(!!b.value);
          else if (c.kind === 'text') c.send(String(b.value ?? ''));
          else c.set(Number(b.value));
          return json(200, { ok: true });
        }
        if (sub === 'push' && M === 'POST') {
          const bodies = h.bodies(id);
          if (!bodies.length) return err(409, 'not running');
          const [x, y, z] = (this.body(r).impulse ?? [0, 0, 0]).map(Number);
          bodies[0].rb.applyImpulse({ x, y, z }, true);
          return json(200, { ok: true });
        }
      }
      if (a === 'serial' && inst) {
        if (M === 'GET') return json(200, { uid: inst.uid, text: h.serialText(inst.uid) });
        if (M === 'POST') {
          const d = h.device(inst.uid);
          if (!d?.sendSerial) return err(409, 'it is not running (or has no serial)');
          const b = this.body(r);
          d.sendSerial(typeof b === 'string' ? b : String(b.text ?? ''));
          return json(200, { ok: true });
        }
      }
      if (a === 'program' && inst && M === 'POST') {
        if (!h.isBoard(inst.uid)) return err(400, `${inst.name} is not a board`);
        const b = this.body(r);
        if (typeof b.source !== 'string') return err(400, 'send {"source": "..."}');
        h.setProgram(inst.uid, b.source, b.lang ?? 'arduino');
        return json(200, { ok: true, note: 'runs from the next run (POST /stop, then /run)' });
      }
      if (a === 'project') {
        if (M === 'GET') return json(200, h.project());
        if (M === 'POST') {
          const problems = h.load(this.body(r));
          return json(problems.length && h.project().parts.length === 0 ? 400 : 200, { ok: true, problems });
        }
      }
      return err(404, `no ${M} ${r.path} (GET / lists what there is)`);
    } catch (e: any) {
      console.warn('[api] failed', e);
      return err(500, String(e?.message ?? e));
    }
  }
}

const HELP = `Bench Workshop control API (JSON, this PC only)

GET  /state                     mode, time, parts, boards
POST /run   /stop   /pause      start / stop / pause or resume
POST /step  {"seconds": 0.5}    pause and step exactly this long
GET  /parts/<uid or name>       position (cm), rotation, speed, spin
GET  /parts/<uid>/status        status lines, controls, pin volts
POST /parts/<uid>/control       {"label": "...", "value": ...}
POST /parts/<uid>/push          {"impulse": [x, y, z]}
GET  /serial/<uid>              what it printed
POST /serial/<uid>              text to type into its serial
GET  /project   POST /project   the bench as JSON / open one
POST /program/<uid>             {"source": "...", "lang": "arduino"}

Python:  import requests; requests.post("http://127.0.0.1:${API_PORT}/run")
`;
