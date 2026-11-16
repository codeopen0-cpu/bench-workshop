// I2C chips, register by register like their datasheets, so ordinary Arduino libraries and register
// code work against them: PCA9685 (servo/PWM), MPU-6050 (motion), MCP23017 (I/O expander), ADS1115
// (analog), INA226 (power monitor), M24C02 (memory), plus an answering stub for the FUSB302.
import type { I2CChip } from '../elec/circuit';

const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const s16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff;

/** A chip with 8-bit registers and an auto-incrementing pointer (most I2C chips). */
class Regs8 implements I2CChip {
  regs = new Uint8Array(256);
  ptr = 0;
  enabled = () => true;
  constructor(public name: string, public addr: number) {}
  address() {
    return this.enabled() ? this.addr : -1;
  }
  protected autoInc() {
    return true;
  }
  protected writeReg(r: number, v: number) {
    this.regs[r] = v;
  }
  protected readReg(r: number) {
    return this.regs[r];
  }
  write(bytes: number[]) {
    if (!bytes.length) return true;
    this.ptr = bytes[0];
    for (const b of bytes.slice(1)) {
      this.writeReg(this.ptr, b);
      if (this.autoInc()) this.ptr = (this.ptr + 1) & 0xff;
    }
    return true;
  }
  read(n: number) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.readReg(this.ptr));
      if (this.autoInc()) this.ptr = (this.ptr + 1) & 0xff;
    }
    return out;
  }
}

export class PCA9685 extends Regs8 {
  constructor(addr = 0x40) {
    super('PCA9685', addr);
    this.regs[0x00] = 0x11; // SLEEP + ALLCALL at power-on
    this.regs[0x01] = 0x04;
    this.regs[0xfe] = 0x1e; // 200 Hz
  }
  protected autoInc() {
    return (this.regs[0] & 0x20) !== 0;
  }
  protected writeReg(r: number, v: number) {
    if (r === 0xfe) {
      if (this.regs[0] & 0x10) this.regs[r] = Math.max(3, v); // the prescaler only takes while asleep
      return;
    }
    if (r >= 0xfa && r <= 0xfd) { // ALL_LED: every channel at once
      for (let ch = 0; ch < 16; ch++) this.regs[6 + ch * 4 + (r - 0xfa)] = v;
      return;
    }
    this.regs[r] = v;
  }
  get sleeping() {
    return (this.regs[0] & 0x10) !== 0;
  }
  get hz() {
    return 25e6 / (4096 * (this.regs[0xfe] + 1));
  }
  /** channel duty 0..1 */
  duty(ch: number) {
    const b = 6 + ch * 4;
    if (this.regs[b + 3] & 0x10) return 0; // full off
    if (this.regs[b + 1] & 0x10) return 1; // full on
    const on = this.regs[b] | ((this.regs[b + 1] & 0x0f) << 8);
    const off = this.regs[b + 2] | ((this.regs[b + 3] & 0x0f) << 8);
    return (((off - on) % 4096) + 4096) % 4096 / 4096;
  }
}

export class MPU6050 extends Regs8 {
  constructor(addr = 0x68) {
    super('MPU-6050', addr);
    this.regs[0x75] = 0x68; // WHO_AM_I
    this.regs[0x6b] = 0x40; // asleep at power-on
  }
  /** accel in g, gyro in deg/s, temperature in C (sensor axes) */
  set(ax: number, ay: number, az: number, gx: number, gy: number, gz: number, tempC = 28) {
    if (this.regs[0x6b] & 0x40) {
      this.regs.fill(0, 0x3b, 0x49);
      return;
    }
    const aLsb = 16384 / (1 << ((this.regs[0x1c] >> 3) & 3));
    const gLsb = 131 / (1 << ((this.regs[0x1b] >> 3) & 3));
    const vals = [ax * aLsb, ay * aLsb, az * aLsb, (tempC - 36.53) * 340, gx * gLsb, gy * gLsb, gz * gLsb];
    vals.forEach((v, i) => this.regs.set(be16(s16(v)), 0x3b + i * 2));
  }
}

export class MCP23017 extends Regs8 {
  inputs = 0; // pin levels read from the circuit (bit 0-7 port A, 8-15 port B)
  constructor(addr = 0x20) {
    super('MCP23017', addr);
    this.regs[0x00] = 0xff; // IODIRA: all inputs
    this.regs[0x01] = 0xff;
  }
  get dir() { return this.regs[0x00] | (this.regs[0x01] << 8); } // 1 = input
  get pullups() { return this.regs[0x0c] | (this.regs[0x0d] << 8); }
  get latch() { return this.regs[0x14] | (this.regs[0x15] << 8); }
  protected writeReg(r: number, v: number) {
    if (r === 0x12 || r === 0x13) this.regs[r + 2] = v; // writing GPIO writes the output latch
    else this.regs[r] = v;
  }
  protected readReg(r: number) {
    if (r === 0x12 || r === 0x13) {
      const port = r - 0x12;
      const dir = this.regs[port], pol = this.regs[0x02 + port];
      const pins = (this.inputs >> (port * 8)) & 0xff, lat = this.regs[0x14 + port];
      return (((pins ^ pol) & dir) | (lat & ~dir)) & 0xff;
    }
    return this.regs[r];
  }
}

/** ADS1115: 16-bit registers, big-endian, a register pointer. */
export class ADS1115 implements I2CChip {
  name = 'ADS1115';
  ptr = 0;
  conv = 0;
  config = 0x8583;
  lo = 0x8000;
  hi = 0x7fff;
  enabled = () => true;
  constructor(public addr = 0x48, private volts: (ch: number) => number = () => 0) {}
  address() {
    return this.enabled() ? this.addr : -1;
  }
  private convert() {
    const mux = (this.config >> 12) & 7, pga = (this.config >> 9) & 7;
    const fsr = [6.144, 4.096, 2.048, 1.024, 0.512, 0.256, 0.256, 0.256][pga];
    const v = this.volts;
    const diff = [v(0) - v(1), v(0) - v(3), v(1) - v(3), v(2) - v(3), v(0), v(1), v(2), v(3)][mux];
    this.conv = s16((diff / fsr) * 32768);
  }
  /** continuous mode keeps converting */
  tick() {
    if (!((this.config >> 8) & 1)) this.convert();
  }
  write(bytes: number[]) {
    if (!bytes.length) return true;
    this.ptr = bytes[0] & 3;
    if (bytes.length >= 3) {
      const val = (bytes[1] << 8) | bytes[2];
      if (this.ptr === 1) {
        this.config = val;
        if (val & 0x8000) this.convert(); // single-shot start (the conversion takes 1/DR; we're instant)
        this.config |= 0x8000; // OS reads 1 = not busy
      } else if (this.ptr === 2) this.lo = val;
      else if (this.ptr === 3) this.hi = val;
    }
    return true;
  }
  read(n: number) {
    const r = [this.conv, this.config, this.lo, this.hi][this.ptr] ?? 0;
    return be16(r).concat(new Array(Math.max(0, n - 2)).fill(0)).slice(0, n);
  }
}

/** INA226 with a 0.02 ohm shunt. */
export class INA226 implements I2CChip {
  name = 'INA226';
  ptr = 0;
  regs = new Uint16Array(256);
  enabled = () => true;
  constructor(public addr = 0x41) {
    this.regs[0x00] = 0x4127;
    this.regs[0xfe] = 0x5449; // "TI"
    this.regs[0xff] = 0x2260;
  }
  address() {
    return this.enabled() ? this.addr : -1;
  }
  update(busV: number, amps: number) {
    const shunt = s16((amps * 0.02) / 2.5e-6);
    this.regs[0x01] = shunt;
    this.regs[0x02] = Math.max(0, Math.min(0x7fff, Math.round(busV / 1.25e-3)));
    const cal = this.regs[0x05];
    const cur = s16((((shunt << 16) >> 16) * cal) / 2048);
    this.regs[0x04] = cur;
    this.regs[0x03] = Math.min(0xffff, Math.round((Math.abs((cur << 16) >> 16) * this.regs[0x02]) / 20000));
  }
  write(bytes: number[]) {
    if (!bytes.length) return true;
    this.ptr = bytes[0];
    if (bytes.length >= 3 && [0x00, 0x05, 0x06, 0x07].includes(this.ptr)) {
      const v = (bytes[1] << 8) | bytes[2];
      this.regs[this.ptr] = this.ptr === 0x00 && v & 0x8000 ? 0x4127 : v; // bit 15 = reset
    }
    return true;
  }
  read(n: number) {
    return be16(this.regs[this.ptr]).concat(new Array(Math.max(0, n - 2)).fill(0)).slice(0, n);
  }
}

/** M24C02: 256 bytes, 16-byte pages. */
export class M24C02 implements I2CChip {
  name = 'M24C02';
  mem: Uint8Array;
  ptr = 0;
  enabled = () => true;
  constructor(public addr = 0x50, contents?: Uint8Array) {
    this.mem = contents ?? new Uint8Array(256).fill(0xff);
  }
  address() {
    return this.enabled() ? this.addr : -1;
  }
  write(bytes: number[]) {
    if (!bytes.length) return true;
    this.ptr = bytes[0];
    const page = this.ptr & 0xf0;
    let off = this.ptr & 0x0f;
    for (const b of bytes.slice(1)) {
      this.mem[page | off] = b;
      off = (off + 1) & 0x0f; // writes wrap inside the 16-byte page, as on the real chip
    }
    if (bytes.length > 1) this.ptr = page | off;
    return true;
  }
  read(n: number) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.mem[this.ptr]);
      this.ptr = (this.ptr + 1) & 0xff;
    }
    return out;
  }
}

/** Answers like the main board's USB-C controller does, so a bus scan finds it. */
export class FUSB302 extends Regs8 {
  constructor() {
    super('FUSB302', 0x22);
    this.regs[0x01] = 0x91; // device ID
  }
}
