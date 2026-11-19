// Memory shared between the simulation and an emulated RP2040's thread.
export const GP = 30;
export const C = {
  STEP: 0, // simulation steps (the chip's thread sleeps on it when it gets ahead)
  // the chip as an I2C TARGET: the simulation asks, the chip answers
  REQ: 1, // 0 idle, 1 request waiting, 2 answered
  REQ_TYPE: 2, // 1 write, 2 read
  REQ_ADDR: 3,
  REQ_LEN: 4,
  RESP_STATUS: 5, // 0 ACK, 2 no answer
  RESP_LEN: 6,
  SAR: 7, // the chip's I2C target address now (-1 = not a target / off)
  STATE: 8, // 0 starting, 1 running, 2 crashed
  // the chip as an I2C CONTROLLER: the chip asks, the simulation's chips answer (the chip waits)
  MREQ: 9, // 0 idle, 1 waiting, 2 answered
  MREQ_TYPE: 10, // 1 probe (is anyone there?), 2 write, 3 read
  MREQ_ADDR: 11,
  MREQ_LEN: 12,
  MRESP_STATUS: 13, // 0 ACK, 2 no answer
  MRESP_LEN: 14,
  I2C_SDA: 15, // the GPIOs its I2C0 is on now (-1 = none)
  I2C_SCL: 16,
  EV_HEAD: 17, // pin-change log (ring of EVENTS), written by the chip's thread...
  EV_TAIL: 18, // ...read by the simulation each step
  SIN_HEAD: 19, // bytes typed into its USB serial (ring of SERIAL_IN), written by the simulation...
  SIN_TAIL: 20, // ...read by the chip's thread
} as const;
export const EVENTS = 8192;
export const SERIAL_IN = 16384;
export const MREQ = { PROBE: 1, WRITE: 2, READ: 3 } as const;
export const OUT = { INPUT: 0, LOW: 1, HIGH: 2, PWM: 3 } as const;

const O = { ctl: 0, f64: 128, out: 256, duty: 384, hz: 640, pull: 896, inp: 1024, adc: 1152, req: 1168, resp: 1680, mreq: 2192, mresp: 2704, ev: 3216, sin: 3216 + EVENTS * 4, size: 3216 + EVENTS * 4 + SERIAL_IN };

export class Rp2040Shared {
  sab: SharedArrayBuffer;
  ctl: Int32Array; // C.*
  f64: Float64Array; // [0] simulation time (ns), [1] the chip's own time (ns)
  out: Int32Array; // OUT.* per GPIO
  duty: Float64Array;
  hz: Float64Array;
  pull: Int32Array; // 0 none, 1 up, 2 down
  inp: Int32Array; // levels seen on the pins (from the circuit)
  adc: Int32Array; // GP26-29 as 0..4095
  req: Uint8Array;
  resp: Uint8Array;
  mreq: Uint8Array;
  mresp: Uint8Array;
  ev: Int32Array; // (pin << 1) | level
  sin: Uint8Array; // USB serial input ring
  constructor(sab?: SharedArrayBuffer) {
    this.sab = sab ?? new SharedArrayBuffer(O.size);
    const s = this.sab;
    this.ctl = new Int32Array(s, O.ctl, 32);
    this.f64 = new Float64Array(s, O.f64, 16);
    this.out = new Int32Array(s, O.out, 32);
    this.duty = new Float64Array(s, O.duty, 32);
    this.hz = new Float64Array(s, O.hz, 32);
    this.pull = new Int32Array(s, O.pull, 32);
    this.inp = new Int32Array(s, O.inp, 32);
    this.adc = new Int32Array(s, O.adc, 4);
    this.req = new Uint8Array(s, O.req, 512);
    this.resp = new Uint8Array(s, O.resp, 512);
    this.mreq = new Uint8Array(s, O.mreq, 512);
    this.mresp = new Uint8Array(s, O.mresp, 512);
    this.ev = new Int32Array(s, O.ev, EVENTS);
    this.sin = new Uint8Array(s, O.sin, SERIAL_IN);
    if (!sab) this.ctl[C.SAR] = this.ctl[C.I2C_SDA] = this.ctl[C.I2C_SCL] = -1;
  }
}
