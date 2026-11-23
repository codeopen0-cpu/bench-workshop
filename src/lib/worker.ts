// A library's code runs here, in its own thread, cut off from the app: no network, no storage, no
// page, no files. It only sees what its parts' pins see and can only drive its parts' pins, draw on
// their screens and answer on their I2C bus. Main thread side: lib/runtime.ts.
//
// The library's code registers devices by name:
//   bench.device('max7219', (part) => ({
//     step(io) { ... },            // every simulation step: io.v(pin), io.level(pin), io.supply(a, b), io.drive(pin, volts), io.release(pin), io.time
//     edges(events) { ... },       // pin changes in order since the last step: [[pin, 0|1], ...] (for clocked chips)
//     i2c: { address: 0x27, write(bytes) { return true }, read(n) { return [...] } },   // on its SDA/SCL pins
//     status() { return ['a line for the inspector'] },
//   }));
// part: { name, params, screen(id) -> { cols, rows, set(x, y, v), get(x, y), fill(v), clear(), print(col, row, text), light(on) },
//         camera(id) -> { width, height, want(fps), frame: { width, height, time, data (RGBA), get(x, y) } | null }, log(text),
//         motor(id) -> { kind, angle, speed, stalled, to(deg | cm, volts), power(-1..1, volts), limp() },   (its moving pieces)
//         sound(n = 0) -> { tone(hz, volume 0..1, wave), stop() },   (parts with "sound": true)
//         control(id) -> slider { value } / button { down, presses() } / switch { on } / text { take() } / keys { down, take() },
//         ranger(id) -> { distance }   (cm to the first thing along its beam, or null) }
// io also has: send(pin, proto, bytes, baud?) (a message along the wire), pwm(pin) -> { hz, duty } | null,
//   connect(pinA, pinB, on) (join two of its own pins, as a relay or a pressed key does), draw(amps)
// and the device can have packets(list) { ... }: messages that arrived [{ pin, proto, data, baud }]

type Drive = [number, number]; // volts, strength (0 pull, 1 logic, 2 power)
interface Inst {
  uid: string;
  dev: any;
  drives: Record<string, Drive>;
  drivesDirty: boolean;
  screens: Map<string, { cols: number; rows: number; text: boolean; rgb: boolean; cells: any; dirty: boolean; lit: boolean }>;
  cams: Map<string, Cam>;
  camsDirty: boolean;
  status: string[];
  failed: string | null;
  motors: Map<string, { kind: string; slide: boolean; pos: number; speed: number; stalled: boolean; cmd: [string, number, number] | null }>;
  motorsDirty: boolean;
  sounds: ([number, number, string] | null)[];
  soundDirty: boolean;
  canSound: boolean;
  ctls: Map<string, any>;
  ranges: Record<string, number | null>;
  sends: [string, string, number[], number][];
  joins: Map<string, [string, string]>;
  joinsDirty: boolean;
  amps: number;
  pins: Set<string>;
  /** what its code asked to know each step: its motion, its touch surfaces, light sensors, hearing */
  want: { m?: 1; t?: string[]; l?: string[]; h?: 1 };
  sense: { motion: any; touch: Record<string, [number, boolean, boolean]>; light: Record<string, number>; hear: [number, number] };
  touchIds: Set<string>;
  lightIds: Set<string>;
  canHear: boolean;
  lastScreenPost: number;
}

const realPost = (self as any).postMessage.bind(self); // (captured: library code never gets postMessage)
const post = (m: any) => realPost(m);

/** a picture from a part's camera: RGBA bytes, top row first, as the camera saw the bench at `time` */
interface Frame { width: number; height: number; data: Uint8Array; time: number }
interface Cam { width: number; height: number; fps: number; frame: Frame | null }
const makers = new Map<string, (part: any) => any>();
const insts = new Map<string, Inst>();

function seal() {
  // what library code must not reach: the network, storage, other code
  const g = self as any;
  for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'Worker', 'SharedWorker', 'BroadcastChannel', 'WebTransport', 'navigator', 'location', 'postMessage', 'addEventListener', 'removeEventListener', 'onmessage', 'WebAssembly']) {
    if (k === 'onmessage') {
      // keep our handler, but nobody can swap it for theirs
      const h = g.onmessage;
      try { Object.defineProperty(g, 'onmessage', { value: h, configurable: false, writable: false }); } catch { /* can't */ }
      continue;
    }
    try {
      Object.defineProperty(g, k, { value: undefined, configurable: false, writable: false });
    } catch {
      try { g[k] = undefined; } catch { /* can't */ }
    }
  }
}

/** a colour for an rgb screen: 0xRRGGBB, '#rrggbb' or [r, g, b] */
const rgbOf = (v: any): number => {
  if (typeof v === 'number') return v >>> 0 & 0xffffff;
  if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v)) return parseInt(v.replace('#', ''), 16);
  if (Array.isArray(v)) return ((v[0] & 255) << 16) | ((v[1] & 255) << 8) | (v[2] & 255);
  return v ? 0xffffff : 0;
};

const fail = (inst: Inst, e: any) => {
  inst.failed = String(e?.message ?? e);
  post({ t: 'error', uid: inst.uid, message: inst.failed });
};

/** an I2C transfer to one of its parts: [ok, bytes read] */
function doI2c(m: { uid: string; op: 'w' | 'r'; bytes?: number[]; n?: number }): { ok: boolean; data: number[] | null } {
  const inst = insts.get(m.uid);
  let ok = false, data: number[] | null = null;
  try {
    const bus = inst?.dev?.i2c;
    if (bus && !inst!.failed) {
      if (m.op === 'w') ok = bus.write ? !!bus.write(m.bytes ?? []) : true;
      else {
        data = bus.read ? Array.from(bus.read(m.n ?? 1) ?? [], (x: any) => Number(x) & 255) : null;
        ok = !!data;
      }
    }
  } catch (err) {
    if (inst) fail(inst, err);
  }
  return { ok, data };
}
/** an SPI transfer to one of its parts (its CS pin low): its answers, one per byte */
function doSpi(m: { uid: string; bytes: number[]; pins: any; id?: number }): number[] {
  const inst = insts.get(m.uid);
  let data: number[] = [];
  try {
    const bus = inst?.dev?.spi;
    if (bus?.transfer && !inst!.failed) {
      const r = bus.transfer(m.bytes, Object.freeze({ ...m.pins }));
      if (m.id) data = Array.from(r ?? [], (x: any) => Number(x) & 255);
    }
  } catch (err) {
    if (inst) fail(inst, err);
  }
  return data;
}

// The mailbox shared with the app (lib/runtime.ts): an I2C transfer, or an SPI one that wants
// answers, arrives here while the program that asked waits, and is answered at once (not through
// the app's message queue, which would hold it up until the app's next frame).
// ctl[0]: 0 empty, 1 a question waits, 2 its answer waits; ctl[1]: bytes of JSON in buf;
// ctl[2]: steps done (heartbeat); ctl[3]: 1 once its code has started.
let mail: { ctl: Int32Array; buf: Uint8Array } | null = null;
let spiDone = 0; // SPI messages without answers handled so far (a question comes after those sent before it)
let mailHeld: any = null;
const mailText = new TextDecoder(), mailBytes = new TextEncoder();
function answerMail(q: any) {
  const a = q.k === 'i2c' ? doI2c(q) : { data: doSpi({ ...q, id: 1 }) };
  const b = mailBytes.encode(JSON.stringify(a));
  mail!.buf.set(b.subarray(0, mail!.buf.length));
  Atomics.store(mail!.ctl, 1, Math.min(b.length, mail!.buf.length));
  Atomics.store(mail!.ctl, 0, 2);
  Atomics.notify(mail!.ctl, 0);
}
async function mailLoop() {
  const waitAsync = (Atomics as any).waitAsync as ((a: Int32Array, i: number, v: number) => { async: boolean; value: any }) | undefined;
  if (!mail || !waitAsync) return;
  for (;;) {
    const st = Atomics.load(mail.ctl, 0);
    if (st === 1 && !mailHeld) {
      const q = JSON.parse(mailText.decode(mail.buf.slice(0, Atomics.load(mail.ctl, 1))));
      if ((q.after ?? 0) > spiDone) mailHeld = q; // (answered once the SPI messages before it are in)
      else answerMail(q);
      continue;
    }
    const w = waitAsync(mail.ctl, 0, st); // (until it changes)
    if (w.async) await w.value;
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.t === 'init') {
    if (m.mail instanceof SharedArrayBuffer) {
      mail = { ctl: new Int32Array(m.mail, 0, 4), buf: new Uint8Array(m.mail, 16) };
      void mailLoop();
    }
    const bench = Object.freeze({
      device(name: string, make: (part: any) => any) {
        if (typeof name !== 'string' || typeof make !== 'function') throw new Error('bench.device(name, (part) => ({...}))');
        makers.set(name, make);
      },
    });
    seal();
    try {
      new Function('bench', '"use strict";\n' + m.code)(bench);
      post({ t: 'ready', devices: [...makers.keys()] });
      if (mail) Atomics.store(mail.ctl, 3, 1);
    } catch (err: any) {
      post({ t: 'error', message: `its code failed to start: ${err?.message ?? err}` });
    }
  } else if (m.t === 'add') {
    const inst: Inst = {
      uid: m.uid, dev: null, drives: {}, drivesDirty: true, screens: new Map(), cams: new Map(), camsDirty: false, status: [], failed: null,
      motors: new Map(), motorsDirty: false, sounds: [], soundDirty: false, canSound: !!m.sound, ctls: new Map(), ranges: {},
      sends: [], joins: new Map(), joinsDirty: false, amps: 0, pins: new Set(m.pins ?? []),
      want: {}, sense: { motion: null, touch: {}, light: {}, hear: [0, 0] }, touchIds: new Set(m.touches ?? []), lightIds: new Set(m.lights ?? []),
      canHear: !!m.hear, lastScreenPost: -1,
    };
    for (const mo of (m.motors ?? []) as { id: string; kind: string; slide: boolean }[])
      inst.motors.set(mo.id, { kind: mo.kind, slide: mo.slide, pos: 0, speed: 0, stalled: false, cmd: null });
    for (const c of (m.controls ?? []) as any[])
      inst.ctls.set(c.id, { def: c, value: c.kind === 'slider' ? Number(c.value ?? c.min ?? 0) : c.kind === 'switch' ? !!c.value : 0, down: c.kind === 'keys' ? new Set<string>() : false, presses: 0, queue: [] as string[] });
    insts.set(m.uid, inst);
    inst.cams = new Map();
    inst.camsDirty = false;
    for (const c of (m.cameras ?? []) as { id: string; w: number; h: number }[]) inst.cams.set(c.id, { width: c.w, height: c.h, fps: 0, frame: null });
    for (const s of m.screens as { id: string; cols: number; rows: number; text: boolean; rgb?: boolean }[])
      inst.screens.set(s.id, { cols: s.cols, rows: s.rows, text: s.text, rgb: !!s.rgb, cells: s.text ? Array.from({ length: s.rows }, () => ' '.repeat(s.cols)) : s.rgb ? new Uint32Array(s.cols * s.rows) as any : new Array(s.cols * s.rows).fill(0), dirty: true, lit: true });
    const make = makers.get(m.device);
    if (!make) return fail(inst, `the library has no device "${m.device}"`);
    const part = Object.freeze({
      name: m.name,
      params: Object.freeze({ ...m.params }),
      log: (text: any) => post({ t: 'log', uid: m.uid, message: String(text) }),
      /** a camera from library.json: want(fps) starts pictures, frame is the newest one */
      camera(id: string) {
        const c = inst.cams.get(id);
        if (!c) throw new Error(`this part has no camera "${id}"`);
        const frameApi = (f: Frame) => Object.freeze({
          width: f.width, height: f.height, time: f.time, data: f.data,
          /** [r, g, b] at (x, y), 0-255 */
          get: (x: number, y: number) => {
            const i = ((y | 0) * f.width + (x | 0)) * 4;
            return [f.data[i], f.data[i + 1], f.data[i + 2]];
          },
        });
        return Object.freeze({
          width: c.width,
          height: c.height,
          /** pictures this many times a second (simulation time; 15 at most, 60 for 64 pixels or fewer), 0 = stop */
          want(fps = 10) {
            // (tiny pictures, a line sensor's 4 x 4, are cheap: up to 60 a second; others 15)
            const f = Math.max(0, Math.min(c.width * c.height <= 64 ? 60 : 15, Number(fps) || 0));
            if (f !== c.fps) { c.fps = f; inst.camsDirty = true; }
          },
          get frame() { return c.frame ? frameApi(c.frame) : null; },
        });
      },
      /** a moving piece (library.json "moving"): read where it is, tell it where to go */
      motor(id: string) {
        const mo = inst.motors.get(id);
        if (!mo) throw new Error(`this part has no moving piece "${id}"`);
        const set = (cmd: [string, number, number]) => {
          const c = mo.cmd;
          if (!c || c[0] !== cmd[0] || Math.abs(c[1] - cmd[1]) > 1e-6 || Math.abs(c[2] - cmd[2]) > 0.01) { mo.cmd = cmd; inst.motorsDirty = true; }
        };
        const num = (x: any, d: number) => (Number.isFinite(Number(x)) ? Number(x) : d);
        return Object.freeze({
          kind: mo.kind,
          /** degrees (turning pieces; steppers and free axles count whole turns: 720 = two turns) or cm (sliding) */
          get angle() { return mo.pos; },
          get position() { return mo.pos; },
          /** degrees (or cm) per second */
          get speed() { return mo.speed; },
          /** it can't get where it was told (overloaded, or blocked) */
          get stalled() { return mo.stalled; },
          /** servo / stepper / slide: go to this angle (deg) or position (cm), with this many volts */
          to(v: number, volts = 5) { set(['to', num(v, 0), Math.max(0, num(volts, 0))]); },
          /** motor: spin, -1 (full reverse) .. 1 (full ahead), with this many volts */
          power(p: number, volts = 5) { set(['power', Math.max(-1, Math.min(1, num(p, 0))), Math.max(0, num(volts, 0))]); },
          /** no power: it turns freely (a servo with no signal, a motor's driver off) */
          limp() { set(['limp', 0, 0]); },
        });
      },
      /** a sound (library.json "sound": true): a tone that plays until stopped */
      sound(n = 0) {
        if (!inst.canSound) throw new Error('this part has no "sound": true in library.json');
        const i = Math.max(0, Math.min(1, n | 0)); // (two at once, at most)
        return Object.freeze({
          tone(hz: number, volume = 0.5, wave = 'square') {
            const w = ['square', 'sine', 'triangle', 'sawtooth'].includes(wave) ? wave : 'square';
            const v: [number, number, string] = [Math.max(20, Math.min(12000, Number(hz) || 0)), Math.max(0, Math.min(1, Number(volume) || 0)), w];
            const c = inst.sounds[i];
            if (!c || Math.abs(c[0] - v[0]) > 0.5 || Math.abs(c[1] - v[1]) > 0.01 || c[2] !== v[2]) { inst.sounds[i] = v; inst.soundDirty = true; }
          },
          stop() { if (inst.sounds[i]) { inst.sounds[i] = null; inst.soundDirty = true; } },
          get playing() { return !!inst.sounds[i]; },
        });
      },
      /** a control in the run panel (library.json "controls") */
      control(id: string) {
        const c = inst.ctls.get(id);
        if (!c) throw new Error(`this part has no control "${id}"`);
        const k = c.def.kind;
        if (k === 'slider') return Object.freeze({ get value() { return c.value as number; } });
        if (k === 'switch') return Object.freeze({ get on() { return !!c.value; } });
        if (k === 'button') return Object.freeze({
          get down() { return !!c.down; },
          /** how many times it was pressed since you last asked */
          presses() { const n = c.presses; c.presses = 0; return n; },
        });
        if (k === 'text') return Object.freeze({ /** lines typed and sent since you last asked */ take() { const q = c.queue; c.queue = []; return q; } });
        return Object.freeze({
          /** the keys held down now (their labels) */
          get down() { return [...(c.down as Set<string>)]; },
          isDown: (label: string) => (c.down as Set<string>).has(label),
          /** keys pressed since you last asked, in order */
          take() { const q = c.queue; c.queue = []; return q; },
        });
      },
      /** how the part moves (as a motion sensor glued to it feels it): accel [x, y, z] in g (1 g up
       *  when still), gyro [x, y, z] in deg/s, up (which way is up, in its own frame), heading (the
       *  compass direction its +x side faces: 0 north, 90 east), pos [x, y, z] cm on the bench, speed cm/s,
       *  quat [x, y, z, w] (how it is turned in the world; north is -z, up is +y) */
      motion() {
        if (!inst.want.m) inst.want.m = 1;
        return inst.sense.motion ?? Object.freeze({ accel: [0, 1, 0], gyro: [0, 0, 0], up: [0, 1, 0], heading: 0, pos: [0, 0, 0], vel: [0, 0, 0], speed: 0, quat: [0, 0, 0, 1], ready: false });
      },
      /** a touch surface ("touch" on a solid piece of its shape): what presses on it now */
      touch(id: string) {
        if (!inst.touchIds.has(id)) throw new Error(`this part has no touch surface "${id}"`);
        if (!(inst.want.t ??= []).includes(id)) inst.want.t.push(id);
        return Object.freeze({
          /** newtons pressing on it (a 100 g weight resting on it: about 1 N) */
          get force() { return inst.sense.touch[id]?.[0] ?? 0; },
          /** anything touches it */
          get touching() { return inst.sense.touch[id]?.[1] ?? false; },
          /** the hand touches it (a finger on a touch pad) */
          get hand() { return inst.sense.touch[id]?.[2] ?? false; },
        });
      },
      /** a light sensor's eye ("light" in its shape): lux reaching it (a lit room about 300-500, a
       *  dark one near 0; LEDs and screens it looks at add theirs) */
      light(id: string) {
        if (!inst.lightIds.has(id)) throw new Error(`this part has no light sensor "${id}"`);
        if (!(inst.want.l ??= []).includes(id)) inst.want.l.push(id);
        return Object.freeze({ get lux() { return inst.sense.light[id] ?? 0; } });
      },
      /** what it hears ("hear": true): level 0..1 (a buzzer right beside it is about 0.5) and the
       *  loudest tone's frequency (Hz, 0 = quiet) */
      hear() {
        if (!inst.canHear) throw new Error('this part has no "hear": true in library.json');
        inst.want.h = 1;
        return Object.freeze({ get level() { return inst.sense.hear[0]; }, get hz() { return inst.sense.hear[1]; } });
      },
      /** a distance sensor's beam (a "ranger" in its shape) */
      ranger(id: string) {
        if (!(id in inst.ranges)) inst.ranges[id] = null;
        return Object.freeze({ get distance() { return inst.ranges[id] ?? null; } });
      },
      screen(id: string) {
        const s = inst.screens.get(id);
        if (!s) throw new Error(`this part has no screen "${id}"`);
        return Object.freeze({
          cols: s.cols,
          rows: s.rows,
          set(x: number, y: number, v: any) {
            if (s.text || x < 0 || y < 0 || x >= s.cols || y >= s.rows) return;
            const i = (y | 0) * s.cols + (x | 0);
            const nv = s.rgb ? rgbOf(v) : typeof v === 'string' ? v : v ? 1 : 0;
            if (s.cells[i] !== nv) { s.cells[i] = nv; s.dirty = true; }
          },
          /** rgb screens: a w x h block of colours (0xRRGGBB, row by row) at (x, y): fast */
          pixels(x: number, y: number, w: number, h: number, colors: ArrayLike<number>) {
            if (!s.rgb) throw new Error('pixels(): only on a screen with "mode": "rgb"');
            let k = 0;
            for (let yy = y | 0; yy < (y | 0) + (h | 0); yy++)
              for (let xx = x | 0; xx < (x | 0) + (w | 0); xx++, k++)
                if (xx >= 0 && yy >= 0 && xx < s.cols && yy < s.rows) s.cells[yy * s.cols + xx] = (Number(colors[k]) || 0) >>> 0;
            s.dirty = true;
          },
          get: (x: number, y: number) => (s.text ? s.cells[y]?.[x] : s.cells[(y | 0) * s.cols + (x | 0)]),
          fill(v: any) {
            if (s.text) s.cells = s.cells.map(() => String(v ?? ' ')[0].repeat(s.cols));
            else s.cells.fill(s.rgb ? rgbOf(v) : typeof v === 'string' ? v : v ? 1 : 0);
            s.dirty = true;
          },
          clear() { this.fill(s.text ? ' ' : 0); },
          light(on: boolean) {
            if (s.lit !== !!on) { s.lit = !!on; s.dirty = true; }
          },
          print(col: number, row: number, text: string) {
            if (!s.text || row < 0 || row >= s.rows) return;
            const line = s.cells[row] as string;
            const t = String(text);
            const c = Math.max(0, col | 0);
            s.cells[row] = (line.slice(0, c) + t + line.slice(c + t.length)).slice(0, s.cols).padEnd(s.cols);
            s.dirty = true;
          },
        });
      },
    });
    try {
      inst.dev = make(part) ?? {};
    } catch (err) {
      fail(inst, err);
    }
  } else if (m.t === 'step') {
    const out: Record<string, any> = {};
    for (const [uid, inp] of Object.entries<any>(m.parts)) {
      const inst = insts.get(uid);
      if (!inst || inst.failed || !inst.dev) continue;
      const io = {
        time: m.time,
        v: (pin: string) => inp.v[pin] ?? null,
        level: (pin: string) => inp.lv[pin] ?? null,
        supply: (a: string, b: string) => (inp.v[a] == null || inp.v[b] == null ? 0 : inp.v[a] - inp.v[b]),
        drive(pin: string, volts: number, strength = 1) {
          const d = inst.drives[pin];
          if (!d || d[0] !== volts || d[1] !== strength) { inst.drives[pin] = [Number(volts) || 0, strength]; inst.drivesDirty = true; }
        },
        release(pin: string) {
          if (pin in inst.drives) { delete inst.drives[pin]; inst.drivesDirty = true; }
        },
        /** PWM on a pin (a passive buzzer hears tone()'s frequency this way), or null */
        pwm: (pin: string) => inp.pwm?.[pin] ?? null,
        /** a message along the wire on one of its pins: send('TX', 'uart', bytes, 9600) */
        send(pin: string, proto: string, data: ArrayLike<number>, baud?: number) {
          if (!inst.pins.has(pin)) throw new Error(`send: this part has no pin ${pin}`);
          if (inst.sends.length >= 64) return; // (more in one step are dropped)
          inst.sends.push([pin, String(proto), Array.from(data ?? [], (x) => Number(x) & 255).slice(0, 4096), Number(baud) || 0]);
        },
        /** join two of its own pins (a relay's contact, a pressed key), or part them (on = false) */
        connect(a: string, b: string, on = true) {
          if (!inst.pins.has(a) || !inst.pins.has(b)) throw new Error(`connect: this part has no pin ${inst.pins.has(a) ? b : a}`);
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (on && !inst.joins.has(key)) {
            if (inst.joins.size >= 64) throw new Error('connect: more than 64 joins at once');
            inst.joins.set(key, [a, b]);
            inst.joinsDirty = true;
          } else if (!on && inst.joins.delete(key)) inst.joinsDirty = true;
        },
        /** the current it takes from its supply now, in amps (batteries drain and sag by it) */
        draw(amps: number) { inst.amps = Math.max(0, Math.min(50, Number(amps) || 0)); },
      };
      for (const [id, st] of Object.entries<[number, number, boolean]>(inp.motors ?? {})) {
        const mo = inst.motors.get(id);
        if (mo) { mo.pos = st[0]; mo.speed = st[1]; mo.stalled = st[2]; }
      }
      for (const [id, d] of Object.entries<number | null>(inp.ranges ?? {})) inst.ranges[id] = d;
      if (inp.motion) inst.sense.motion = Object.freeze({ ...inp.motion, ready: true });
      if (inp.touch) inst.sense.touch = inp.touch;
      if (inp.light) Object.assign(inst.sense.light, inp.light);
      if (inp.hear) inst.sense.hear = inp.hear;
      try {
        if (inp.edges?.length) inst.dev.edges?.(inp.edges);
        if (inp.packets?.length) inst.dev.packets?.(inp.packets);
        inst.dev.step?.(io);
        inst.status = inst.dev.status ? (inst.dev.status() ?? []).map(String) : [];
      } catch (err) {
        fail(inst, err);
        continue;
      }
      const o: any = { status: inst.status };
      const a = inst.dev.i2c?.address;
      o.addr = typeof a === 'function' ? Number(a()) : typeof a === 'number' ? a : -1;
      if (inst.drivesDirty) { o.drives = inst.drives; inst.drivesDirty = false; }
      if (inst.camsDirty) { o.cams = Object.fromEntries([...inst.cams].map(([id, c]) => [id, c.fps])); inst.camsDirty = false; }
      if (inst.motorsDirty) { o.motors = Object.fromEntries([...inst.motors].filter(([, mo]) => mo.cmd).map(([id, mo]) => [id, mo.cmd])); inst.motorsDirty = false; }
      if (inst.soundDirty) { o.sound = inst.sounds.slice(0, 2); inst.soundDirty = false; }
      if (inst.sends.length) { o.sends = inst.sends; inst.sends = []; }
      if (inst.joinsDirty) { o.joins = [...inst.joins.values()]; inst.joinsDirty = false; }
      o.amps = inst.amps;
      o.ranges = Object.keys(inst.ranges);
      o.want = inst.want;
      // (big colour screens: at most 30 pictures a second of simulation time)
      const rgbDue = m.time - inst.lastScreenPost >= 1 / 30;
      for (const [id, s] of inst.screens) {
        if (!s.dirty || (s.rgb && !rgbDue)) continue;
        (o.screens ??= {})[id] = { cells: s.cells.slice(), lit: s.lit };
        s.dirty = false;
        if (s.rgb) inst.lastScreenPost = m.time;
      }
      out[uid] = o;
    }
    post({ t: 'out', parts: out });
    // (a heartbeat the app reads straight from shared memory: its messages can sit unread while the
    // app is busy stepping, which made a working library look stuck)
    if (mail) Atomics.add(mail.ctl, 2, 1);
  } else if (m.t === 'ctl') {
    // the run panel: a control was used
    const c = insts.get(m.uid)?.ctls.get(m.id);
    if (!c) return;
    const k = c.def.kind;
    if (k === 'slider') c.value = Number(m.value) || 0;
    else if (k === 'switch') c.value = !!m.value;
    else if (k === 'button') { if (m.down && !c.down) c.presses++; c.down = !!m.down; }
    else if (k === 'text') { if (c.queue.length < 100) c.queue.push(String(m.value ?? '').slice(0, 1000)); }
    else if (k === 'keys') {
      const label = String(m.key);
      if (m.down) { (c.down as Set<string>).add(label); if (c.queue.length < 100) c.queue.push(label); }
      else (c.down as Set<string>).delete(label);
    }
  } else if (m.t === 'frame') {
    const c = insts.get(m.uid)?.cams?.get(m.id);
    if (c) c.frame = { width: m.w, height: m.h, data: new Uint8Array(m.data.buffer ?? m.data), time: m.time };
  } else if (m.t === 'spi') {
    // a board's SPI transfer while this part's CS pin is low: its answers (one per byte)
    const data = doSpi(m);
    if (m.id) post({ t: 'spi', id: m.id, data });
    else {
      spiDone++;
      if (mailHeld && (mailHeld.after ?? 0) <= spiDone) {
        const q = mailHeld;
        mailHeld = null;
        answerMail(q);
      }
    }
  } else if (m.t === 'i2c') {
    const r = doI2c(m);
    post({ t: 'i2c', id: m.id, ok: r.ok, data: r.data });
  }
};
