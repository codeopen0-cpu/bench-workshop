// The memory a running program (in its own thread) shares with the simulation.
// Pin state goes both ways through plain arrays; calls that need an answer from the simulation
// (I2C, pulseIn) go through a one-slot mailbox: the program thread posts a request and sleeps
// (Atomics.wait) until the simulation answers it in its next step.
export const PINS = 128; // (an Arduino Mega has 70: D0-D53, A0-A15 = 54-69)

export const CTL = {
  STEP: 0, // incremented by the simulation every step (the program waits on it to let time pass)
  REQ: 1, // 0 idle, 1 request waiting, 2 answered
  REQ_TYPE: 2,
  ARG0: 3,
  ARG1: 4,
  ARG2: 5,
  RESP_LEN: 8,
  RESP_STATUS: 9,
  SERIAL_HEAD: 10, // serial bytes in from the monitor: written by the simulation
  SERIAL_TAIL: 11, // ...read by the program
  STATE: 12, // program thread: 0 starting, 1 in setup(), 2 in loop(), 3 stopped by an error
  EV_HEAD: 13, // pin-change log (ring of EVENTS): written by the program...
  EV_TAIL: 14, // ...read by the simulation each step
  // Wi-Fi (boards that have it)
  WIFI_STATUS: 15, // Arduino's WL_* codes: 0 idle, 1 no such network, 3 connected, 4 failed, 6 disconnected
  WIFI_IP: 16, // its address, a.b.c.d packed into 32 bits
  HTTP: 17, // web request mailbox: 0 empty, 1 a request waits for the program, 2 its answer waits for the simulation
  HTTP_LEN: 18,
  HTTP_RESP_LEN: 19,
  // messages along wires (serial bytes, LED-strip pixels, a sensor's answer): two rings of bytes
  PKO_HEAD: 20, // program -> simulation: written by the program...
  PKO_TAIL: 21, // ...read by the simulation
  PKI_HEAD: 22, // simulation -> program: written by the simulation...
  PKI_TAIL: 23, // ...read by the program
  // input pin changes, in order (so interrupts see every edge, even several within one frame)
  IN_HEAD: 24, // written by the simulation...
  IN_TAIL: 25, // ...read by the program
  PARK: 26, // the STEP value the program sleeps on (waiting for the simulation to catch up), -1 while it runs
} as const;
export const IN_EVENTS = 2048;
export const PKT_RING = 32768;
/** message kinds (one byte in the rings); the same names libraries use */
export const PROTOS = ['', 'uart', 'pixels', 'data', 'ir', 'onewire', 'raw', 'spi'] as const;
/** an SPI message's first bytes: which of the board's pins were high when it was sent (bit p = pin p) */
export const SPI_SNAP = PINS / 8;
export const protoCode = (p: string | number) => (typeof p === 'number' ? p : Math.max(0, PROTOS.indexOf(p as any)));
export const HTTP_REQ_MAX = 64 * 1024;
export const HTTP_RESP_MAX = 1024 * 1024;
export const EVENTS = 8192;

export const REQ = { I2C_WRITE: 1, I2C_READ: 2, PULSE_IN: 3, WIFI_JOIN: 4, HTTP_LISTEN: 5, SPI: 6, ESPNOW: 7 } as const;
/** the pin number ESP-NOW messages arrive on (no real pin: the radio) */
export const ESPNOW_PIN = 254;
export const MODE = { INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, INPUT_PULLDOWN: 3, UNUSED: -1 } as const;

// where each array starts in the shared memory (one after another, sized by PINS)
const OFF = (() => {
  let at = 0;
  const take = (bytes: number) => { const o = at; at += Math.ceil(bytes / 8) * 8; return o; };
  const o = {
    ctl: take(32 * 4), // Int32 x 32
    f64: take(16 * 8), // Float64 x 16: [0] = simulation time, ms
    mode: take(PINS * 4), // Int32 x PINS
    out: take(PINS * 4), // Int32 x PINS (0/1)
    inp: take(PINS * 4), // Int32 x PINS (0/1)
    analog: take(PINS * 4), // Int32 x PINS (0..4095: the voltage over the board's analog reference)
    duty: take(PINS * 8), // Float64 x PINS (0..1; with hz > 0 = PWM)
    hz: take(PINS * 8), // Float64 x PINS
    req: take(512), // Uint8 x 512
    resp: take(512), // Uint8 x 512
    serial: take(1024), // Uint8 x 1024 (ring)
    rise: take(PINS * 4), // Int32 x PINS: rising edges written by the program (catches pulses shorter than a step)
    ev: take(EVENTS * 4), // Int32 x EVENTS: pin changes in order, (pin << 1) | level
    httpReq: take(HTTP_REQ_MAX), // Uint8: a web request (JSON)
    httpResp: take(HTTP_RESP_MAX), // Uint8: its answer (JSON)
    pktOut: take(PKT_RING), // Uint8 x PKT_RING
    pktIn: take(PKT_RING), // Uint8 x PKT_RING
    inEv: take(IN_EVENTS * 4), // Int32 x IN_EVENTS: (pin << 1) | level
    size: 0,
  };
  o.size = at;
  return o;
})();

export class Shared {
  sab: SharedArrayBuffer;
  ctl: Int32Array;
  f64: Float64Array;
  mode: Int32Array;
  out: Int32Array;
  inp: Int32Array;
  analog: Int32Array;
  duty: Float64Array;
  hz: Float64Array;
  req: Uint8Array;
  resp: Uint8Array;
  serial: Uint8Array;
  rise: Int32Array;
  ev: Int32Array;
  httpReq: Uint8Array;
  httpResp: Uint8Array;
  pktOut: Uint8Array;
  pktIn: Uint8Array;
  inEv: Int32Array;

  constructor(sab?: SharedArrayBuffer) {
    this.sab = sab ?? new SharedArrayBuffer(OFF.size);
    const s = this.sab;
    this.ctl = new Int32Array(s, OFF.ctl, 32);
    this.f64 = new Float64Array(s, OFF.f64, 16);
    this.mode = new Int32Array(s, OFF.mode, PINS);
    this.out = new Int32Array(s, OFF.out, PINS);
    this.inp = new Int32Array(s, OFF.inp, PINS);
    this.analog = new Int32Array(s, OFF.analog, PINS);
    this.duty = new Float64Array(s, OFF.duty, PINS);
    this.hz = new Float64Array(s, OFF.hz, PINS);
    this.req = new Uint8Array(s, OFF.req, 512);
    this.resp = new Uint8Array(s, OFF.resp, 512);
    this.serial = new Uint8Array(s, OFF.serial, 1024);
    this.rise = new Int32Array(s, OFF.rise, PINS);
    this.ev = new Int32Array(s, OFF.ev, EVENTS);
    this.httpReq = new Uint8Array(s, OFF.httpReq, HTTP_REQ_MAX);
    this.httpResp = new Uint8Array(s, OFF.httpResp, HTTP_RESP_MAX);
    this.pktOut = new Uint8Array(s, OFF.pktOut, PKT_RING);
    this.pktIn = new Uint8Array(s, OFF.pktIn, PKT_RING);
    this.inEv = new Int32Array(s, OFF.inEv, IN_EVENTS);
    if (!sab) this.mode.fill(MODE.UNUSED);
  }
}

// A message in a ring: pin, kind, baud/100 (2 bytes), length (2 bytes), then the bytes.
// The writer moves HEAD after writing a whole message, so the reader never sees half of one.
export interface RawPacket { pin: number; proto: number; baud: number; data: number[] }
export function ringWrite(ring: Uint8Array, ctl: Int32Array, headI: number, tailI: number, p: RawPacket): boolean {
  const n = Math.min(p.data.length, 4096);
  const need = 6 + n;
  let h = Atomics.load(ctl, headI);
  const t = Atomics.load(ctl, tailI);
  const free = (t - h - 1 + PKT_RING) % PKT_RING;
  if (need > free) return false;
  const put = (b: number) => { ring[h] = b & 255; h = (h + 1) % PKT_RING; };
  const baud = Math.round((p.baud || 0) / 100);
  put(p.pin); put(p.proto); put(baud); put(baud >> 8); put(n); put(n >> 8);
  for (let i = 0; i < n; i++) put(p.data[i]);
  Atomics.store(ctl, headI, h);
  return true;
}
export function ringRead(ring: Uint8Array, ctl: Int32Array, headI: number, tailI: number): RawPacket[] {
  const h = Atomics.load(ctl, headI);
  let t = Atomics.load(ctl, tailI);
  const out: RawPacket[] = [];
  const get = () => { const b = ring[t]; t = (t + 1) % PKT_RING; return b; };
  while (t !== h) {
    const pin = get(), proto = get(), baud = (get() | (get() << 8)) * 100, n = get() | (get() << 8);
    const data = new Array(n);
    for (let i = 0; i < n; i++) data[i] = get();
    out.push({ pin, proto, baud, data });
  }
  Atomics.store(ctl, tailI, t);
  return out;
}
