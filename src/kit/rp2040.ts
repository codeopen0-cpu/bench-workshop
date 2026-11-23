// An RP2040 in a run: its real firmware (.uf2) on an emulated chip (rp2040-worker.ts), powered by
// its board, driving and reading its pins, talking I2C both ways (as the controller, to chips wired
// to its I2C pins; as a target, answering other boards at its own address), printing its USB serial
// into its serial monitor. Any board with an RP2040 on it uses this with its own pin map and power.
import type { Circuit, Device, I2CChip } from '../elec/circuit';
import { glow, lensMeshes, type DeviceHooks } from '../elec/devices';
import type { Project } from '../project';
import type { PartView } from '../views';
import { C, EVENTS, GP, MREQ, OUT, Rp2040Shared, SERIAL_IN } from './rp2040-layout';
import Rp2040Worker from './rp2040-worker.ts?worker';

export interface Rp2040Spec {
  /** the board's pin wired to GPn (undefined = not brought out) */
  pinOf(n: number): string | undefined;
  /** does the chip have power now (after the board's own power parts drove their pins) */
  power(c: Circuit): boolean;
  /** the board's regulators etc. (called every step before power()) */
  drivePower?(c: Circuit): void;
  /** a firmware to run when the project has none for this board */
  defaultFirmware?: { url: string; name: string };
  /** chips on the board itself, on the chip's I2C bus */
  internalChips?: I2CChip[];
  /** extra status lines */
  status?(): string[];
}

/** MicroPython for the Pico (micropython.org, MIT licence), shipped with the app: a board whose program
 *  is in Python runs it, and gets the program through its REPL */
export const MICROPYTHON = { url: '/firmware/micropython-rpi-pico-v1.29.0.uf2', name: 'MicroPython 1.29.0' };

const fetched = new Map<string, Promise<Uint8Array>>();
const fetchBytes = (url: string) => {
  if (!fetched.has(url)) fetched.set(url, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${url}: ${r.status}`)))).then((b) => new Uint8Array(b)));
  return fetched.get(url)!;
};

export function rp2040Device(v: PartView, spec: Rp2040Spec, hooks: DeviceHooks, project: Project): Device {
  const uid = v.inst.uid;
  const sh = new Rp2040Shared();
  const pins = Array.from({ length: GP }, (_, n) => spec.pinOf(n));
  const led = lensMeshes(v, 'builtinLed');
  let worker: Worker | null = null;
  let starting = false, crashed: string | null = null, fwName = '', powered = false, warnedNoFw = false;
  let pending: ((ok: boolean, data: number[] | null) => void) | null = null;
  // typing into its USB serial: through the shared ring the chip's thread reads
  const type = (bytes: Uint8Array) => {
    let h = Atomics.load(sh.ctl, C.SIN_HEAD);
    for (const b of bytes) {
      const next = (h + 1) % SERIAL_IN;
      if (next === Atomics.load(sh.ctl, C.SIN_TAIL)) { hooks.log(`${v.inst.name}: its serial input is full`, 'warn'); break; }
      sh.sin[h] = b;
      h = next;
    }
    Atomics.store(sh.ctl, C.SIN_HEAD, h);
  };
  // MicroPython: the program goes in through the raw REPL (Ctrl-A, the code, Ctrl-D), as Thonny and
  // mpremote send it; what the REPL says back for itself is kept out of the serial monitor
  let py: { stage: 'boot' | 'raw' | 'run' | 'back' | 'repl'; code: string; buf: string } | null = null;
  const fromChip = (text: string) => {
    if (!py) return hooks.serial(uid, text);
    text = text.replace(/\r\n?/g, '\n'); // (MicroPython ends lines with CR LF)
    if (py.stage === 'repl') return hooks.serial(uid, text);
    py.buf += text;
    if (py.stage === 'back') {
      // (leaving the raw REPL prints the banner again: only its prompt is shown)
      const i = py.buf.indexOf('>>> ');
      if (i < 0) return;
      hooks.serial(uid, py.buf.slice(i));
      py.buf = '';
      py.stage = 'repl';
      return;
    }
    if (py.stage === 'boot') {
      const i = py.buf.indexOf('>>> ');
      if (i < 0) return;
      hooks.serial(uid, py.buf.slice(0, i).replace(/\n$/, '') + '\n'); // (its banner)
      py.buf = '';
      py.stage = 'raw';
      console.info(`[micropython] ${v.inst.name}: REPL up, sending the program (${py.code.length} chars)`);
      type(new TextEncoder().encode('\r\x03\x03\x01'));
      return;
    }
    if (py.stage === 'raw') {
      const i = py.buf.indexOf('raw REPL; CTRL-B to exit\n>');
      if (i < 0) return;
      py.buf = '';
      py.stage = 'run';
      type(new TextEncoder().encode(py.code.replace(/\r\n/g, '\n') + '\n\x04'));
      return;
    }
    // running: "OK", then its output, then \x04, any error, \x04 and ">"
    if (py.buf.startsWith('OK')) py.buf = py.buf.slice(2);
    const end = py.buf.indexOf('\x04');
    if (end < 0) {
      // (pass the output on as it comes, keeping back a part that might be the start of the ending)
      hooks.serial(uid, py.buf);
      py.buf = '';
      return;
    }
    const out = py.buf.slice(0, end);
    const rest = py.buf.slice(end + 1);
    const end2 = rest.indexOf('\x04');
    if (end2 < 0) { if (out) hooks.serial(uid, out); py.buf = py.buf.slice(end); return; }
    const err = rest.slice(0, end2);
    hooks.serial(uid, out + err + '[the program ended: the >>> prompt is yours (type in the box below)]\n');
    if (err) {
      const line = /line (\d+)/.exec(err.split('\n').filter((l) => /File "<stdin>"/.test(l)).pop() ?? '');
      hooks.error?.(uid, line ? Number(line[1]) : null, err.trim().split('\n').pop() ?? 'error');
    }
    console.info(`[micropython] ${v.inst.name}: program ended${err ? ' with an error' : ''}`);
    py.stage = 'back';
    py.buf = '';
    type(new TextEncoder().encode('\x02')); // (back to the ordinary REPL)
  };
  const queue: (() => void)[] = [];
  let busSda: string | undefined, busScl: string | undefined; // the pins its I2C is on now
  let mTransfers = 0;

  const start = async () => {
    starting = true;
    try {
      const prog = project.programs[uid];
      let bytes: Uint8Array;
      if (prog?.lang === 'python') {
        bytes = await fetchBytes(MICROPYTHON.url);
        fwName = MICROPYTHON.name;
        py = { stage: 'boot', code: prog.source ?? '', buf: '' };
      } else if (prog?.firmware) {
        bytes = Uint8Array.from(atob(prog.firmware), (ch) => ch.charCodeAt(0));
        fwName = prog.firmwareName ?? 'your firmware';
      } else if (spec.defaultFirmware) {
        bytes = await fetchBytes(spec.defaultFirmware.url);
        fwName = spec.defaultFirmware.name;
      } else {
        starting = false;
        if (!warnedNoFw) hooks.log(`${v.inst.name} has power but no program: select it, press Program, then "Load .uf2"`, 'warn');
        warnedNoFw = true;
        return;
      }
      worker = new Rp2040Worker();
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'serial') fromChip(msg.text);
        else if (msg.type === 'log') console.info(`[rp2040] ${v.inst.name}: ${msg.message}`);
        else if (msg.type === 'error') {
          crashed = msg.message;
          hooks.log(`${v.inst.name}: the emulated chip stopped: ${msg.message}`, 'bad');
        }
      };
      worker.onerror = (e) => {
        crashed = e.message || 'its worker could not be loaded (the app files are missing or the app is closing)';
        hooks.log(`${v.inst.name}: the emulated chip stopped: ${crashed}`, 'bad');
      };
      worker.postMessage({ type: 'start', sab: sh.sab, uf2: bytes });
      hooks.serial(uid, `[running ${fwName} on an emulated RP2040]\n`);
    } catch (e) {
      crashed = (e as Error).message;
      hooks.log(`${v.inst.name}: couldn't load its firmware: ${crashed}`, 'bad');
    }
  };

  // ---- as a target: another board's transfer to this chip, answered within a few steps
  const transaction = (read: boolean, bytesOrLen: number[] | number) =>
    new Promise<any>((resolve) => {
      const go = () => {
        sh.ctl[C.REQ_TYPE] = read ? 2 : 1;
        sh.ctl[C.REQ_ADDR] = sh.ctl[C.SAR];
        if (read) sh.ctl[C.REQ_LEN] = bytesOrLen as number;
        else {
          const b = bytesOrLen as number[];
          sh.req.set(b.slice(0, 512));
          sh.ctl[C.REQ_LEN] = b.length;
        }
        pending = (ok, data) => resolve(read ? data : ok);
        Atomics.store(sh.ctl, C.REQ, 1);
        Atomics.notify(sh.ctl, C.STEP);
      };
      if (pending) queue.push(go);
      else go();
    });
  const self: I2CChip = {
    name: `${v.inst.name} (RP2040)`,
    address: () => (powered && worker && !crashed ? sh.ctl[C.SAR] : -1),
    write: (bytes) => transaction(false, bytes),
    read: (n) => transaction(true, n),
  };

  // ---- as the controller: the chip asked the simulation's chips something; it waits for us
  let mBusy = false;
  const chipAt = (c: Circuit, addr: number) => {
    const all = [...(spec.internalChips ?? []), ...(busSda && busScl ? c.i2cChips(uid, busSda, busScl) : [])].filter((x) => x.address() === addr);
    if (all.length > 1) c.warnOnce(`clash:${uid}:${addr}`, `Two chips answer at I2C address 0x${addr.toString(16).toUpperCase()} (${all.map((x) => x.name).join(' and ')}): neither can be used. Change one's address.`, 'bad');
    return all.length === 1 ? all[0] : undefined;
  };
  const serveController = (c: Circuit) => {
    if (mBusy || Atomics.load(sh.ctl, C.MREQ) !== 1) return;
    const type = sh.ctl[C.MREQ_TYPE], addr = sh.ctl[C.MREQ_ADDR], len = sh.ctl[C.MREQ_LEN];
    const answer = (ok: boolean, data: number[] = []) => {
      mBusy = false;
      sh.mresp.set(data.slice(0, 512));
      sh.ctl[C.MRESP_LEN] = data.length;
      sh.ctl[C.MRESP_STATUS] = ok ? 0 : 2;
      Atomics.store(sh.ctl, C.MREQ, 2);
      Atomics.notify(sh.ctl, C.MREQ);
    };
    mTransfers++;
    const chip = chipAt(c, addr);
    if (!chip) return answer(false);
    const r = type === MREQ.PROBE ? true : type === MREQ.WRITE ? chip.write(Array.from(sh.mreq.slice(0, len))) : chip.read(len);
    const done = (x: boolean | number[] | null) => (Array.isArray(x) ? answer(true, x) : answer(!!x));
    if (r instanceof Promise) {
      mBusy = true;
      r.then(done, () => answer(false));
    } else done(r);
  };

  return {
    view: v,
    i2c: {
      get sda() { return busSda ?? '-'; },
      get scl() { return busScl ?? '-'; },
      chips: [self],
    },
    drive(c: Circuit) {
      spec.drivePower?.(c);
      const was = powered;
      powered = spec.power(c);
      if (was && !powered && worker) {
        hooks.log(`${v.inst.name} lost power: its chip stopped`, 'warn');
        worker.terminate();
        worker = null;
        starting = false;
      }
      if (powered && !worker && !starting && !crashed) start();
      if (!worker) {
        glow(led, 0);
        return;
      }
      sh.f64[0] = c.time * 1e9; // the chip may run up to here
      Atomics.add(sh.ctl, C.STEP, 1);
      Atomics.notify(sh.ctl, C.STEP);
      if (pending && Atomics.load(sh.ctl, C.REQ) === 2) {
        const p = pending;
        pending = null;
        const ok = sh.ctl[C.RESP_STATUS] === 0;
        Atomics.store(sh.ctl, C.REQ, 0);
        p(ok, ok ? Array.from(sh.resp.slice(0, sh.ctl[C.RESP_LEN])) : null);
        queue.shift()?.();
      }
      // which pins its I2C is on (the program picks them): its bus is whatever is wired there
      const s = sh.ctl[C.I2C_SDA], k = sh.ctl[C.I2C_SCL];
      busSda = s >= 0 ? pins[s] : undefined;
      busScl = k >= 0 ? pins[k] : undefined;
      serveController(c);
      for (let n = 0; n < GP; n++) {
        const pin = pins[n];
        if (!pin) continue;
        const o = sh.out[n];
        const src = `${v.inst.name} GP${n}`;
        if (o === OUT.HIGH || o === OUT.LOW) c.drive(uid, pin, { v: o === OUT.HIGH ? 3.3 : 0, strength: 1, logic: true, src });
        else if (o === OUT.PWM) c.drive(uid, pin, { v: 3.3, strength: 1, logic: true, src, pwm: { hz: sh.hz[n], duty: sh.duty[n] } });
        else if (sh.pull[n] === 1) c.drive(uid, pin, { v: 3.3, strength: 0, src: `${src} pull-up` });
        else if (sh.pull[n] === 2) c.drive(uid, pin, { v: 0, strength: 0, src: `${src} pull-down` });
      }
      const l = sh.out[25];
      glow(led, l === OUT.HIGH ? 1 : l === OUT.PWM ? sh.duty[25] : 0);
    },
    sense(c: Circuit) {
      for (let n = 0; n < GP; n++) {
        const pin = pins[n];
        if (!pin) continue;
        // (-1: floating, or held only by the chip's own pull: the chip applies its pull itself, at once)
        const net = c.net(uid, pin);
        const own = `${v.inst.name} GP${n} pull-`;
        const onlyOwn = !net || net.drives.every((d) => d.strength === 0 && d.src.startsWith(own));
        sh.inp[n] = onlyOwn ? -1 : c.level(uid, pin) ?? -1;
        if (n >= 26) sh.adc[n - 26] = Math.round(Math.max(0, Math.min(1, c.avg(uid, pin) / 3.3)) * 4095);
      }
    },
    status: () => {
      if (!powered) return ['no power'];
      if (crashed) return [`stopped: ${crashed}`];
      if (!worker) return [starting ? 'loading its firmware...' : 'no program: Program > Load .uf2'];
      const speed = sh.f64[0] > 0 ? Math.min(100, (sh.f64[1] / sh.f64[0]) * 100) : 0;
      const sar = sh.ctl[C.SAR];
      return [
        fwName,
        `emulated at ${speed.toFixed(0)}% of simulation time`,
        ...(sar >= 0 ? [`I2C target at 0x${sar.toString(16).toUpperCase()}`] : []),
        ...(busSda ? [`I2C on ${busSda}/${busScl}: ${mTransfers} transfers`] : []),
        ...(spec.status?.() ?? []),
      ];
    },
    pinEvents() {
      const h = Atomics.load(sh.ctl, C.EV_HEAD);
      let t = Atomics.load(sh.ctl, C.EV_TAIL);
      if (h === t) return [];
      const out: [string, 0 | 1][] = [];
      while (t !== h) {
        const e = sh.ev[t];
        const pin = pins[e >> 1];
        if (pin) out.push([pin, (e & 1) as 0 | 1]);
        t = (t + 1) % EVENTS;
      }
      Atomics.store(sh.ctl, C.EV_TAIL, t);
      return out;
    },
    current: () => (powered ? 0.03 : 0),
    sendSerial(text: string) {
      if (!worker) return;
      // (the serial monitor's Enter is a newline; a REPL wants a carriage return)
      type(new TextEncoder().encode(py ? text.replace(/\n/g, '\r') : text));
    },
    dispose() {
      worker?.terminate();
      worker = null;
    },
  };
}
