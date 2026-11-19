// Library parts in a run. One sealed-off worker per library (lib/worker.ts) runs its code for all
// of its parts on the bench; each step it gets their pins' voltages and pin changes and sends back
// what they drive, what their screens show and their status. Its answers arrive one step later,
// which a display or a sensor never notices. I2C to a library chip is answered within a few steps.
import * as THREE from 'three';
import type { Circuit, Control, Device, I2CChip, Packet } from '../elec/circuit';
import { benchAudio } from './sound';
import { overVolt, sketchBoard, type DeviceHooks } from '../elec/devices';
import { motionOf } from '../elec/modules';
import type { PartView } from '../views';
import { drawScreen, screensOf, type LibPart, type Library } from './format';
import LibWorker from './worker.ts?worker';

type MotorCmd = [string, number, number]; // 'to' | 'power' | 'limp', value, volts
interface Out {
  drives?: Record<string, [number, number]>;
  screens?: Record<string, any[]>;
  status: string[];
  addr: number;
  cams?: Record<string, number>;
  motors?: Record<string, MotorCmd>;
  sound?: ([number, number, string] | null)[];
  sends?: [string, string, number[], number][];
  joins?: [string, string][];
  amps?: number;
  ranges?: string[];
  want?: { m?: 1; t?: string[]; l?: string[]; h?: 1 };
}

/** Renders a part camera's picture (set up by the app, which has the 3D scene): RGBA, top row first. */
export const cameraHook: { render: ((marker: import('three').Object3D, def: import('./format').LibCamera) => Uint8Array | null) | null } = { render: null };

class LibRun {
  worker: Worker;
  users = 0;
  ready = false;
  failed: string | null = null;
  outs = new Map<string, Out>();
  errors = new Map<string, string>();
  i2cWait = new Map<number, (r: { ok: boolean; data: number[] | null }) => void>();
  i2cId = 1;
  spiWait = new Map<number, (data: number[]) => void>();
  private sent = 0;
  private answered = 0;
  private lastAnswer = performance.now();

  constructor(public lib: Library, private log: (m: string, l?: 'info' | 'warn' | 'bad') => void) {
    this.worker = new LibWorker();
    this.worker.onmessage = (e) => this.msg(e.data);
    this.worker.onerror = (e) => {
      this.failed = e.message;
      this.log(`library "${lib.name}": ${e.message}`, 'bad');
    };
    this.worker.postMessage({ t: 'init', code: lib.code ?? '' });
  }
  private msg(m: any) {
    if (m.t === 'ready') {
      this.ready = true;
      console.info(`[library] ${this.lib.id} ${this.lib.version} running: devices ${m.devices.join(', ') || '(none)'}`);
    } else if (m.t === 'out') {
      this.answered++;
      this.lastAnswer = performance.now();
      for (const [uid, o] of Object.entries<Out>(m.parts)) {
        const prev = this.outs.get(uid);
        this.outs.set(uid, {
          ...o, drives: o.drives ?? prev?.drives, screens: o.screens, cams: o.cams ?? prev?.cams,
          motors: o.motors ?? prev?.motors, sound: o.sound ?? prev?.sound, joins: o.joins ?? prev?.joins, sends: undefined,
        });
        if (o.screens) this.onScreens.get(uid)?.(o.screens);
        if (o.sends?.length) this.onSends.get(uid)?.(o.sends);
        if (o.joins) this.onJoins.get(uid)?.();
        if (o.sound) o.sound.forEach((t, i) => benchAudio.set(`${uid}/${i}`, t));
      }
    } else if (m.t === 'i2c') {
      this.i2cWait.get(m.id)?.(m);
      this.i2cWait.delete(m.id);
    } else if (m.t === 'spi') {
      this.spiWait.get(m.id)?.(m.data ?? []);
      this.spiWait.delete(m.id);
    } else if (m.t === 'error') {
      if (m.uid) this.errors.set(m.uid, m.message);
      else this.failed = m.message;
      this.log(`library "${this.lib.name}": ${m.message}`, 'bad');
    } else if (m.t === 'log') console.info(`[library] ${this.lib.id} ${m.uid ?? ''}: ${m.message}`);
  }
  onScreens = new Map<string, (s: Record<string, any[]>) => void>();
  onSends = new Map<string, (s: [string, string, number[], number][]) => void>();
  onJoins = new Map<string, () => void>();
  step(c: Circuit, uid: string, input: any) {
    if (this.failed) return;
    // a library that stops answering (an endless loop?) is stopped, so the app doesn't wait forever
    if (this.sent > this.answered && performance.now() - this.lastAnswer > 3000) {
      this.failed = 'it stopped responding (an endless loop?) and was shut down';
      this.log(`library "${this.lib.name}": ${this.failed}`, 'bad');
      this.worker.terminate();
      for (const r of this.i2cWait.values()) r({ ok: false, data: null });
      this.i2cWait.clear();
      for (const r of this.spiWait.values()) r([]);
      this.spiWait.clear();
      return;
    }
    if (this.sent === this.answered) this.lastAnswer = performance.now();
    this.sent++;
    this.worker.postMessage({ t: 'step', time: c.time, parts: { [uid]: input } });
  }
  /** an SPI transfer to one of its parts: posted in order with everything else; the answer comes back
   *  (when the program waits for one) */
  spi(uid: string, bytes: number[], pins: Record<string, 0 | 1 | null>, reply: boolean) {
    if (this.failed) return reply ? Promise.resolve(new Array(bytes.length).fill(0xff)) : undefined;
    if (!reply) {
      this.worker.postMessage({ t: 'spi', id: 0, uid, bytes, pins });
      return undefined;
    }
    return new Promise<number[]>((resolve) => {
      const id = this.i2cId++;
      this.spiWait.set(id, resolve);
      this.worker.postMessage({ t: 'spi', id, uid, bytes, pins });
    });
  }
  i2c(uid: string, op: 'w' | 'r', arg: number[] | number) {
    return new Promise<{ ok: boolean; data: number[] | null }>((resolve) => {
      if (this.failed) return resolve({ ok: false, data: null });
      const id = this.i2cId++;
      this.i2cWait.set(id, resolve);
      this.worker.postMessage(op === 'w' ? { t: 'i2c', id, uid, op, bytes: arg } : { t: 'i2c', id, uid, op, n: arg });
    });
  }
  dispose() {
    this.worker.terminate();
    for (const r of this.i2cWait.values()) r({ ok: false, data: null });
    this.i2cWait.clear();
    for (const r of this.spiWait.values()) r([]);
    this.spiWait.clear();
  }
}

const runs = new Map<string, LibRun>();

/** The device of a library part (made when a run starts). */
export function libraryDevice(v: PartView, lib: Library, part: LibPart, hooks: DeviceHooks): Device {
  const uid = v.inst.uid;
  const log = hooks.log;
  const shorts = (part.shorts ?? []) as [string, string][];
  if (part.sketch) return sketchPart(v, part, shorts, hooks);
  if (!part.device) return { view: v, shorts: () => shorts }; // a passive board: just its copper
  let run = runs.get(lib.id);
  if (!run) runs.set(lib.id, (run = new LibRun(lib, log)));
  run.users++;
  const r = run;
  const screens = new Map([...v.bodies.values()].flatMap((b) => [...screensOf(b)])); // (bodies, not root: a run moves them)
  // its cameras: markers in its bodies (they ride along when it moves)
  const cameras = new Map<string, { obj: import('three').Object3D; def: import('./format').LibCamera; last: number }>();
  for (const b of v.bodies.values())
    b.traverse((o) => {
      const def = o.userData?.camera;
      if (def) cameras.set(def.id, { obj: o, def, last: -1 });
    });
  // its distance sensors: markers too
  const rangers = new Map<string, { obj: THREE.Object3D; def: import('./format').LibRanger; body: string }>();
  for (const [bname, b] of v.bodies)
    b.traverse((o) => {
      const def = o.userData?.ranger;
      if (def) rangers.set(def.id, { obj: o, def, body: bname });
    });
  // its light sensors' eyes: markers as well
  const lights = new Map<string, { obj: THREE.Object3D; def: { id: string; look?: [number, number, number]; fov: number }; last: number; lux: number }>();
  for (const b of v.bodies.values())
    b.traverse((o) => {
      const def = o.userData?.light;
      if (def) lights.set(def.id, { obj: o, def, last: -1, lux: 0 });
    });
  const touchIds = [...part.shape, ...(part.moving ?? []).flatMap((m) => m.shape)].filter((s) => typeof s.touch === 'string').map((s) => s.touch as string);
  let lastVel: THREE.Vector3 | null = null;
  const pinIds = (v.build.pins ?? []).map((p) => p.id);
  const moving = (part.moving ?? []).map((m) => ({ id: m.id, kind: m.joint.motor ?? 'free', slide: m.joint.type === 'slide', multi: m.joint.motor === 'servo' && m.joint.multiturn === true }));
  r.worker.postMessage({
    t: 'add', uid, device: part.device, name: v.inst.name, params: v.inst.params,
    motors: moving, controls: part.controls ?? [], sound: !!part.sound, pins: pinIds,
    touches: touchIds, lights: [...lights.keys()], hear: !!part.hear,
    screens: [...screens.values()].map((s) => ({ id: s.def.id, cols: s.def.px[0], rows: s.def.px[1], text: s.def.mode === 'text', rgb: s.def.mode === 'rgb' })),
    cameras: [...cameras.values()].map((cam) => ({ id: cam.def.id, w: cam.def.px[0], h: cam.def.px[1] })),
  });
  r.onScreens.set(uid, (data) => {
    for (const [id, cells] of Object.entries(data)) {
      const s = screens.get(id);
      if (!s) continue;
      const d = cells as unknown as { cells: any[]; lit: boolean };
      s.cells = d.cells;
      s.lit = d.lit;
      drawScreen(s);
    }
  });
  const pins = pinIds;
  const pulls = (v.build.pins ?? []).filter((p) => p.pulled).map((p) => [p.id, p.pulled === 'up'] as [string, boolean]);
  const supplyPins = (v.build.pins ?? []).filter((p) => p.kind === 'vin').map((p) => p.id);
  let edges: [string, 0 | 1][] = [];
  let packetsIn: Packet[] = [];
  let sendsOut: [string, string, number[], number][] = [];
  let rejoin = false;
  r.onSends.set(uid, (list) => { sendsOut.push(...list); });
  r.onJoins.set(uid, () => { rejoin = true; });
  const motorDefs = new Map(moving.map((m) => [m.id, m]));
  const tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpD = new THREE.Vector3();
  // the run panel's controls (library.json "controls"): they tell its code what you did
  const ctl = (id: string, extra: Record<string, unknown>) => r.worker.postMessage({ t: 'ctl', uid, id, ...extra });
  const controls: Control[] = [];
  for (const c of part.controls ?? []) {
    if (c.kind === 'slider') {
      let val = Number(c.value ?? c.min ?? 0);
      controls.push({ label: c.label, min: c.min ?? 0, max: c.max ?? 100, step: c.step ?? 1, get: () => val, set: (x) => { val = x; ctl(c.id, { value: x }); } });
    } else if (c.kind === 'switch') {
      let on = !!c.value;
      controls.push({ kind: 'switch', label: c.label, get: () => on, set: (x) => { on = x; ctl(c.id, { value: x }); } });
    } else if (c.kind === 'button') controls.push({ kind: 'button', label: c.label, press: (down) => ctl(c.id, { down }) });
    else if (c.kind === 'text') controls.push({ kind: 'text', label: c.label, send: (text) => ctl(c.id, { value: text }) });
    else for (const k of c.keys ?? []) controls.push({ kind: 'button', label: k, cols: c.cols, press: (down) => ctl(c.id, { key: k, down }) });
  }
  const hasBus = pins.includes('SDA') && pins.includes('SCL');
  const chip: I2CChip = {
    name: `${v.inst.name} (${lib.name})`,
    address: () => r.outs.get(uid)?.addr ?? -1,
    write: (bytes) => r.i2c(uid, 'w', bytes).then((x) => x.ok),
    read: (n) => r.i2c(uid, 'r', n).then((x) => (x.ok ? x.data : null)),
  };
  const blank = (s: (typeof screens extends Map<any, infer T> ? T : never)) => {
    s.cells = s.def.mode === 'text' ? Array.from({ length: s.def.px[1] }, () => ' '.repeat(s.def.px[0])) : new Array(s.def.px[0] * s.def.px[1]).fill(0);
    drawScreen(s);
  };
  const spi: Device['spi'] = part.spi
    ? { ...part.spi, transfer: (bytes, pinLv, reply) => r.spi(uid, bytes, pinLv, reply) }
    : undefined;
  return {
    view: v,
    spi,
    shorts: () => [...shorts, ...(r.outs.get(uid)?.joins ?? []).filter(([a, b]) => pins.includes(a) && pins.includes(b))],
    i2c: hasBus ? { sda: 'SDA', scl: 'SCL', chips: [chip] } : undefined,
    edges: (evs) => { edges.push(...evs); },
    packets: (list) => { if (packetsIn.length < 256) packetsIn.push(...list.slice(0, 256 - packetsIn.length)); },
    controls: () => controls,
    current: () => r.outs.get(uid)?.amps ?? 0,
    drive(c) {
      if (rejoin) { rejoin = false; c.dirty = true; } // (its own pins joined or parted: the nets change)
      // resistors on the part (library.json "pulled"): there from the first step, before its code
      // has run, pulling up to its own supply (or down to 0 V)
      if (pulls.length) {
        let vcc = 0;
        for (const p of supplyPins) vcc = Math.max(vcc, c.v(uid, p) ?? 0);
        for (const [pin, up] of pulls)
          if (!up) c.drive(uid, pin, { v: 0, strength: 0, src: `${v.inst.name} ${pin} pull-down` });
          else if (vcc > 0) c.drive(uid, pin, { v: vcc, strength: 0, src: `${v.inst.name} ${pin} pull-up` });
      }
      const o = r.outs.get(uid);
      for (const [pin, [volts, strength]] of Object.entries(o?.drives ?? {}))
        c.drive(uid, pin, { v: volts, strength: Math.max(0, Math.min(2, strength)) as 0 | 1 | 2, logic: strength === 1, src: `${v.inst.name} ${pin}` });
      for (const [pin, proto, data, baud] of sendsOut) c.send(uid, pin, proto, data, baud || undefined);
      sendsOut = [];
      // its moving pieces do what its code said (within what library.json says they can do)
      for (const [id, [mode, val, volts]] of Object.entries(o?.motors ?? {})) {
        const a = c.sim.actuators.find((x) => x.view === v && x.def.name === id);
        const def = motorDefs.get(id);
        if (!a || !def || a.spec.kind === 'free') continue;
        const vv = Math.min(Math.max(0, volts), a.spec.ratedVolts * 2);
        if (mode === 'limp') c.sim.driveActuator(a, a.target, 0, true);
        else if (mode === 'to' && (a.spec.kind === 'servo' || a.spec.kind === 'stepper')) c.sim.driveActuator(a, def.slide ? val : (val * Math.PI) / 180, vv, false);
        else if (mode === 'power' && a.spec.kind === 'motor') c.sim.driveActuator(a, val, vv, false);
      }
    },
    sense(c) {
      const vv: Record<string, number | null> = {}, lv: Record<string, 0 | 1 | null> = {};
      for (const p of pins) {
        vv[p] = c.v(uid, p);
        lv[p] = c.level(uid, p);
      }
      // the levels above were read when this step began; a program can change pins after that (they
      // arrive as edges): the last edge of a pin is its level now, or a part's catch-up would undo it
      for (const [p, val] of edges) lv[p] = val;
      const pwm: Record<string, { hz: number; duty: number }> = {};
      for (const p of pins) {
        const n = c.net(uid, p);
        if (n?.pwm) pwm[p] = n.pwm;
      }
      // where its moving pieces are
      const motors: Record<string, [number, number, boolean]> = {};
      for (const a of c.sim.actuators) {
        if (a.view !== v) continue;
        const def = motorDefs.get(a.def.name);
        if (!def) continue;
        const k = def.slide ? 1 : 180 / Math.PI;
        const pos = def.slide || a.spec.kind === 'servo' ? a.angle : a.total;
        motors[a.def.name] = [pos * k, a.speed * k, a.stallReported || a.stalledFor > 0.3];
      }
      // what its distance sensors see (only the ones its code asked about)
      const ranges: Record<string, number | null> = {};
      for (const id of r.outs.get(uid)?.ranges ?? []) {
        const rg = rangers.get(id);
        if (!rg) continue;
        rg.obj.updateWorldMatrix(true, false);
        tmpP.setFromMatrixPosition(rg.obj.matrixWorld);
        rg.obj.getWorldQuaternion(tmpQ);
        tmpD.set(...(rg.def.look ?? [1, 0, 0])).normalize().applyQuaternion(tmpQ);
        const d = c.sim.raycast(tmpP, tmpD, rg.def.max ?? 400, c.sim.rigidOf(uid, rg.body), uid);
        ranges[id] = d === null ? null : Math.round(d * 100) / 100;
      }
      // what else its code asked to know: how it moves, what touches it, light, sound
      const asked = r.outs.get(uid)?.want ?? {};
      let motion: any;
      if (asked.m) {
        const mo = motionOf(c, uid, 'body', lastVel);
        if (mo) {
          lastVel = mo.vel;
          const inv = mo.pose.quat.clone().invert();
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(inv);
          const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(mo.pose.quat);
          const r3 = (x: number) => Math.round(x * 1000) / 1000;
          motion = {
            accel: [r3(mo.accel.x), r3(mo.accel.y), r3(mo.accel.z)],
            gyro: [r3(mo.gyro.x), r3(mo.gyro.y), r3(mo.gyro.z)],
            up: [r3(up.x), r3(up.y), r3(up.z)],
            heading: r3((((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI) + 360) % 360),
            pos: [r3(mo.pose.pos.x), r3(mo.pose.pos.y), r3(mo.pose.pos.z)],
            vel: [r3(mo.vel.x), r3(mo.vel.y), r3(mo.vel.z)],
            speed: r3(mo.vel.length()),
            quat: [r3(mo.pose.quat.x), r3(mo.pose.quat.y), r3(mo.pose.quat.z), r3(mo.pose.quat.w)],
          };
        }
      }
      let touch: Record<string, [number, boolean, boolean]> | undefined;
      for (const id of asked.t ?? []) {
        const t = c.sim.touch(uid, id);
        (touch ??= {})[id] = [Math.round(t.force * 1000) / 1000, t.touching, t.hand];
      }
      let light: Record<string, number> | undefined;
      for (const id of asked.l ?? []) {
        const L = lights.get(id);
        if (!L || (L.last >= 0 && c.time - L.last < 0.1)) continue; // (10 looks a second)
        L.last = c.time;
        // the room's light (a lit room about 500 lux) by how much of its view is open: rays in its
        // cone; something close over it (a hand, a box) shades it
        L.obj.updateWorldMatrix(true, false);
        tmpP.setFromMatrixPosition(L.obj.matrixWorld);
        L.obj.getWorldQuaternion(tmpQ);
        const look = new THREE.Vector3(...(L.def.look ?? [0, 1, 0])).normalize().applyQuaternion(tmpQ);
        const side = Math.abs(look.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const u = new THREE.Vector3().crossVectors(look, side).normalize(), w2 = new THREE.Vector3().crossVectors(look, u);
        const half = ((L.def.fov / 2) * Math.PI) / 180;
        const exclude = c.sim.rigidOf(uid, 'body');
        let open = 0, n = 0;
        for (const [r, k] of [[0, 1], [0.6, 6], [1, 8]] as [number, number][])
          for (let i = 0; i < k; i++) {
            const a = (i / k) * Math.PI * 2, t = Math.tan(half * r);
            tmpD.copy(look).addScaledVector(u, Math.cos(a) * t).addScaledVector(w2, Math.sin(a) * t).normalize();
            const d = c.sim.raycast(tmpP, tmpD, 40, exclude, uid);
            open += d === null ? 1 : Math.min(1, 0.08 + d / 60); // (a near cover blocks it; light still gets round a far one)
            n++;
          }
        const room = (c.project.room ?? 1) * 500;
        // plus what glows in its view (LEDs, screens): the bright spots in a little picture from there
        let glow = 0;
        if (cameraHook.render) {
          const px = cameraHook.render(L.obj, { id, px: [8, 8], fov: L.def.fov, look: L.def.look ?? [0, 1, 0], range: 600 });
          if (px)
            for (let i = 0; i < 64; i++) {
              const lum = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
              glow += Math.max(0, lum - 0.55) / 0.45;
            }
        }
        L.lux = Math.round(room * (open / n) + (glow / 64) * 3000);
        (light ??= {})[id] = L.lux;
      }
      let hear: [number, number] | undefined;
      if (asked.h) {
        const me = c.sim.poseOf(uid);
        let level = 0, loud = 0, hz = 0;
        for (const [key, f, vol] of benchAudio.sounding()) {
          const src = c.sim.poseOf(key.slice(0, key.lastIndexOf('/')));
          const d = me && src ? me.pos.distanceTo(src.pos) : 1000;
          const l = vol / (1 + (d / 15) ** 2); // (half as loud 15 cm away, a quarter at 25 cm...)
          level += l;
          if (l > loud) { loud = l; hz = f; }
        }
        hear = [Math.min(1, Math.round(level * 1000) / 1000), loud > 0.002 ? Math.round(hz) : 0];
      }
      r.step(c, uid, { v: vv, lv, edges, packets: packetsIn, pwm, motors, ranges, motion, touch, light, hear });
      packetsIn = [];
      // pictures for cameras its code asked for (at the rate it asked, in simulation time)
      const want = r.outs.get(uid)?.cams;
      if (want && cameraHook.render)
        for (const [id, fps] of Object.entries(want)) {
          const cam = cameras.get(id);
          if (!cam || !(fps > 0) || (cam.last >= 0 && c.time - cam.last < 1 / Math.min(cam.def.px[0] * cam.def.px[1] <= 64 ? 60 : 15, fps) - 1e-9)) continue;
          cam.last = c.time;
          const px = cameraHook.render(cam.obj, cam.def);
          if (px) r.worker.postMessage({ t: 'frame', uid, id, w: cam.def.px[0], h: cam.def.px[1], time: c.time, data: px }, [px.buffer]);
        }
      edges = [];
    },
    status: () => {
      const err = r.errors.get(uid) ?? r.failed;
      if (err) return [`stopped: ${err}`];
      return r.outs.get(uid)?.status ?? ['starting...'];
    },
    dispose() {
      r.onScreens.delete(uid);
      r.onSends.delete(uid);
      r.onJoins.delete(uid);
      benchAudio.clear(`${uid}/`);
      for (const s of screens.values()) blank(s);
      if (--r.users <= 0) {
        r.dispose();
        runs.delete(lib.id);
      }
    },
  };
}

/** A library board with a microcontroller that runs Arduino-style sketches written in the app. */
function sketchPart(v: PartView, part: LibPart, shorts: [string, string][], hooks: DeviceHooks): Device {
  const uid = v.inst.uid;
  const s = part.sketch!;
  const vinPin = v.build.pins?.find((p) => p.id === s.power.vin);
  let burnt = false;
  const logicV = s.logicV ?? 3.3;
  return sketchBoard(v, {
    pins: s.pins,
    analog: s.analog ?? [],
    logicV,
    shorts,
    builtinLed: s.builtinLed,
    i2c: v.build.pins?.some((p) => p.id === 'SDA') && v.build.pins?.some((p) => p.id === 'SCL') ? { sda: 'SDA', scl: 'SCL' } : undefined,
    power(c) {
      if (s.usb && v.inst.params.usb !== false) return 1;
      const vin = c.supply(uid, s.power.vin, s.power.gnd);
      if (!burnt && vinPin && overVolt(c, v, vinPin, vin)) burnt = true;
      return !burnt && vin >= s.power.min ? 1 : 0;
    },
    drivePower(c, on) {
      if (on && s.usb && v.inst.params.usb !== false) c.drive(uid, s.power.gnd, { v: 0, strength: 3, src: `${v.inst.name} GND (USB)` });
    },
  }, hooks);
}
