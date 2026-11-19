// The current and voltage sensor modules, the thermal camera and the lidar (parts/sensors.ts).
import * as THREE from 'three';
import type { PartView } from '../views';
import type { Circuit, Device, I2CChip, Packet } from './circuit';
import { name } from './devices';

export const ROOM_C = 22;

/** a part's temperature: a Warm object's own, anything else the room's */
function tempOf(c: Circuit, uid: string | null) {
  if (!uid) return ROOM_C - 1; // (the bench top: a little cooler than the air)
  // (a Warm object is a device of its own, wired or not: warmObjectDevice)
  const inst = c.devices.find((x) => x.view.inst.uid === uid)?.view.inst;
  return inst?.type === 'warm-object' ? Number(inst.params.temp ?? ROOM_C) : ROOM_C;
}
export const warmObjectDevice = (v: PartView): Device => ({ view: v, status: () => [`${Number(v.inst.params.temp ?? ROOM_C).toFixed(0)} C`] });

/** The AMG8833's registers: pixels at 0x80-0xFF (12-bit, 0.25 C a step, low byte first), its own
 *  thermistor at 0x0E (12-bit sign and size, 0.0625 C a step), power control at 0x00. */
class AMG8833 implements I2CChip {
  name = 'AMG8833';
  regs = new Uint8Array(256);
  ptr = 0;
  enabled = () => true;
  constructor(public addr: number) {}
  address() { return this.enabled() ? this.addr : -1; }
  write(bytes: number[]) {
    if (!bytes.length) return true;
    this.ptr = bytes[0];
    for (const b of bytes.slice(1)) {
      if (this.ptr === 0x01 && (b === 0x3f || b === 0x30)) this.regs.fill(0, 0x80); // (a reset)
      else this.regs[this.ptr] = b;
      this.ptr = (this.ptr + 1) & 0xff;
    }
    return true;
  }
  read(n: number) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) { out.push(this.regs[this.ptr]); this.ptr = (this.ptr + 1) & 0xff; }
    return out;
  }
  get awake() { return this.regs[0x00] === 0x00; }
  set(pixels: number[], thermistor: number) {
    if (!this.awake) return; // (sleep / stand-by: the last frame stays)
    pixels.forEach((t, i) => {
      const raw = Math.max(-2048, Math.min(2047, Math.round(t / 0.25))) & 0xfff;
      this.regs[0x80 + i * 2] = raw & 0xff;
      this.regs[0x81 + i * 2] = raw >> 8;
    });
    const th = Math.round(Math.abs(thermistor) / 0.0625) & 0x7ff;
    this.regs[0x0e] = th & 0xff;
    this.regs[0x0f] = (th >> 8) | (thermistor < 0 ? 0x08 : 0);
  }
}

/** AMG8833 thermal camera: 8 x 8 pixels, 60 degrees across, ten frames a second. */
export function amg8833Device(v: PartView): Device {
  const uid = v.inst.uid;
  const chip = new AMG8833(Number(v.inst.params.addr ?? 0x69));
  const pinV = v.build.pins!.find((p) => p.id === 'VIN')!;
  let vcc = 0, next = 0, frame: number[] = new Array(64).fill(ROOM_C), hottest = ROOM_C;
  chip.enabled = () => vcc >= 3;
  const o = new THREE.Vector3(), dir = new THREE.Vector3(), q = new THREE.Quaternion();
  return {
    view: v,
    i2c: { sda: 'SDA', scl: 'SCL', chips: [chip] },
    drive(c) {
      vcc = c.supply(uid, 'VIN', 'GND');
      if (vcc > (pinV.vmax ?? 5.5) + 0.5) c.warnOnce(`amg:${uid}`, `${name(v)} gets ${vcc.toFixed(1)} V: at most 5.5`, 'bad');
      // INT: open drain, high (released) unless an interrupt is set up (not modelled)
    },
    sense(c) {
      if (vcc < 3 || c.time < next) return;
      next = c.time + 0.1;
      // each pixel: the average of 3 x 3 rays across its 7.5 degree square (an edge half in shows half warm)
      const body = v.bodies.get('body')!;
      body.updateWorldMatrix(true, false);
      body.matrixWorld.decompose(o, q, dir);
      const origin = new THREE.Vector3(0, 0.7, -0.2).applyMatrix4(body.matrixWorld);
      const self = c.sim.rigidOf(uid, 'body');
      const half = (30 * Math.PI) / 180;
      const out: number[] = [];
      for (let row = 0; row < 8; row++)
        for (let col = 0; col < 8; col++) {
          let sum = 0;
          for (let sy = 0; sy < 3; sy++)
            for (let sx = 0; sx < 3; sx++) {
              const ax = -half + ((col + (sx + 0.5) / 3) / 8) * 2 * half;
              const az = -half + ((row + (sy + 0.5) / 3) / 8) * 2 * half;
              dir.set(Math.tan(ax), 1, Math.tan(az)).normalize().applyQuaternion(q);
              const hit = c.sim.raycastHit(origin, dir, 700, self, uid);
              sum += hit ? tempOf(c, hit.uid) : ROOM_C - 2; // (open space: the far walls of the room)
            }
          out.push(sum / 9 + (Math.random() - 0.5) * 0.5); // (its noise: about a quarter of a degree)
        }
      frame = out;
      hottest = Math.max(...out);
      chip.set(out, ROOM_C + 2 + (Math.random() - 0.5) * 0.1);
    },
    status: () => [vcc < 3 ? 'no power (3.3-5 V on VIN)' : !chip.awake ? 'asleep (power control set)' : `hottest pixel ${hottest.toFixed(1)} C, coolest ${Math.min(...frame).toFixed(1)} C`],
    current: () => (vcc >= 3 ? 0.0045 : 0),
  };
}

/** RPLidar A1: its head turns 5.5 times a second, measuring 2000 points a second all round, and
 *  sends them in the real protocol: answers to A5 20 (scan), A5 25 (stop), A5 40 (reset), A5 50
 *  (device info), A5 52 (health). Angle 0 is the part's +X, going clockwise seen from above. */
export function rplidarDevice(v: PartView): Device {
  const uid = v.inst.uid;
  const BAUD = 115200, RATE = 2000, TURN = 5.5;
  let vcc = 0, scanning = false, angle = 0, carry = 0, spinning = false, rx: number[] = [], last: number | null = null, points = 0;
  const pinV = v.build.pins!.find((p) => p.id === '5V')!;
  const out: number[] = [];
  const o = new THREE.Vector3(), d = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const descriptor = (len: number, mode: number, type: number) => out.push(0xa5, 0x5a, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, ((len >> 24) & 0x3f) | (mode << 6), type);
  const command = (cmd: number) => {
    console.info(`[lidar] ${name(v)} got command 0x${cmd.toString(16)}`);
    if (cmd === 0x20 || cmd === 0x21) { scanning = true; descriptor(5, 1, 0x81); }
    else if (cmd === 0x25) scanning = false;
    else if (cmd === 0x40) { scanning = false; out.push(...new TextEncoder().encode('RP LIDAR System.\r\nFirmware Ver 1.29\r\nHardware Rev 7\r\n')); }
    else if (cmd === 0x50) { descriptor(20, 0, 0x04); out.push(0x18, 29, 1, 7, ...Array.from({ length: 16 }, (_, i) => (uid.charCodeAt(i % uid.length) * 7 + i) & 0xff)); }
    else if (cmd === 0x52) { descriptor(3, 0, 0x06); out.push(0, 0, 0); }
  };
  return {
    view: v,
    drive(c) {
      vcc = c.supply(uid, '5V', 'GND');
      if (vcc > (pinV.vmax ?? 5.5) + 0.5) c.warnOnce(`lidar:${uid}`, `${name(v)} gets ${vcc.toFixed(1)} V: at most 5.5`, 'bad');
      if (vcc < 4.5) scanning = false;
      // its TX idles high (a UART)
      if (vcc >= 4.5) c.drive(uid, 'TX', { v: 3.3, strength: 1, logic: true, src: `${name(v)} TX` });
    },
    packets(list: Packet[]) {
      for (const p of list) {
        if (p.pin !== 'RX' || p.proto !== 'uart' || vcc < 4.5) continue;
        if (p.baud && Math.abs(p.baud - BAUD) > BAUD * 0.03) continue; // (the wrong speed: garbage to it)
        rx.push(...p.data);
        // requests: A5 cmd (some with a payload: A5 cmd len data... checksum)
        while (rx.length >= 2) {
          const i = rx.indexOf(0xa5);
          if (i < 0) { rx = []; break; }
          rx = rx.slice(i);
          if (rx.length < 2) break;
          const cmd = rx[1];
          if (cmd >= 0x80) { // (with a payload)
            if (rx.length < 3 || rx.length < 4 + rx[2]) break;
            rx = rx.slice(4 + rx[2]);
          } else rx = rx.slice(2);
          command(cmd);
        }
      }
    },
    sense(c, dt) {
      const uid0 = uid;
      // the motor: MOTOCTL high (or not wired) turns it
      const ctl = c.net(uid0, 'MOTOCTL');
      spinning = vcc >= 4.5 && (ctl?.v ?? 5) > 1.5;
      if (spinning) {
        const head = (() => { let h: THREE.Object3D | null = null; v.bodies.get('body')!.traverse((m) => { if (m.userData.lidarHead) h = m; }); return h as THREE.Object3D | null; })();
        if (head) head.rotation.y -= 2 * Math.PI * TURN * dt;
      }
      if (scanning && spinning) {
        const body = v.bodies.get('body')!;
        body.updateWorldMatrix(true, false);
        body.matrixWorld.decompose(o, q, s);
        const origin = new THREE.Vector3(0, 3.0, 0).applyMatrix4(body.matrixWorld);
        const self = c.sim.rigidOf(uid0, 'body');
        carry += RATE * dt;
        const n = Math.floor(carry);
        carry -= n;
        for (let i = 0; i < n; i++) {
          const prev = angle;
          angle = (angle + (360 * TURN) / RATE) % 360;
          const start = angle < prev; // (a new turn)
          const a = (angle * Math.PI) / 180;
          d.set(Math.cos(a), 0, Math.sin(a)).applyQuaternion(q);
          const hit = c.sim.raycast(origin.clone().addScaledVector(d, 3.0), d, 1200, self, uid0);
          const mm = hit === null || hit + 3.0 < 15 ? 0 : (hit + 3.0) * 10 * (1 + (Math.random() - 0.5) * 0.01);
          last = mm ? mm / 10 : null;
          const quality = mm ? 47 : 0;
          const aq6 = Math.round(angle * 64) & 0x7fff;
          const dq2 = Math.round(mm * 4) & 0xffff;
          out.push((quality << 2) | (start ? 1 : 2), ((aq6 & 0x7f) << 1) | 1, aq6 >> 7, dq2 & 0xff, dq2 >> 8);
          points++;
        }
      }
      if (out.length) {
        c.send(uid0, 'TX', 'uart', out.splice(0, out.length), BAUD);
      }
    },
    status: () => [
      vcc < 4.5 ? 'no power (5 V)' : !spinning ? 'motor stopped (MOTOCTL low)' : scanning ? `scanning: ${last === null ? 'nothing in range' : `${last.toFixed(1)} cm`} at ${angle.toFixed(0)} deg (${points} points sent)` : 'spinning, waiting for a scan command',
    ],
    current: () => (vcc < 4.5 ? 0 : spinning ? 0.3 : 0.1),
  };
}

/** ACS712: a hall-effect chip on the current's path: OUT = half its supply + mV per amp. */
export function acs712Device(v: PartView): Device {
  const uid = v.inst.uid;
  const range = Number(v.inst.params.range) || 5;
  const mvPerA = range === 30 ? 66 : range === 20 ? 100 : 185;
  let amps = 0, out = 0, vcc = 0;
  const dev: Device = {
    view: v,
    shorts: () => [['IP+', 'IP-']], // (its copper path: as good as a wire)
    drive(c) {
      vcc = c.supply(uid, 'VCC', 'GND');
      if (vcc < 4) { out = 0; return; }
      // (ratiometric: the zero point and the scale follow its supply)
      out = Math.max(0, Math.min(vcc, vcc / 2 + (mvPerA / 1000) * (vcc / 5) * amps * (1 + (Math.random() - 0.5) * 0.01)));
      c.drive(uid, 'OUT', { v: out, strength: 1, src: `${name(v)} OUT` });
    },
    sense(c) {
      // the current: what the parts on its load side (IP-) draw
      const net = c.net(uid, 'IP-');
      amps = 0;
      if (net)
        for (const d of c.devices)
          if (d !== dev && d.current && net.pins.some((k) => k.startsWith(d.view.inst.uid + '/'))) amps += d.current();
      if (amps > range * 1.1) c.warnOnce(`acs:${uid}`, `${name(v)} carries ${amps.toFixed(1)} A: more than its ${range} A range (its output stops at the rail). Use the 20 A or 30 A version.`);
    },
    status: () => [vcc < 4 ? 'no power (5 V on VCC)' : `${amps.toFixed(3)} A through it: OUT ${out.toFixed(3)} V`],
    current: () => (vcc >= 4 ? 0.01 : 0),
  };
  return dev;
}

/** The 0-25 V sensor: a 30k / 7.5k divider, S = VCC / 5. */
export function voltageSensorDevice(v: PartView): Device {
  const uid = v.inst.uid;
  let s = 0, vin = 0;
  return {
    view: v,
    shorts: () => [['GND', '-']],
    drive(c) {
      vin = Math.max(0, c.supply(uid, 'VCC', 'GND'));
      s = vin / 5;
      // (through 30k + 7.5k: a pin reads it fine)
      c.drive(uid, 'S', { v: s, strength: 1, src: `${name(v)} S` });
    },
    status: () => [`${vin.toFixed(2)} V in: S ${s.toFixed(3)} V`],
    current: () => vin / 37500,
  };
}
