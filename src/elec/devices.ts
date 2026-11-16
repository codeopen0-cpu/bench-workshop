// What each electronic part DOES while running: reads its pins' voltages, drives its outputs, moves
// its motors, and complains (once) when it's wired wrong.
import * as THREE from 'three';
import { MAKER_PINS } from '../parts/electronics';
import type { PinDef } from '../parts/types';
import type { Program, Project } from '../project';
import { arduinoToJs } from '../sketch/arduino';
import { SketchHost } from '../sketch/host';
import { CTL, IN_EVENTS, MODE, SPI_SNAP } from '../sketch/layout';
import type { PartView } from '../views';
import type { Circuit, Device, I2CChip } from './circuit';

export interface DeviceHooks {
  serial(uid: string, text: string): void;
  log(msg: string, level?: 'info' | 'warn' | 'bad'): void;
  /** the program for a programmable part */
  program(uid: string): Program | undefined;
  /** a program stopped with an error (line in its source, if known) */
  error?(uid: string, line: number | null, message: string): void;
  /** the bench's Wi-Fi network (for boards that have Wi-Fi) */
  net?: import('../net/wifi').BenchNetwork;
}

export const name = (v: PartView) => v.inst.name;
const ipToInt = (ip: string) => ip.split('.').reduce((a, b) => ((a << 8) | (Number(b) & 255)) >>> 0, 0) | 0;
const wifiLine = (i: { status: number; ip: string; ap: string | null; server: { httpPort: number } | null } | null | undefined) => {
  if (!i) return 'Wi-Fi: off';
  const net = i.ap ? `its own network "${i.ap}", ${i.ip}` : i.status === 3 ? `connected, ${i.ip}` : i.status === 4 ? 'wrong password' : i.status === 1 ? 'no such network' : 'connecting...';
  return `Wi-Fi: ${net}${i.server ? `, web server on port ${i.server.httpPort}` : ''}`;
};

/** Sketch libraries ("#include <LedControl.h>"): filled in by the library store (lib/store.ts). */
export const sketchLibraries = {
  resolve: (includes: string[]): { libs: { name: string; code: string; exports: string[] }[]; classes: string[]; missing: string[] } => ({ libs: [], classes: [], missing: includes }),
};
const BUILTIN_INCLUDES = /^(Arduino|Wire|Servo|SPI|SoftwareSerial|HardwareSerial|math|stdint|stdio|stdlib|string|EEPROM|pgmspace|WiFi|WiFiS3|WiFiNINA|WiFi101|WebServer|ESPmDNS|WiFiClient|WiFiServer|Preferences|esp32-hal-ledc|avr\/.*)\.h$/;
export const lensMeshes = (v: PartView, flag: string) => {
  const out: THREE.Mesh[] = [];
  for (const b of v.bodies.values()) b.traverse((m) => m.userData[flag] && (m as THREE.Mesh).isMesh && out.push(m as THREE.Mesh));
  return out;
};
export const glow = (meshes: THREE.Mesh[], amount: number, color?: string) => {
  for (const m of meshes) {
    const mat = m.material as THREE.MeshStandardMaterial;
    if (color) mat.emissive.set(color);
    else mat.emissive.copy(mat.color);
    mat.emissiveIntensity = amount * 2.5;
  }
};

// ------------------------------------------------------------------------------------------ power


/** a "vin" pin over its rating: the part is burnt from then on (until the run restarts) */
/** A board whose supply sags below what it needs while it was running: a brown-out (motors starting
 *  on a weak battery, mostly). Say so once, with the numbers, instead of a bare "no power". */
const wasOn = new Map<string, boolean>();
export function brownOut(c: Circuit, v: PartView, on: boolean, volts: number, needs: number, pin = 'VIN') {
  const uid = v.inst.uid;
  if (wasOn.get(uid) && !on && volts > needs * 0.4)
    c.warnOnce(`brown:${uid}`, `${name(v)} browned out: its ${pin} sagged to ${volts.toFixed(2)} V, below the ${needs} V it needs, so it restarted. A battery sags when motors start (more when it's small or getting flat): use a bigger one (2x 18650 or 6x AA), or power the board from its own battery.`, 'bad');
  wasOn.set(uid, on);
}

export function overVolt(c: Circuit, v: PartView, pin: PinDef, volts: number) {
  if (pin.vmax !== undefined && volts > pin.vmax) {
    c.warnOnce(`burn:${v.inst.uid}`, `${name(v)} burnt out: ${volts.toFixed(1)} V on its ${pin.label ?? pin.id} pin (it takes ${pin.vmin ?? 0}-${pin.vmax} V). In real life it would be dead now.`, 'bad');
    return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------ simple parts

export function ledDevice(v: PartView): Device {
  const lens = lensMeshes(v, 'lens');
  let lit = 0, burnt = false;
  return {
    view: v,
    sense(c) {
      const a = c.avg(v.inst.uid, 'A'), k = c.avg(v.inst.uid, 'K');
      const grounded = c.v(v.inst.uid, 'K') !== null && c.v(v.inst.uid, 'A') !== null;
      const dv = grounded ? a - k : 0;
      if (dv > 13 && !burnt) {
        burnt = true;
        c.warnOnce(`burn:${v.inst.uid}`, `${name(v)} burnt out: ${dv.toFixed(1)} V across it (its built-in resistor is meant for up to 12 V)`, 'bad');
      }
      if (dv < -0.5) c.warnOnce(`rev:${v.inst.uid}`, `${name(v)} is wired backwards: A (long leg) must go to the + side`);
      lit = burnt || dv < 1.8 ? 0 : Math.min(1, (dv - 1.6) / 1.4);
      glow(lens, lit);
    },
    status: () => [burnt ? 'burnt out' : lit > 0 ? `lit (${Math.round(lit * 100)}%)` : 'off'],
    current: () => lit * 0.012,
    dispose: () => glow(lens, 0),
  };
}

export function buttonDevice(v: PartView): Device {
  let pressed = false;
  const cap = lensMeshes(v, 'cap');
  return {
    view: v,
    shorts: () => (pressed ? [['1', '2']] : []),
    press(down) { // (the app rebuilds the nets after a press)
      pressed = down;
      for (const m of cap) m.position.y = down ? 0.38 : 0.5;
    },
    status: () => [pressed ? 'pressed' : 'released (click it to press)'],
  };
}

export function knobDevice(v: PartView): Device {
  let pos = (v.inst.params.start ?? 50) / 100;
  return {
    view: v,
    drive(c) {
      const lo = c.v(v.inst.uid, 'L'), hi = c.v(v.inst.uid, 'H');
      if (lo === null || hi === null) return;
      c.drive(v.inst.uid, 'W', { v: lo + (hi - lo) * pos, strength: 1, src: `${name(v)} W` });
    },
    status: () => [`turned to ${Math.round(pos * 100)}%`],
    controls: () => [{ label: 'Turned to (%)', min: 0, max: 100, step: 1, get: () => pos * 100, set: (x) => (pos = x / 100) }],
  };
}

export function drv8833Device(v: PartView): Device {
  const pinVM = v.build.pins!.find((p) => p.id === 'VM')!;
  let powered = false, burnt = false;
  let cRef: Circuit | null = null, devRef: Device | null = null;
  const dev: Device = {
    view: v,
    drive(c) {
      cRef = c;
      const vm = c.supply(v.inst.uid, 'VM', 'GND');
      if (!burnt && overVolt(c, v, pinVM, vm)) burnt = true;
      powered = !burnt && vm >= 2.7;
      if (!powered) return;
      for (const [i1, i2, o1, o2] of [['AIN1', 'AIN2', 'AOUT1', 'AOUT2'], ['BIN1', 'BIN2', 'BOUT1', 'BOUT2']]) {
        for (const [inp, out] of [[i1, o1], [i2, o2]]) {
          const n = c.net(v.inst.uid, inp);
          const on = n?.v !== null && n?.v !== undefined && n.v >= 1.5;
          c.drive(v.inst.uid, out, { v: on ? vm : 0, strength: 2, src: `${name(v)} ${out}`, pwm: on && n?.pwm ? n.pwm : undefined });
        }
      }
    },
    status: () => [burnt ? 'burnt out' : powered ? 'powered' : 'no motor power on VM'],
    current: () => (powered && cRef && devRef ? 0.002 + outputLoad(cRef, devRef, v.inst.uid, ['AOUT1', 'AOUT2', 'BOUT1', 'BOUT2']) : 0),
  };
  devRef = dev;
  return dev;
}

/** what the parts on a driver's outputs draw (its motors), so a battery feeding the driver feels them */
function outputLoad(c: Circuit, self: Device, uid: string, outs: string[]) {
  let a = 0;
  const seen = new Set<Device>();
  for (const o of outs) {
    const net = c.net(uid, o);
    if (!net) continue;
    for (const d of c.devices)
      if (d !== self && !seen.has(d) && d.current && net.pins.some((k) => k.startsWith(d.view.inst.uid + '/'))) {
        seen.add(d);
        a += d.current();
      }
  }
  return a;
}

/** L298N: two H-bridges. Per motor: ENx on (HIGH, PWM, or its jumper) lets INa/INb set the outputs;
 *  ENx off leaves them open (the motor coasts). Its old-style transistors lose ~1 V on each side. */
export function l298nDevice(v: PartView): Device {
  const uid = v.inst.uid;
  const pinVS = v.build.pins!.find((p) => p.id === '12V')!;
  let powered = false, burnt = false, vs = 0, load = 0;
  const dev: Device = {
    view: v,
    drive(c) {
      vs = c.supply(uid, '12V', 'GND');
      if (!burnt && overVolt(c, v, pinVS, vs)) burnt = true;
      powered = !burnt && vs >= 4.5;
      if (!powered) return;
      if (vs >= 7) c.drive(uid, '5V', { v: 5, strength: 2, src: `${name(v)} 5V (its regulator)` });
      for (const [en, ia, ib, oa, ob] of [['ENA', 'IN1', 'IN2', 'OUT1', 'OUT2'], ['ENB', 'IN3', 'IN4', 'OUT3', 'OUT4']]) {
        const e = c.net(uid, en);
        const enOn = v.inst.params.jumpers ? 1 : e?.v != null && e.v >= 2.3 ? (e.pwm ? e.pwm.duty : 1) : 0;
        const enHz = !v.inst.params.jumpers && e?.pwm ? e.pwm.hz : 1000;
        if (!enOn) continue; // open: the motor coasts
        for (const [inp, out] of [[ia, oa], [ib, ob]]) {
          const n = c.net(uid, inp);
          const high = n?.v != null && n.v >= 2.3;
          const duty = enOn * (high && n?.pwm ? n.pwm.duty : 1);
          const volts = high ? Math.max(0, vs - 1.0) : 1.0; // ~1 V lost in the top or the bottom transistor
          c.drive(uid, out, { v: volts, strength: 2, src: `${name(v)} ${out}`, pwm: duty < 0.999 ? { hz: enHz, duty } : undefined });
        }
      }
    },
    sense(c) {
      load = outputLoad(c, dev, uid, ['OUT1', 'OUT2', 'OUT3', 'OUT4']);
      if (powered && vs < 6.5) c.warnOnce(`low:${uid}`, `${name(v)} gets ${vs.toFixed(1)} V: it loses ~2 V inside, so the motors get ~${Math.max(0, vs - 2).toFixed(1)} V. TT motors want 4.5-6 V: give it 7-9 V (two Li-ion cells, or 6 AA).`);
    },
    status: () => [burnt ? 'burnt out' : powered ? `powered, ${vs.toFixed(1)} V in (motors get ~${Math.max(0, vs - 2).toFixed(1)} V)` : 'no motor power on 12V', ...(powered ? [`${(load * 1000).toFixed(0)} mA to the motors`] : [])],
    current: () => (powered ? 0.036 + load : 0),
  };
  return dev;
}

// ------------------------------------------------------------------------------------------ motion

export function servoDevice(v: PartView): Device {
  const pinV = v.build.pins!.find((p) => p.id === 'V+')!;
  let burnt = false, pulse = 0, volts = 0;
  let actuatorRef: ReturnType<Circuit['sim']['actuatorOf']>;
  return {
    view: v,
    sense(c, _dt) {
      const uid = v.inst.uid;
      if (!c.wired(uid, 'GND') && !c.wired(uid, 'V+') && !c.wired(uid, 'SIG')) return; // not wired: the run panel's slider drives it
      const a = c.sim.actuatorOf(uid);
      actuatorRef = a;
      if (!a) return;
      volts = c.supply(uid, 'V+', 'GND');
      if (!burnt && overVolt(c, v, pinV, volts)) burnt = true;
      const n = c.net(uid, 'SIG');
      pulse = n?.pwm && n.v !== null && n.v >= 2 && n.pwm.hz >= 30 && n.pwm.hz <= 400 ? (n.pwm.duty / n.pwm.hz) * 1e6 : 0;
      const ok = !burnt && volts >= 3.5 && pulse >= 400 && pulse <= 2600;
      if (volts >= 3.5 && !burnt && !pulse && c.time > 0.5) c.warnOnce(`nosig:${uid}`, `${name(v)} has power but no signal pulses on its orange wire: attach a Servo to that pin and write() an angle`);
      const angle = ((pulse - 1500) / 1000) * (Math.PI / 2);
      c.sim.driveActuator(a, ok ? angle : a.target, volts, !ok);
    },
    status: () => [burnt ? 'burnt out' : volts < 3.5 ? 'no power' : pulse ? `pulse ${Math.round(pulse)} us` : 'no signal (limp)', `${volts.toFixed(1)} V`],
    current() { // typical hobby-servo draw: idle, moving, stalled (scaled to its size)
      if (burnt || volts < 3.5) return 0;
      const a = actuatorRef;
      const big = (a?.spec.maxTorque ?? 2) > 5;
      if (!a || a.limp) return 0.005;
      if (a.stalledFor > 0.05 || Math.abs(a.cmd - a.angle) > 0.2) return big ? 2.5 : 0.65;
      return Math.abs(a.speed) > 0.3 ? (big ? 0.5 : 0.18) : 0.012;
    },
  };
}

export function motorDevice(v: PartView): Device {
  let volts = 0, rpmFrac = 0;
  return {
    view: v,
    sense(c) {
      const uid = v.inst.uid;
      if (!c.wired(uid, 'M+') && !c.wired(uid, 'M-')) return;
      const a = c.sim.actuatorOf(uid);
      if (!a) return;
      for (const p of ['M+', 'M-']) {
        const n = c.net(uid, p);
        if (n?.top?.logic && n.v && n.v > 0) {
          c.warnOnce(`logic:${uid}`, `${name(v)} is wired straight to ${n.top.src}: a logic pin gives ~20 mA, a motor needs ~250 mA+. Use a motor driver (DRV8833) between them.`);
          volts = 0;
          return c.sim.driveActuator(a, 0, 0, true);
        }
      }
      volts = c.avg(uid, 'M+') - c.avg(uid, 'M-');
      if (Math.abs(volts) > 9) c.warnOnce(`over:${uid}`, `${name(v)} gets ${Math.abs(volts).toFixed(1)} V: TT motors are for 3-6 V; it will run hot and wear fast`);
      c.sim.driveActuator(a, Math.sign(volts), Math.abs(volts), Math.abs(volts) < 0.2);
      rpmFrac = Math.min(1, Math.abs(a.speed) / Math.max(1, a.spec.speed * (Math.abs(volts) / a.spec.ratedVolts)));
    },
    status: () => [`${volts.toFixed(1)} V`],
    current: () => (Math.abs(volts) < 0.2 ? 0 : 0.8 * (Math.abs(volts) / 6) * (1 - 0.85 * rpmFrac)), // stall ~0.8 A at 6 V, ~0.12 A free-running
  };
}

// ------------------------------------------------------------------------------------------ sensors

export function hcsr04Device(v: PartView): Device {
  const pinV = v.build.pins!.find((p) => p.id === 'VCC')!;
  let lastRises = -1, lastTrig = -1, distance: number | null = null, powered = false, burnt = false;
  const dev: Device & { pulseOn(pin: string, level: number): number } = {
    view: v,
    drive(c) { // ECHO is LOW between pulses (the sensor drives it)
      if (powered) c.drive(v.inst.uid, 'ECHO', { v: 0, strength: 1, src: `${name(v)} ECHO`, logic: true });
    },
    sense(c) {
      const uid = v.inst.uid;
      const vcc = c.supply(uid, 'VCC', 'GND');
      if (!burnt && overVolt(c, v, pinV, vcc)) burnt = true;
      powered = !burnt && vcc >= 4.5;
      if (vcc > 2.5 && vcc < 4.5) c.warnOnce(`low:${uid}`, `${name(v)} gets only ${vcc.toFixed(1)} V: the HC-SR04 needs 5 V (its 3.3 V cousin is the RCWL-1601)`);
      const trig = c.net(uid, 'TRIG');
      const rises = trig?.top?.rises ?? 0;
      if (rises !== lastRises) {
        if (lastRises >= 0 && powered) lastTrig = c.time;
        lastRises = rises;
      }
      // measure along the eyes' direction (+Y of the part)
      const body = v.bodies.get('body')!;
      body.updateWorldMatrix(true, false);
      const origin = new THREE.Vector3(0, 1.4, 0).applyMatrix4(body.matrixWorld);
      const dir = new THREE.Vector3(0, 1, 0).transformDirection(body.matrixWorld);
      const d = c.sim.raycast(origin, dir, 400, c.sim.rigidOf(uid, 'body'));
      distance = d === null ? null : d + 0.2;
    },
    pulseOn(pin, level) {
      if (pin !== 'ECHO' || level !== 1 || !powered || lastTrig < 0) return 0;
      if (distance === null || distance > 400) return 38000; // no echo: the sensor gives up after 38 ms
      return Math.max(2, distance) * 58;
    },
    status: () => [burnt ? 'burnt out' : !powered ? 'no power (needs 5 V)' : distance === null ? 'nothing within 4 m' : `sees ${distance.toFixed(1)} cm`],
  };
  return dev;
}

// ------------------------------------------------------------------------------------------ programmable boards

export interface BoardSpec {
  pins: Record<string, number>; // pin id -> program pin number
  analog: string[]; // pin ids with an ADC
  logicV: number; // output high voltage
  power(c: Circuit): number; // the board's own supply (0 = off)
  drivePower(c: Circuit, on: boolean): void; // its regulators / USB
  i2c?: { sda: string; scl: string };
  /** what #if in its sketches sees (ESP32: 1, ESP_ARDUINO_VERSION_MAJOR: 3...); programs see them too */
  defines?: Record<string, number>;
  /** its SPI pins (pin ids): SPI.transfer reaches the SPI parts wired to them */
  spi?: { sck: string; mosi: string; miso: string; ss?: string };
  constants?: Record<string, number>;
  builtinLed?: number; // pin number lighting the onboard LED
  shorts?: [string, string][]; // pins joined on the board itself (its GND pins...)
  /** chips on the board's own I2C bus (answered before anything wired to it) */
  internalChips?: I2CChip[];
  /** each step, with the program's pin state: for the board's own wiring (enables, buttons, sensors) */
  onStep?(sh: import('../sketch/layout').Shared, c: Circuit, phase: 'drive' | 'sense'): void;
  /** it has Wi-Fi (an ESP32): its programs get WiFi, WebServer, WiFiServer */
  wifi?: boolean;
  /** its WiFi.begin waits until connected (UNO R4 WiFi style) instead of returning at once (ESP32) */
  wifiWaits?: boolean;
}

/** A board running a program (in its own thread). Drives its pins from the program, feeds inputs back. */
export function sketchBoard(v: PartView, spec: BoardSpec, hooks: DeviceHooks): Device {
  const uid = v.inst.uid;
  const byNum = new Map(Object.entries(spec.pins).map(([id, n]) => [n, id]));
  const ledMeshes = lensMeshes(v, 'builtinLed');
  let host: SketchHost | null = null;
  let running = false, crashed = false;
  const prog = hooks.program(uid);
  const start = (c: Circuit) => {
    if (!prog || !prog.source.trim()) {
      c.warnOnce(`noprog:${uid}`, `${name(v)} has power but no program: select it and press Program`);
      return;
    }
    let code = prog.source;
    const includes = [...code.matchAll(/^\s*(?:\/\/\s*)?#\s*include\s*[<"]([^>"]+)[>"]/gm)].map((m) => m[1]).filter((x) => !BUILTIN_INCLUDES.test(x));
    const libs = sketchLibraries.resolve(includes);
    for (const m of libs.missing) c.warnOnce(`inc:${uid}:${m}`, `${name(v)}'s program includes ${m}, which no installed library has: find it under Libraries`, 'bad');
    if (prog.lang === 'arduino') code = arduinoToJs(code, [...libs.classes, 'WebServer', 'IPAddress', 'WiFiServer', 'WiFiClient', 'SoftwareSerial', 'Preferences'], { ARDUINO: 10819, ...spec.defines });
    else code = code.replace(/^\s*#\s*include.*$/gm, '');
    const constants: Record<string, number> = { ...spec.defines, ...spec.constants };
    for (const [id, n] of Object.entries(spec.pins)) if (/^[A-Za-z_]\w*$/.test(id) && !/^GP\d+$/.test(id)) constants[id] = n;
    for (const [id, n] of Object.entries(spec.pins)) {
      const m = /^GP(\d+)$/.exec(id);
      if (m) constants[`D${m[1]}`] = n;
    }
    if (spec.builtinLed !== undefined) constants.LED_BUILTIN = spec.builtinLed;
    if (spec.spi) {
      constants.SCK = spec.pins[spec.spi.sck];
      constants.MOSI = spec.pins[spec.spi.mosi];
      constants.MISO = spec.pins[spec.spi.miso];
      if (spec.spi.ss) constants.SS = spec.pins[spec.spi.ss];
    }
    host = new SketchHost(code, constants, spec.analog.map((id) => spec.pins[id]), libs.libs, {
      serial: (t) => hooks.serial(uid, t),
      error: (msg, line) => {
        crashed = true;
        hooks.error?.(uid, line, msg);
        hooks.log(`${name(v)}'s program stopped with an error${line ? ` on line ${line}` : ''}: ${msg}`, 'bad');
        hooks.serial(uid, `\n[program stopped: ${msg}${line ? ` (line ${line})` : ''}]\n`);
      },
      warn: (msg) => c.warnOnce(`w:${uid}:${msg}`, `${name(v)}: ${msg}`),
      state: (s) => s === 'loop' && hooks.log(`${name(v)}: program running (setup() done)`),
    }, !!spec.wifi, !!spec.wifiWaits);
    running = true;
    wifiShown = '';
  };
  const stop = () => {
    host?.terminate();
    host = null;
    running = false;
  };
  let lastPowered = false;
  let dropWarned = false;
  let wifiShown = '';
  /** the chip answering at addr on this board's bus; two answering = a clash (reported once) */
  const chipAt = (c: Circuit, addr: number): I2CChip | 'clash' | undefined => {
    const all = [...(spec.internalChips ?? []), ...(spec.i2c ? c.i2cChips(uid, spec.i2c.sda, spec.i2c.scl) : [])].filter((x) => x.address() === addr);
    if (all.length > 1) {
      c.warnOnce(`clash:${uid}:${addr}`, `Two chips answer at I2C address 0x${addr.toString(16).toUpperCase()} (${all.map((x) => x.name).join(' and ')}): neither can be used. Change one's address jumper.`, 'bad');
      return 'clash';
    }
    return all[0];
  };
  /** SPI: the level of another part's pin as this program sees it now (from the levels it sent with
   *  the bytes, when one of this board's pins drives that wire), else as the wire was last step */
  const levelFor = (c: Circuit, snap: number[], devUid: string, pin: string): 0 | 1 | null => {
    const net = c.net(devUid, pin);
    if (!net) return null;
    for (const k of net.pins) {
      if (!k.startsWith(uid + '/')) continue;
      const n = spec.pins[k.slice(uid.length + 1)];
      if (n === undefined || !host) continue;
      const m = host.sh.mode[n];
      if (m === MODE.OUTPUT || m === MODE.INPUT_PULLUP) return ((snap[n >> 3] >> (n & 7)) & 1) as 0 | 1;
    }
    return c.level(devUid, pin);
  };
  let spiLog = 0;
  /** bytes the program clocked out on SPI: to the chip whose CS is low; its answers (or 0xFF: nobody) */
  const spiTo = (c: Circuit, snap: number[], bytes: number[], reply: boolean): number[] | Promise<number[]> => {
    const none = () => new Array(bytes.length).fill(0xff);
    if (!spec.spi) {
      c.warnOnce(`nospi:${uid}`, `${name(v)}'s program uses SPI, but this board has no SPI pins`, 'bad');
      return none();
    }
    const chips = c.spiDevices(uid, spec.spi.sck, spec.spi.mosi).filter((d) => levelFor(c, snap, d.view.inst.uid, d.spi!.cs) === 0);
    if (spiLog < 3) {
      spiLog++;
      console.info(`[spi] ${name(v)}: ${bytes.length} byte(s) ${reply ? 'both ways' : 'out'} -> ${chips.map((d) => name(d.view)).join(', ') || 'nobody (no SPI part with its CS low on SCK/MOSI)'}`);
    }
    if (chips.length > 1) {
      c.warnOnce(`spiclash:${uid}`, `Two SPI parts have their CS pin low at once (${chips.map((d) => name(d.view)).join(' and ')}): both answer on MISO and garble it. Give each its own CS pin and keep the others HIGH.`, 'bad');
      return none();
    }
    const d = chips[0];
    if (!d) return none();
    const s = d.spi!;
    const pins: Record<string, 0 | 1 | null> = {};
    for (const p of d.view.build.pins ?? []) pins[p.id] = levelFor(c, snap, d.view.inst.uid, p.id);
    const misoOk = !s.miso || c.net(d.view.inst.uid, s.miso) === c.net(uid, spec.spi.miso);
    if (reply && s.miso && !misoOk) c.warnOnce(`spimiso:${uid}:${d.view.inst.uid}`, `${name(d.view)}'s ${s.miso} isn't wired to ${name(v)}'s MISO (${spec.spi.miso}): the program hears nothing back from it`);
    const r = s.transfer(bytes, pins, reply);
    if (!reply) return [];
    const fix = (x: number[] | void) => (misoOk && x ? bytes.map((_, i) => (x[i] ?? 0xff) & 255) : none());
    return r instanceof Promise ? r.then(fix) : fix(r);
  };
  const dev: Device = {
    view: v,
    shorts: () => spec.shorts ?? [],
    i2c: spec.i2c ? { ...spec.i2c, chips: [] } : undefined,
    drive(c) {
      const on = spec.power(c) > 0;
      spec.drivePower(c, on);
      if (on && !lastPowered && !crashed) start(c);
      if (!on && lastPowered) {
        if (running) hooks.log(`${name(v)} lost power: its program stopped`, 'warn');
        stop();
      }
      lastPowered = on;
      if (!host) return;
      host.tick(c.time * 1000);
      if (spec.wifi && hooks.net) {
        const st = hooks.net.state(uid, c.time);
        const key = `${st.status} ${st.ip}`;
        if (key !== wifiShown) {
          wifiShown = key;
          host.setWifi(st.status, ipToInt(st.ip));
        }
        host.pumpWeb();
      }
      const h = host;
      // messages the program sent (Serial1, an LED strip, SPI bytes): first, so they arrive before
      // whatever it asks next (an SPI answer after the bytes before it)
      for (const p of host.takePackets()) {
        if (p.proto === 'spi') {
          spiTo(c, p.data.slice(0, SPI_SNAP), p.data.slice(SPI_SNAP), false);
          continue;
        }
        const id = byNum.get(p.pin);
        if (id) c.send(uid, id, p.proto, p.data, p.baud || undefined);
      }
      host.serve({
        spi: (snap, bytes) => spiTo(c, snap, bytes, true),
        wifiJoin: (mode, ssid, pass) => {
          if (!hooks.net) return 0;
          const s = hooks.net.join(uid, name(v), mode, ssid, pass, c.time);
          const st = hooks.net.state(uid, c.time);
          h.setWifi(st.status, ipToInt(st.ip));
          wifiShown = `${st.status} ${st.ip}`;
          return s;
        },
        httpListen: (port) => {
          if (!hooks.net) return false;
          hooks.net.listen(uid, name(v), port, (req) => h.webRequest(req));
          return true;
        },
        i2cWrite: (addr, bytes) => {
          const chip = chipAt(c, addr);
          if (chip === 'clash') return false;
          return chip ? chip.write(bytes) : false;
        },
        i2cRead: (addr, n) => {
          const chip = chipAt(c, addr);
          return chip && chip !== 'clash' ? chip.read(n) : null;
        },
        pulseIn: (p, level) => {
          const id = byNum.get(p);
          const net = id ? c.net(uid, id) : undefined;
          if (!net) return 0;
          for (const d of c.devices) {
            const pulseOn = (d as any).pulseOn as ((pin: string, level: number) => number) | undefined;
            if (!pulseOn) continue;
            for (const k of net.pins) if (k.startsWith(d.view.inst.uid + '/')) {
              const us = pulseOn(k.slice(d.view.inst.uid.length + 1), level);
              if (us) return Math.round(us);
            }
          }
          return 0;
        },
      });
      const sh = host.sh;
      for (const [n, id] of byNum) {
        const mode = sh.mode[n];
        if (mode === MODE.OUTPUT) {
          const pwm = sh.hz[n] > 0 && sh.duty[n] > 0 && sh.duty[n] < 1 ? { hz: sh.hz[n], duty: sh.duty[n] } : undefined;
          c.drive(uid, id, { v: pwm || sh.out[n] ? spec.logicV : 0, strength: 1, src: `${name(v)} ${id}`, pwm, logic: true, rises: sh.rise[n] });
        } else if (mode === MODE.INPUT_PULLUP) c.drive(uid, id, { v: spec.logicV, strength: 0, src: `${name(v)} ${id} pull-up` });
        else if (mode === MODE.INPUT_PULLDOWN) c.drive(uid, id, { v: 0, strength: 0, src: `${name(v)} ${id} pull-down` });
      }
      if (spec.builtinLed !== undefined) {
        const n = spec.builtinLed;
        glow(ledMeshes, sh.mode[n] === MODE.OUTPUT ? (sh.hz[n] > 0 ? sh.duty[n] : sh.out[n]) : 0);
      }
      spec.onStep?.(sh, c, 'drive');
    },
    sense(c) {
      if (!host) return;
      const sh = host.sh;
      spec.onStep?.(sh, c, 'sense');
      for (const [n, id] of byNum) {
        if (sh.mode[n] === MODE.OUTPUT) continue;
        const lv = c.level(uid, id, spec.logicV / 2);
        if (lv === null && (sh.mode[n] === MODE.INPUT) && c.time > 0.2)
          c.warnOnce(`float:${uid}:${id}`, `${name(v)} reads ${id}, but nothing drives it (a floating input reads random values): use INPUT_PULLUP, or wire it to something`);
        const nv = lv ?? (Math.random() < 0.5 ? 1 : 0);
        if (nv !== sh.inp[n]) {
          // (logged in order for interrupts: several changes can happen before the program looks)
          const h = Atomics.load(sh.ctl, CTL.IN_HEAD), next = (h + 1) % IN_EVENTS;
          if (next !== Atomics.load(sh.ctl, CTL.IN_TAIL)) {
            sh.inEv[h] = (n << 1) | nv;
            Atomics.store(sh.ctl, CTL.IN_HEAD, next);
          }
        }
        sh.inp[n] = nv;
        if (spec.analog.includes(id)) sh.analog[n] = Math.round(Math.max(0, Math.min(1, c.avg(uid, id) / 3.3)) * 4095);
      }
    },
    status: () => [
      !lastPowered ? 'no power' : crashed ? `program stopped: ${host?.error ?? 'error'}` : running ? `program ${host?.state === 'loop' ? 'running' : host?.state ?? ''}` : 'no program',
      ...(spec.wifi && lastPowered ? [wifiLine(hooks.net?.info(uid))] : []),
    ],
    sendSerial: (t) => host?.sendSerial(t),
    packets(list) {
      if (!host) return;
      for (const p of list) {
        const n = spec.pins[p.pin];
        if (n === undefined) continue;
        if (!host.givePacket(n, p.proto, p.data, p.baud) && !dropWarned) {
          dropWarned = true;
          hooks.log(`${name(v)}: too many messages arrived on ${p.pin} (its program isn't reading them): some were dropped`, 'warn');
        }
      }
    },
    pinEvents: () => (host ? host.takeEvents().flatMap(([n, lv]) => (byNum.has(n) ? [[byNum.get(n)!, lv] as [string, 0 | 1]] : [])) : []),
    current: () => (lastPowered ? 0.08 : 0),
    dispose() {
      stop();
      glow(ledMeshes, 0);
    },
  };
  return dev;
}

export function makerBoardDevice(v: PartView, hooks: DeviceHooks): Device {
  const pinVin = v.build.pins!.find((p) => p.id === 'VIN')!;
  let burnt = false;
  const uid = v.inst.uid;
  const analog = ['A0', 'A1', 'A2'];
  return sketchBoard(v, {
    pins: MAKER_PINS,
    analog,
    logicV: 3.3,
    builtinLed: 25,
    constants: { __TX1: 0, __RX1: 1, __TX2: 4, __RX2: 5 }, // (Serial1 on GP0/GP1, Serial2 on GP4/GP5, as a Pico)
    shorts: [['GND', 'GND2']],
    i2c: { sda: 'SDA', scl: 'SCL' },
    spi: { sck: 'GP18', mosi: 'GP19', miso: 'GP16', ss: 'GP17' }, // (SPI0, as a Pico)
    defines: { ARDUINO_ARCH_RP2040: 1 },
    power(c) {
      const vin = c.supply(uid, 'VIN', 'GND');
      if (!burnt && overVolt(c, v, pinVin, vin)) burnt = true;
      if (burnt) return 0;
      if (v.inst.params.usb) return 1;
      brownOut(c, v, vin >= 6, vin, 6);
      return vin >= 6 ? 1 : 0;
    },
    drivePower(c, on) {
      if (!on) return;
      if (v.inst.params.usb) c.drive(uid, 'GND', { v: 0, strength: 3, src: `${name(v)} GND (USB)` });
      c.drive(uid, '5V', { v: 5, strength: 2, src: `${name(v)} 5V` }); // from USB, or VIN's regulator
      c.drive(uid, '3V3', { v: 3.3, strength: 2, src: `${name(v)} 3V3` });
    },
  }, hooks);
}

export type DeviceMaker = (v: PartView, hooks: DeviceHooks, project: Project) => Device | null;

export const DEVICE_MAKERS: Record<string, DeviceMaker> = {
  led: (v) => ledDevice(v),
  button: (v) => buttonDevice(v),
  knob: (v) => knobDevice(v),
  drv8833: (v) => drv8833Device(v),
  l298n: (v) => l298nDevice(v),
  'servo-sg90': (v) => servoDevice(v),
  'servo-mg996r': (v) => servoDevice(v),
  'motor-tt': (v) => motorDevice(v),
  hcsr04: (v) => hcsr04Device(v),
  'maker-board': (v, h) => makerBoardDevice(v, h),
};

export type { I2CChip };
