// A board's program, running in its own thread. It gets Arduino's functions (pinMode, digitalWrite,
// delay, Servo, Wire, Serial...) and talks to the simulation through shared memory (layout.ts).
// Time is the SIMULATION's time: delay(1000) waits one simulated second, and pausing the simulation
// pauses the program.
import { BLE_PIN, CTL, ESPNOW_PIN, EVENTS, IN_EVENTS, MATRIX_PIN, MODE, PINS, REQ, SPI_SNAP, Shared, protoCode, ringRead, ringWrite } from './layout';
import { LEDMATRIX_GALLERY } from './ledmatrix-gallery';
import { BLE_PROPS, BLE_SIZE, bleDecode, bleEncode, type BleKind } from './blecodec';
import { MATRIX_FONTS } from './ledmatrix-fonts';

interface Start {
  type: 'start';
  sab: SharedArrayBuffer;
  code: string;
  constants: Record<string, number>;
  analogPins: number[];
  libs: { name: string; code: string; exports: string[] }[]; // #include'd library code
  wifi?: boolean; // the board has Wi-Fi (WiFi, WebServer)
  wifiWaits?: boolean; // its WiFi.begin waits until connected (UNO R4 WiFi / WiFiS3)
  /** analogRead's bits at start (an Arduino Nano: 10, 0-1023; an ESP32: 12, 0-4095) */
  adcBits?: number;
  /** the pins analogWrite can really dim (an Arduino Nano: 3 5 6 9 10 11); others just switch */
  pwmPins?: number[];
  /** false: every wait and bus transfer takes a whole simulation step (before 0.14; for comparing) */
  fineTime?: boolean;
  /** it has the UNO R4 WiFi's 12 x 8 LED matrix (Arduino_LED_Matrix.h) */
  matrix?: boolean;
  /** it has Bluetooth LE (ArduinoBLE.h): UNO R4 WiFi, ESP32s */
  ble?: boolean;
  /** it has I2S sound out (ESP_I2S.h, driver/i2s.h): ESP32s */
  i2s?: boolean;
}

self.onmessage = (e: MessageEvent<Start>) => {
  if (e.data?.type === 'start') {
    seal();
    run(e.data);
  }
};

const realPost = (self as any).postMessage.bind(self);
const post = (m: any) => realPost(m);

/** Programs (and #include'd library code) get no network, storage or other threads: only the board. */
function seal() {
  const g = self as any;
  for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts', 'indexedDB', 'caches', 'Worker', 'SharedWorker', 'BroadcastChannel', 'navigator', 'location', 'postMessage', 'addEventListener', 'removeEventListener', 'WebAssembly'])
    try {
      Object.defineProperty(g, k, { value: undefined, configurable: false, writable: false });
    } catch {
      try { g[k] = undefined; } catch { /* can't */ }
    }
}

function run(init: Start) {
  const sh = new Shared(init.sab);
  const ctl = sh.ctl;
  // The program's own clock (ms). It runs with the simulation's time, and on from there by what bus
  // transfers and short waits really take: a program may get up to one simulation step ahead before
  // it has to wait for the simulation (so a 10 us wait or a 0.4 ms I2C read costs that, not a step).
  // (fineTime false: the old way, every wait and bus transfer a whole step; for comparing)
  const fine = init.fineTime !== false;
  let local = 0;
  const now = () => {
    const t = sh.f64[0];
    return t > local ? (local = t) : local;
  };
  const stepMs = () => (!fine ? 0 : sh.f64[1] > 0 ? sh.f64[1] : 1000 / 240);
  Atomics.store(ctl, CTL.PARK, -1);
  let serialOut = '';
  let lastFlush = 0;
  const flush = () => {
    if (serialOut) post({ type: 'serial', text: serialOut });
    serialOut = '';
    lastFlush = now();
  };
  const warned = new Set<string>();
  const warnOnce = (k: string, msg: string) => {
    if (!warned.has(k)) {
      warned.add(k);
      post({ type: 'warn', message: msg });
    }
  };
  // things that happen by time, between the program's own lines: tone(pin, hz, ms) ending, and
  // interrupts (attachInterrupt) firing when an input pin changes
  const toneEnds = new Map<number, number>();
  const isrs = new Map<number, { fn: () => void; mode: number; last: number }>();
  let inIsr = false;
  /** things a timer does on the real board (the LED matrix playing an animation) */
  const tickers: (() => void)[] = [];
  const timed = () => {
    if (inIsr) return;
    for (const t of tickers) t();
    for (const [p, end] of toneEnds)
      if (now() >= end) {
        toneEnds.delete(p);
        sh.hz[p] = 0;
        sh.out[p] = 0;
      }
    // input changes since the last look, in order (several can come within one frame)
    const h = Atomics.load(ctl, CTL.IN_HEAD);
    let t = Atomics.load(ctl, CTL.IN_TAIL);
    if (!isrs.size) {
      if (t !== h) Atomics.store(ctl, CTL.IN_TAIL, h);
      return;
    }
    inIsr = true;
    try {
      while (t !== h) {
        const e = sh.inEv[t];
        t = (t + 1) % IN_EVENTS;
        const isr = isrs.get(e >> 1);
        if (!isr) continue;
        const lv = e & 1;
        if (lv === isr.last) continue;
        isr.last = lv;
        const rising = lv === 1;
        // modes as Arduino numbers them: LOW 0, HIGH 1, CHANGE 2, FALLING 3, RISING 4
        if (isr.mode === 2 || (isr.mode === 4 && rising) || (isr.mode === 3 && !rising) || (isr.mode === 1 && rising) || (isr.mode === 0 && !rising)) isr.fn();
      }
    } finally {
      Atomics.store(ctl, CTL.IN_TAIL, t);
      inIsr = false;
    }
  };
  /** things the radio delivers while the program waits (ESP-NOW's receive callback) */
  let whileWaiting = () => {};
  const waitUntil = (ms: number) => {
    // (and before a long wait: what it printed last would otherwise show only after it)
    if (now() - lastFlush > 30 || (serialOut && ms - now() > 30)) flush();
    timed();
    whileWaiting();
    if (ms > now()) local = ms; // (its clock reads ms when the wait is over)
    for (;;) {
      const s = Atomics.load(ctl, CTL.STEP);
      if (sh.f64[0] + stepMs() >= ms - 1e-9) break; // within a step of the simulation: go on
      // further ahead: sleep until the simulation catches up (PARK tells it which step we sleep on,
      // so it doesn't wait for a request that won't come this step)
      Atomics.store(ctl, CTL.PARK, s);
      Atomics.wait(ctl, CTL.STEP, s, 250);
      Atomics.store(ctl, CTL.PARK, -1);
      timed();
      whileWaiting();
    }
  };
  /** time a transfer takes on the wire (the program's clock moves on by it) */
  const spend = (ms: number) => { if (fine) waitUntil(now() + ms); };
  /** a microsecond for reading the clock (waits only if that takes it a step ahead) */
  const clockRead = () => {
    if (!fine) return;
    const t = now() + 0.001;
    if (sh.f64[0] + stepMs() < t) waitUntil(t);
    else local = t;
  };
  const request = (type: number, a0 = 0, a1 = 0, a2 = 0, data?: number[]) => {
    if (data) sh.req.set(data.slice(0, 512));
    ctl[CTL.REQ_TYPE] = type;
    ctl[CTL.ARG0] = a0;
    ctl[CTL.ARG1] = a1;
    ctl[CTL.ARG2] = a2;
    Atomics.store(ctl, CTL.REQ, 1);
    while (Atomics.load(ctl, CTL.REQ) !== 2) Atomics.wait(ctl, CTL.REQ, 1, 250);
    const len = ctl[CTL.RESP_LEN], status = ctl[CTL.RESP_STATUS];
    const out = Array.from(sh.resp.slice(0, Math.max(0, len)));
    Atomics.store(ctl, CTL.REQ, 0);
    return { status, data: out };
  };
  /** log a pin change for clocked chips (they need every edge, not just the level at each step) */
  const logEdge = (p: number, lv: number) => {
    let h = Atomics.load(ctl, CTL.EV_HEAD);
    const next = (h + 1) % EVENTS;
    while (next === Atomics.load(ctl, CTL.EV_TAIL)) { // full: let the simulation catch up
      const s = Atomics.load(ctl, CTL.STEP);
      Atomics.wait(ctl, CTL.STEP, s, 50);
    }
    sh.ev[h] = (p << 1) | lv;
    Atomics.store(ctl, CTL.EV_HEAD, next);
  };
  const pin = (p: number, fn: string) => {
    if (!Number.isInteger(p) || p < 0 || p >= PINS) throw new Error(`${fn}(${p}): there's no pin ${p} on this board`);
    return p;
  };

  // ------------------------------------------------------------------------------- the Arduino API
  const C = init.constants;
  /** this board's own MAC address (each board its own: ESP-NOW finds boards by it) */
  const MAC = (() => { const m = (Number(C.__MAC) || 0xb34c10) >>> 0; return [0x24, 0x6f, 0x28, (m >> 16) & 255, (m >> 8) & 255, m & 255]; })();
  let pwmMax = 255, pwmHz = 1000;
  let adcBits = init.adcBits ?? 12;
  const api: Record<string, any> = {
    HIGH: 1, LOW: 0, INPUT: MODE.INPUT, OUTPUT: MODE.OUTPUT, INPUT_PULLUP: MODE.INPUT_PULLUP, INPUT_PULLDOWN: MODE.INPUT_PULLDOWN,
    true: undefined, // (placeholders keep the names list tidy; removed below)
    ...C,
    pinMode(p: number, m: number) {
      pin(p, 'pinMode');
      sh.mode[p] = m;
      if (m !== MODE.OUTPUT) sh.hz[p] = 0;
    },
    digitalWrite(p: number, v: any) {
      pin(p, 'digitalWrite');
      const lv = v ? 1 : 0;
      if (sh.mode[p] !== MODE.OUTPUT) {
        if (sh.mode[p] === MODE.INPUT && lv) sh.mode[p] = MODE.INPUT_PULLUP; // what an AVR does
        else warnOnce(`dw${p}`, `digitalWrite(${p}) on a pin that isn't an OUTPUT: call pinMode(${p}, OUTPUT) in setup()`);
      }
      sh.hz[p] = 0;
      if (lv && !sh.out[p]) Atomics.add(sh.rise, p, 1);
      if (sh.mode[p] === MODE.OUTPUT && lv !== sh.out[p]) logEdge(p, lv);
      sh.out[p] = lv;
    },
    digitalRead(p: number) {
      pin(p, 'digitalRead');
      return sh.mode[p] === MODE.OUTPUT ? sh.out[p] : sh.inp[p];
    },
    analogRead(p: number) {
      pin(p, 'analogRead');
      if (!init.analogPins.includes(p)) warnOnce(`ar${p}`, `analogRead(${p}): pin ${p} has no analog input (use one of: ${init.analogPins.join(', ')})`);
      // (shared as 12 bits of the board's reference voltage; the program reads its own resolution)
      return adcBits === 12 ? sh.analog[p] : Math.round((sh.analog[p] * (2 ** adcBits - 1)) / 4095);
    },
    analogWrite(p: number, v: number) {
      pin(p, 'analogWrite');
      if (init.pwmPins && !init.pwmPins.includes(p)) {
        // (a pin without PWM: the real board switches it fully on from half way up, else off)
        warnOnce(`pwm${p}`, `analogWrite(${p}): pin ${p} can't dim on this board (PWM pins: ${init.pwmPins.join(', ')}); it just switches on or off`);
        api.digitalWrite(p, v >= pwmMax / 2 ? 1 : 0);
        sh.mode[p] = MODE.OUTPUT;
        return;
      }
      sh.mode[p] = MODE.OUTPUT;
      const d = Math.max(0, Math.min(1, v / pwmMax));
      sh.duty[p] = d;
      sh.hz[p] = d <= 0 || d >= 1 ? 0 : pwmHz;
      if (d >= 0.5 && !sh.out[p]) Atomics.add(sh.rise, p, 1);
      sh.out[p] = d >= 0.5 ? 1 : 0;
      if (d >= 1) sh.out[p] = 1;
      if (d <= 0) sh.out[p] = 0;
    },
    analogWriteResolution(bits: number) { pwmMax = 2 ** bits - 1; },
    analogWriteRange(range: number) { pwmMax = range; },
    analogWriteFreq(hz: number) { pwmHz = hz; },
    analogReadResolution(bits: number) { adcBits = Math.max(1, Math.min(16, Math.round(Number(bits) || 10))); },
    tone(p: number, hz: number, ms?: number) {
      pin(p, 'tone');
      sh.mode[p] = MODE.OUTPUT;
      sh.duty[p] = 0.5;
      sh.hz[p] = hz;
      if (ms) toneEnds.set(p, now() + ms); // (it stops by itself after ms, while the program goes on)
      else toneEnds.delete(p);
    },
    noTone(p: number) { sh.hz[p] = 0; sh.out[p] = 0; toneEnds.delete(p); },
    /** interrupts: fn runs when the pin changes (checked as simulation time passes: within a step) */
    attachInterrupt(p: number, fn: () => void, mode: number) {
      pin(p, 'attachInterrupt');
      if (typeof fn !== 'function') throw new Error('attachInterrupt(pin, function, mode): the second thing must be a function');
      isrs.set(p, { fn, mode, last: sh.mode[p] === MODE.OUTPUT ? sh.out[p] : sh.inp[p] });
    },
    detachInterrupt(p: number) { isrs.delete(p); },
    digitalPinToInterrupt: (p: number) => p,
    interrupts() {},
    noInterrupts() {},
    CHANGE: 2, FALLING: 3, RISING: 4,
    delay(ms: number) { waitUntil(now() + Math.max(0, ms)); },
    delayMicroseconds(us: number) { waitUntil(now() + Math.max(0, us) / 1000); },
    NAN: NaN, INFINITY: Infinity,
    isnan: (x: number) => Number.isNaN(Number(x)),
    isinf: (x: number) => Math.abs(Number(x)) === Infinity,
    // (reading the clock takes the chip about a microsecond: a loop that waits by watching micros()
    //  lets time pass, as on the real board)
    millis: () => { timed(); clockRead(); return Math.floor(now()); },
    micros: () => { timed(); clockRead(); return Math.floor(now() * 1000); },
    pulseIn(p: number, level: number, timeout = 1000000) {
      pin(p, 'pulseIn');
      const r = request(REQ.PULSE_IN, p, level ? 1 : 0, timeout);
      const us = r.status > timeout ? 0 : r.status; // longer than the timeout = timed out, like Arduino
      waitUntil(now() + (us > 0 ? us : timeout) / 1000); // pulseIn blocks for as long as the pulse lasts
      return us;
    },
    map: (x: number, a: number, b: number, c: number, d: number) => Math.trunc(((x - a) * (d - c)) / (b - a)) + c, // (whole numbers, as Arduino's map() works)
    constrain: (x: number, a: number, b: number) => Math.min(b, Math.max(a, x)),
    min: Math.min, max: Math.max, abs: Math.abs, round: Math.round, sqrt: Math.sqrt, pow: Math.pow, sq: (x: number) => x * x,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2, floor: Math.floor, ceil: Math.ceil, PI: Math.PI,
    random: (a: number, b?: number) => (b === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (b - a))),
    randomSeed() { /* the simulation's randomness isn't seeded */ },
    LSBFIRST: 0, MSBFIRST: 1,
    DEC: 10, HEX: 16, OCT: 8, BIN: 2, // (Serial.print(x, HEX))
    shiftOut(dataPin: number, clockPin: number, order: number, value: number) {
      for (let i = 0; i < 8; i++) {
        const bit = order === 0 ? (value >> i) & 1 : (value >> (7 - i)) & 1;
        api.digitalWrite(dataPin, bit);
        api.digitalWrite(clockPin, 1);
        api.digitalWrite(clockPin, 0);
      }
    },
    shiftIn(dataPin: number, clockPin: number, order: number) {
      let v = 0;
      for (let i = 0; i < 8; i++) {
        api.digitalWrite(clockPin, 1);
        const bit = api.digitalRead(dataPin);
        v |= order === 0 ? bit << i : bit << (7 - i);
        api.digitalWrite(clockPin, 0);
      }
      return v;
    },
    bitRead: (x: number, n: number) => (x >> n) & 1,
    bitSet: (x: number, n: number) => x | (1 << n),
    bitClear: (x: number, n: number) => x & ~(1 << n),
    lowByte: (x: number) => x & 0xff,
    highByte: (x: number) => (x >> 8) & 0xff,
  };
  delete api.true;

  const fmt = (x: any, f?: number) => {
    if (typeof x === 'boolean') return x ? '1' : '0'; // (Serial.print(true) prints 1, as on a board)
    if (typeof x === 'number' && f !== undefined) return f === 16 ? x.toString(16).toUpperCase() : f === 2 ? x.toString(2) : f === 8 ? x.toString(8) : f === 10 ? String(Math.trunc(x)) : x.toFixed(f);
    if (typeof x === 'number' && !Number.isInteger(x)) return x.toFixed(2); // Arduino prints floats with 2 decimals
    return typeof x === 'object' && x && x.toString === Object.prototype.toString ? JSON.stringify(x) : String(x); // (an IPAddress prints as 192.168.1.100)
  };
  const sprintf = (f: string, ...a: any[]) =>
    f.replace(/%(-?0?\d*)(?:\.(\d+))?(?:hh|h|ll|l|z|j|t)?([dfsxXcuie%])/g, (_m, w, p, t) => {
      if (t === '%') return '%';
      const v = a.shift();
      let s = t === 'f' ? Number(v).toFixed(p ? Number(p) : 6) : t === 'x' ? Number(v).toString(16) : t === 'X' ? Number(v).toString(16).toUpperCase()
        : t === 'c' ? String.fromCharCode(v) : t === 'd' || t === 'u' ? String(Math.trunc(v)) : String(v);
      const width = Math.abs(Number(w || 0));
      if (s.length < width) s = w.startsWith('-') ? s.padEnd(width) : s.padStart(width, w.startsWith('0') ? '0' : ' ');
      return s;
    });
  const Serial = {
    begin() {},
    end() {},
    print(x: any = '', f?: number) {
      serialOut += fmt(x, f);
      if (serialOut.length > 4000) flush();
      return 1;
    },
    println(x: any = '', f?: number) {
      Serial.print(x, f);
      serialOut += '\n';
      if (now() - lastFlush > 30) flush();
      return 1;
    },
    printf(f: string, ...a: any[]) { Serial.print(sprintf(f, ...a)); },
    /** a byte, a text, or a buffer and how many of it */
    write(b: any, n?: number) {
      if (typeof b === 'string') serialOut += n === undefined ? b : b.slice(0, n);
      else if (b && typeof b === 'object' && typeof b.length === 'number') {
        const end = Math.min(n ?? b.length, b.length);
        for (let i = 0; i < end; i++) serialOut += String.fromCharCode(Number(b[i]) & 255);
      } else serialOut += String.fromCharCode(Number(b) & 255);
      if (serialOut.length > 4000) flush();
      return 1;
    },
    available() {
      const h = Atomics.load(ctl, CTL.SERIAL_HEAD), t = Atomics.load(ctl, CTL.SERIAL_TAIL);
      return (h - t + 1024) % 1024;
    },
    read() {
      const h = Atomics.load(ctl, CTL.SERIAL_HEAD), t = Atomics.load(ctl, CTL.SERIAL_TAIL);
      if (h === t) return -1;
      const b = sh.serial[t];
      Atomics.store(ctl, CTL.SERIAL_TAIL, (t + 1) % 1024);
      return b;
    },
    readStringUntil(end: string) {
      let s = '';
      for (;;) {
        const b = Serial.read();
        if (b < 0) { waitUntil(now() + 1); if (!Serial.available()) break; continue; }
        if (String.fromCharCode(b) === end) break;
        s += String.fromCharCode(b);
      }
      return s;
    },
    flush() { flush(); },
  };
  let txAddr = 0, tx: number[] = [], rx: number[] = [];
  // I2C takes time on the wire: 9 clocks a byte (8 bits and the ACK) plus the address byte, start and
  // stop, and a little for the board's driver. 100 kHz unless the program sets it (Wire.setClock).
  let i2cHz = 100000;
  const i2cMs = (n: number) => (((1 + n) * 9 + 2) / i2cHz) * 1000 + 0.015;
  const Wire = {
    begin() {},
    setClock(hz: number) { i2cHz = Math.max(10000, Math.min(3400000, Number(hz) || 100000)); },
    beginTransmission(a: number) { txAddr = a; tx = []; },
    write(x: any, n?: number) {
      if (Array.isArray(x) || x instanceof Uint8Array) for (const b of Array.from(x).slice(0, n ?? x.length)) tx.push(Number(b) & 255);
      else tx.push(Number(x) & 255);
      return 1;
    },
    endTransmission() {
      if (tx.length > 500) throw new Error('Wire: more than 500 bytes in one transmission');
      spend(i2cMs(tx.length));
      return request(REQ.I2C_WRITE, txAddr, tx.length, 0, tx).status; // 0 ok, 2 no answer at that address
    },
    requestFrom(a: number, n: number) {
      spend(i2cMs(Math.min(n, 500)));
      const r = request(REQ.I2C_READ, a, Math.min(n, 500));
      rx = r.status === 0 ? r.data : [];
      return rx.length;
    },
    available: () => rx.length,
    read: () => (rx.length ? rx.shift()! : -1),
  };
  class Servo {
    private p = -1;
    private deg = 90;
    private lo = 500;
    private hi = 2500;
    private hz = 50;
    /** ESP32Servo: pulses this many times a second (servos 50; ESCs take up to 400-500) */
    setPeriodHertz(h: number) { this.hz = Math.max(20, Math.min(500, Number(h) || 50)); }
    attach(p: number, min?: number, max?: number) {
      this.p = pin(p, 'Servo.attach');
      if (min) this.lo = min;
      if (max) this.hi = max;
      sh.mode[p] = MODE.OUTPUT;
      return 1;
    }
    attached() { return this.p >= 0; }
    writeMicroseconds(us: number) {
      if (this.p < 0) throw new Error('Servo.write() before Servo.attach(pin)');
      sh.duty[this.p] = Math.max(0, Math.min(1, (us * this.hz) / 1e6)); // (50 Hz: a 20 ms frame)
      sh.hz[this.p] = this.hz;
      sh.out[this.p] = 0;
    }
    write(v: number) {
      if (v >= 200) return this.writeMicroseconds(v); // like Arduino: big numbers are microseconds
      this.deg = Math.max(0, Math.min(180, v));
      this.writeMicroseconds(this.lo + ((this.hi - this.lo) * this.deg) / 180);
    }
    read() { return this.deg; }
    detach() {
      if (this.p >= 0) { sh.hz[this.p] = 0; sh.duty[this.p] = 0; }
      this.p = -1;
    }
  }
  // ------------------------------------------------------------------------------- Wi-Fi (ESP32 & co)
  // The board joins the bench's own Wi-Fi network (set in the project), and its web server answers
  // real requests: the app opens a little web server for it on this PC and passes them in here.
  const enc = new TextEncoder(), dec = new TextDecoder();
  const needWifi = (fn: string) => {
    if (!init.wifi) throw new Error(`${fn}: this board has no Wi-Fi (use an ESP32 board)`);
  };
  class IPAddress {
    v: number[];
    constructor(a = 0, b = 0, c = 0, d = 0) { this.v = [a, b, c, d].map((x) => Number(x) & 255); }
    toString() { return this.v.join('.'); }
    operator() { return this.v; }
  }
  const unpackIp = (n: number) => new IPAddress((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  let wifiSsid = '';
  const WiFi = {
    mode() { needWifi('WiFi.mode'); return true; },
    setHostname() { return true; },
    setSleep() { return true; },
    persistent() {},
    config() { return true; },
    begin(ssid: string = '', pass: string = '') {
      needWifi('WiFi.begin');
      wifiSsid = String(ssid);
      const b = Array.from(enc.encode(JSON.stringify({ ssid: String(ssid), pass: String(pass ?? '') })));
      request(REQ.WIFI_JOIN, 1, b.length, 0, b);
      // boards like the UNO R4 WiFi (WiFiS3) wait in WiFi.begin until it has connected or failed;
      // an ESP32's returns at once (check WiFi.status() in a loop)
      if (init.wifiWaits) {
        const until = now() + 15000;
        while (now() < until) {
          const s = Atomics.load(ctl, CTL.WIFI_STATUS);
          if (s === 3 || s === 4 || s === 1) break;
          waitUntil(now() + 50);
        }
      }
      return Atomics.load(ctl, CTL.WIFI_STATUS);
    },
    softAP(ssid: string = '', pass: string = '') {
      needWifi('WiFi.softAP');
      wifiSsid = String(ssid);
      const b = Array.from(enc.encode(JSON.stringify({ ssid: String(ssid), pass: String(pass ?? '') })));
      request(REQ.WIFI_JOIN, 2, b.length, 0, b);
      return true;
    },
    disconnect() { request(REQ.WIFI_JOIN, 0); return true; },
    softAPdisconnect() { request(REQ.WIFI_JOIN, 0); return true; },
    reconnect() { return true; },
    status: () => Atomics.load(ctl, CTL.WIFI_STATUS),
    isConnected: () => Atomics.load(ctl, CTL.WIFI_STATUS) === 3,
    localIP: () => unpackIp(Atomics.load(ctl, CTL.WIFI_IP)),
    softAPIP: () => unpackIp(Atomics.load(ctl, CTL.WIFI_IP)),
    SSID: () => wifiSsid,
    RSSI: () => -52,
    macAddress: (out?: any) => {
      if (out && typeof out === 'object') { MAC.forEach((b, i) => (out[i] = b)); return out; }
      return MAC.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
    },
    getHostname: () => 'esp32',
  };
  const MDNS = { begin: () => true, addService: () => true, end: () => {} };
  const HTTP_METHODS: Record<string, number> = { DELETE: 0, GET: 1, HEAD: 2, POST: 3, PUT: 4, OPTIONS: 6, PATCH: 28 };
  class WebServer {
    private routes: { path: string; method: number; fn: () => void }[] = [];
    private notFound: (() => void) | null = null;
    private req: { method: string; path: string; args: Record<string, string>; body: string; headers: Record<string, string> } | null = null;
    private resp: { status: number; type: string; body: string; headers: Record<string, string> } | null = null;
    private hdrs: Record<string, string> = {};
    constructor(public port = 80) {}
    on(path: string, a: any, b?: any) {
      const [method, fn] = typeof a === 'function' ? [255, a] : [Number(a), b];
      this.routes.push({ path: String(path), method, fn });
    }
    onNotFound(fn: () => void) { this.notFound = fn; }
    begin(port?: number) {
      needWifi('WebServer.begin');
      if (port) this.port = port;
      request(REQ.HTTP_LISTEN, this.port);
    }
    close() {}
    stop() {}
    /** call it in loop(): answers a waiting request, if there is one */
    handleClient() {
      if (Atomics.load(ctl, CTL.HTTP) !== 1) return;
      try {
        this.req = JSON.parse(dec.decode(sh.httpReq.slice(0, ctl[CTL.HTTP_LEN])));
      } catch {
        this.req = { method: 'GET', path: '/', args: {}, body: '', headers: {} };
      }
      this.resp = null;
      this.hdrs = {};
      const m = HTTP_METHODS[this.req!.method] ?? 1;
      const route = this.routes.find((r) => r.path === this.req!.path && (r.method === 255 || r.method === m));
      try {
        if (route) route.fn();
        else if (this.notFound) this.notFound();
        else this.send(404, 'text/plain', `Not found: ${this.req!.path}`);
      } catch (e: any) {
        this.resp = { status: 500, type: 'text/plain', body: `The sketch's handler crashed: ${e?.message ?? e}`, headers: {} };
        warnOnce(`http:${this.req!.path}`, `the web handler for ${this.req!.path} crashed: ${e?.message ?? e}`);
      }
      if (!this.resp) this.resp = { status: 500, type: 'text/plain', body: `The handler for ${this.req!.path} sent nothing: end it with server.send(200, "text/html", page);`, headers: {} };
      let bytes = enc.encode(JSON.stringify(this.resp));
      if (bytes.length > sh.httpResp.length) bytes = enc.encode(JSON.stringify({ status: 500, type: 'text/plain', body: 'The page is bigger than 1 MB.', headers: {} }));
      sh.httpResp.set(bytes);
      ctl[CTL.HTTP_RESP_LEN] = bytes.length;
      Atomics.store(ctl, CTL.HTTP, 2);
    }
    send(code: number, type = 'text/html', body: any = '') { this.resp = { status: Number(code) || 200, type: String(type), body: String(body ?? ''), headers: this.hdrs }; }
    send_P(code: number, type: string, body: any) { this.send(code, type, body); }
    /** who asked (here: always this PC) */
    client() { return { remoteIP: () => new IPAddress(127, 0, 0, 1), connected: () => true, stop() {} }; }
    sendHeader(name: string, value: any) { this.hdrs[String(name)] = String(value); }
    arg(name: string | number) {
      const a = this.req?.args ?? {};
      return typeof name === 'number' ? Object.values(a)[name] ?? '' : a[name] ?? '';
    }
    hasArg(name: string) { return !!this.req && name in this.req.args; }
    args() { return Object.keys(this.req?.args ?? {}).length; }
    argName(i: number) { return Object.keys(this.req?.args ?? {})[i] ?? ''; }
    header(name: string) { return this.req?.headers[String(name).toLowerCase()] ?? ''; }
    hasHeader(name: string) { return !!this.req && String(name).toLowerCase() in this.req.headers; }
    uri() { return this.req?.path ?? ''; }
    method() { return HTTP_METHODS[this.req?.method ?? 'GET'] ?? 1; }
  }
  // WiFiServer / WiFiClient: the lower-level way (WiFiS3, WiFiNINA, ESP32's WiFi.h): the sketch reads
  // the request text itself and prints the whole reply, status line and headers included.
  let clientOpen = false;
  class WiFiClient {
    private inp: string;
    private out = '';
    private open = true;
    constructor(raw = '') { this.inp = raw; }
    available() { return this.inp.length; }
    connected() { return this.open; }
    read() {
      if (!this.inp.length) return -1;
      const c = this.inp.charCodeAt(0);
      this.inp = this.inp.slice(1);
      return c;
    }
    peek() { return this.inp.length ? this.inp.charCodeAt(0) : -1; }
    readStringUntil(end: string) {
      const i = this.inp.indexOf(String(end)[0]);
      const s = i < 0 ? this.inp : this.inp.slice(0, i);
      this.inp = i < 0 ? '' : this.inp.slice(i + 1);
      return s;
    }
    readString() { const s = this.inp; this.inp = ''; return s; }
    flush() {}
    setTimeout() {}
    print(x: any = '', f?: number) { this.out += fmt(x, f); return 1; }
    println(x: any = '', f?: number) { this.out += fmt(x, f) + '\r\n'; return 1; }
    printf(f: string, ...a: any[]) { this.out += sprintf(f, ...a); }
    write(x: any) { this.out += typeof x === 'number' ? String.fromCharCode(x) : String(x); return 1; }
    /** the reply is complete: send it (status line, headers, a blank line, then the page) */
    stop() {
      if (!this.open) return;
      this.open = false;
      clientOpen = false;
      const text = this.out;
      const m = /^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n/.exec(text);
      let status = 200, type = 'text/html', body = text;
      const headers: Record<string, string> = {};
      if (m) {
        status = Number(m[1]);
        const rest = text.slice(m[0].length);
        const blank = /\r?\n\r?\n/.exec(rest);
        const head = blank ? rest.slice(0, blank.index) : rest;
        body = blank ? rest.slice(blank.index + blank[0].length) : '';
        for (const line of head.split(/\r?\n/)) {
          const h = /^([^:]+):\s*(.*)$/.exec(line);
          if (!h) continue;
          if (/^content-type$/i.test(h[1])) type = h[2].trim();
          else if (!/^(connection|content-length)$/i.test(h[1])) headers[h[1].trim()] = h[2].trim();
        }
      } else warnOnce('rawhttp', 'the reply to a web request had no "HTTP/1.1 200 OK" line first: sent as a page anyway');
      let bytes = enc.encode(JSON.stringify({ status, type, body, headers }));
      if (bytes.length > sh.httpResp.length) bytes = enc.encode(JSON.stringify({ status: 500, type: 'text/plain', body: 'The page is bigger than 1 MB.', headers: {} }));
      sh.httpResp.set(bytes);
      ctl[CTL.HTTP_RESP_LEN] = bytes.length;
      Atomics.store(ctl, CTL.HTTP, 2);
    }
    valueOf() { return this.open; } // ("if (client)")
  }
  class WiFiServer {
    constructor(public port = 80) {}
    begin(port?: number) {
      needWifi('WiFiServer.begin');
      if (port) this.port = port;
      request(REQ.HTTP_LISTEN, this.port);
    }
    /** a browser's request, as a connected client, or null when none is waiting */
    available() {
      if (clientOpen || Atomics.load(ctl, CTL.HTTP) !== 1) return null;
      let req: { method: string; url?: string; path: string; headers: Record<string, string>; body: string };
      try {
        req = JSON.parse(dec.decode(sh.httpReq.slice(0, ctl[CTL.HTTP_LEN])));
      } catch {
        req = { method: 'GET', path: '/', headers: {}, body: '' };
      }
      const raw = `${req.method} ${req.url ?? req.path} HTTP/1.1\r\n${Object.entries(req.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${req.body ?? ''}`;
      clientOpen = true;
      return new WiFiClient(raw);
    }
    accept() { return this.available(); }
  }

  Object.assign(api, {
    WiFiServer, WiFiClient,
    WiFi, WebServer, IPAddress, MDNS,
    // (an ESP8266's names for the same things: ESP8266WiFi.h, ESP8266WebServer.h, ESP8266mDNS.h)
    ESP8266WebServer: WebServer,
    // (the chip's own odds and ends, as sketches print them)
    ESP: {
      getChipId: () => 0x3c7a1d, getEfuseMac: () => 0x104cb3286f24, getFreeHeap: () => 210000, getHeapSize: () => 327680,
      getChipModel: () => 'ESP32', getChipRevision: () => 3, getCpuFreqMHz: () => 240, getFlashChipSize: () => 4194304, getSdkVersion: () => 'v5.1',
      restart: () => warnOnce('esprestart', 'ESP.restart(): on the bench the program carries on (press Stop and Run to restart it)'),
      deepSleep: () => warnOnce('espsleep', 'ESP.deepSleep(): on the bench the program carries on'),
    },
    WL_IDLE_STATUS: 0, WL_NO_SSID_AVAIL: 1, WL_SCAN_COMPLETED: 2, WL_CONNECTED: 3, WL_CONNECT_FAILED: 4, WL_CONNECTION_LOST: 5, WL_DISCONNECTED: 6,
    WIFI_OFF: 0, WIFI_STA: 1, WIFI_AP: 2, WIFI_AP_STA: 3,
    HTTP_ANY: 255, HTTP_DELETE: 0, HTTP_GET: 1, HTTP_HEAD: 2, HTTP_POST: 3, HTTP_PUT: 4, HTTP_PATCH: 28,
  });

  // ------------------------------------------------------------------------------- ESP-NOW, Bluetooth
  // ESP-NOW: short messages straight from one ESP32 to another (no router), by MAC address. What's
  // sent is a copy of what the sketch hands over (bytes, a text, or a struct's fields), so the usual
  // memcpy(&myData, incomingData, sizeof(myData)) on the other board fills its struct.
  const BROADCAST = 'ff:ff:ff:ff:ff:ff';
  const macKey = (m: any) => Array.from({ length: 6 }, (_, i) => Number(m?.[i] ?? 0) & 255).map((b) => b.toString(16).padStart(2, '0')).join(':');
  const macArray = (k: string) => k.split(':').map((h) => parseInt(h, 16));
  const espnow = { inited: false, peers: new Set<string>(), sendCb: null as null | ((mac: any, status: number) => void), recvCb: null as null | ((info: any, data: any, len: number) => void), inPump: false };
  class esp_now_peer_info_t { peer_addr = [0, 0, 0, 0, 0, 0]; channel = 0; encrypt = false; ifidx = 0; lmk = new Array(16).fill(0); priv = null; }
  const espnowPump = () => {
    if (espnow.inPump || !espnow.recvCb) return;
    espnow.inPump = true;
    try {
      pumpIn();
      const k = `${ESPNOW_PIN}:${protoCode('data')}`;
      const q = inbox.get(k) ?? [];
      inbox.delete(k);
      for (const m of q) {
        let msg: any;
        try { msg = JSON.parse(dec.decode(new Uint8Array(m.data))); } catch { continue; }
        const data: any = (msg.bytes ?? []).slice();
        while (data.length < msg.len) data.push(0);
        data.__obj = msg.obj;
        // (core 3 hands an info struct, core 2 the sender's MAC: this is both)
        const info: any = macArray(msg.from);
        info.src_addr = info;
        info.des_addr = MAC.slice();
        info.rx_ctrl = { rssi: -42 };
        espnow.recvCb(info, data, msg.len);
      }
    } finally {
      espnow.inPump = false;
    }
  };
  whileWaiting = espnowPump;
  const ESP_OK = 0, ESP_FAIL = -1, ESP_ERR_ESPNOW_NOT_INIT = 0x3065, ESP_ERR_ESPNOW_ARG = 0x3066, ESP_ERR_ESPNOW_NOT_FOUND = 0x3069, ESP_ERR_ESPNOW_EXIST = 0x306a;
  Object.assign(api, {
    esp_now_peer_info_t, ESP_OK, ESP_FAIL, ESP_ERR_ESPNOW_NOT_INIT, ESP_ERR_ESPNOW_ARG, ESP_ERR_ESPNOW_NOT_FOUND, ESP_ERR_ESPNOW_EXIST,
    ESP_NOW_SEND_SUCCESS: 0, ESP_NOW_SEND_FAIL: 1, ESP_NOW_ETH_ALEN: 6, ESP_NOW_MAX_DATA_LEN: 250, WIFI_IF_STA: 0, WIFI_IF_AP: 1, ESP_IF_WIFI_STA: 0,
    esp_now_init() {
      if (!init.wifi) throw new Error('esp_now_init(): this board has no Wi-Fi radio');
      espnow.inited = true;
      return ESP_OK;
    },
    esp_now_deinit() { espnow.inited = false; return ESP_OK; },
    esp_now_register_send_cb(fn: any) { espnow.sendCb = typeof fn === 'function' ? fn : null; return ESP_OK; },
    esp_now_register_recv_cb(fn: any) { espnow.recvCb = typeof fn === 'function' ? fn : null; return ESP_OK; },
    esp_now_add_peer(p: any) {
      const peer = p instanceof Ref ? p.value : p;
      const k = macKey(peer?.peer_addr);
      if (espnow.peers.has(k)) return ESP_ERR_ESPNOW_EXIST;
      espnow.peers.add(k);
      return ESP_OK;
    },
    esp_now_del_peer(mac: any) { return espnow.peers.delete(macKey(mac)) ? ESP_OK : ESP_ERR_ESPNOW_NOT_FOUND; },
    esp_now_is_peer_exist(mac: any) { return espnow.peers.has(macKey(mac)); },
    esp_now_send(mac: any, data: any, len: number) {
      if (!espnow.inited) return ESP_ERR_ESPNOW_NOT_INIT;
      const targets = mac ? [macKey(mac)] : [...espnow.peers];
      if (mac && targets[0] !== BROADCAST && !espnow.peers.has(targets[0])) {
        warnOnce('espnowpeer', `esp_now_send to ${targets[0]}: add it with esp_now_add_peer() first`);
        return ESP_ERR_ESPNOW_NOT_FOUND;
      }
      const v = data instanceof Ref ? data.value : data;
      const n = Math.max(0, Math.min(250, Number(len) || 0));
      const bytes = Array.isArray(v) || v instanceof Uint8Array ? Array.from(v as ArrayLike<number>).slice(0, n).map((x) => Number(x) & 255)
        : typeof v === 'string' ? Array.from(v).slice(0, n).map((c) => c.charCodeAt(0) & 255) : typeof v === 'number' ? [v & 255] : [];
      const obj = v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) ? JSON.parse(JSON.stringify(v)) : undefined;
      for (const to of targets) {
        const enc = new TextEncoder().encode(JSON.stringify({ to, from: macKey(MAC), len: n, bytes, obj }));
        if (enc.length > 512) { warnOnce('espnowbig', 'esp_now_send: that message is too big (at most 250 bytes)'); return ESP_ERR_ESPNOW_ARG; }
        const got = request(REQ.ESPNOW, enc.length, 0, 0, Array.from(enc)).status;
        espnow.sendCb?.(macArray(to), to === BROADCAST || got > 0 ? 0 : 1);
      }
      return ESP_OK;
    },
  });
  // BluetoothSerial (an ESP32's classic Bluetooth serial): what it prints shows in the serial monitor
  // marked [BT], and it reads what you type there, as a phone's Bluetooth terminal would send it.
  class BluetoothSerial {
    private started = false;
    private name = 'ESP32';
    private fresh = true;
    begin(name: any = 'ESP32') { this.name = String(name); this.started = true; Serial.println(`[BT] "${this.name}" is ready: a phone can pair with it`); return true; }
    end() { this.started = false; }
    private out(text: string) {
      if (!this.started) return;
      let s = '';
      for (const ch of text) { if (this.fresh) { s += '[BT] '; this.fresh = false; } s += ch; if (ch === '\n') this.fresh = true; }
      Serial.print(s);
    }
    print(x: any = '', f?: number) { this.out(fmt(x, f)); return 1; }
    println(x: any = '', f?: number) { this.out(fmt(x, f) + '\n'); return 1; }
    printf(f: string, ...a: any[]) { this.out(sprintf(f, ...a)); }
    write(b: any) { this.out(typeof b === 'number' ? String.fromCharCode(b) : String(b)); return 1; }
    available() { return this.started ? Serial.available() : 0; }
    read() { return this.started ? Serial.read() : -1; }
    readStringUntil(end: string) { return Serial.readStringUntil(end); }
    readString() { let s = ''; while (Serial.available()) s += String.fromCharCode(Serial.read()); return s; }
    hasClient() { return this.started; }
    connected() { return this.started; }
    flush() {}
    register_callback() {}
    enableSSP() {}
    setPin() { return true; }
  }
  Object.assign(api, { BluetoothSerial });

  // ------------------------------------------------------------------------------- the UNO R4 WiFi's LED matrix
  // Arduino_LED_Matrix.h (+ ArduinoGraphics.h for text and shapes), as Arduino's own code does it
  // (tools/vendor/ledmatrix): 96 LEDs, 12 a row, 8 rows; a picture is 3 words, LED 0 = the first
  // word's top bit. What it shows goes to the board in the simulation (MATRIX_PIN) when it changes.
  let matrixShown = '';
  let matrixFrames = 0;
  const matrixShow = (words: number[]) => {
    const bytes = new Array(12).fill(0);
    for (let i = 0; i < 96; i++) if ((((words[i >> 5] ?? 0) >>> (31 - (i & 31))) & 1) === 1) bytes[i >> 3] |= 1 << (i & 7);
    const key = bytes.join(',');
    if (key === matrixShown) return;
    matrixShown = key;
    if (!init.matrix) return;
    matrixFrames++;
    const raw = { pin: MATRIX_PIN, proto: protoCode('data'), baud: 0, data: bytes };
    while (!ringWrite(sh.pktOut, ctl, CTL.PKO_HEAD, CTL.PKO_TAIL, raw)) {
      const s = Atomics.load(ctl, CTL.STEP);
      Atomics.wait(ctl, CTL.STEP, s, 50);
    }
  };
  const unref = (a: any): any => (a instanceof Ref ? a.value : a);
  const flatNums = (a: any): number[] => {
    a = unref(a);
    return Array.isArray(a) || ArrayBuffer.isView(a) ? Array.from(a as ArrayLike<any>).flatMap(flatNums) : [Number(a) || 0];
  };
  const SCROLL = { NO_SCROLL: 0, SCROLL_LEFT: 1, SCROLL_RIGHT: 2, SCROLL_UP: 3, SCROLL_DOWN: 4 };
  class ArduinoLEDMatrix {
    // the matrix
    private frames: number[][] = [];
    private cur = 0;
    private interval = 0;
    private last = 0;
    private looping = false;
    private done = false;
    private cb: (() => void) | null = null;
    private ticking = false;
    // ArduinoGraphics (a global object starts zeroed, as here: no stroke until stroke() is called)
    private canvas: number[][] = Array.from({ length: 8 }, () => new Array(12).fill(0));
    private font: { w: number; h: number; glyphs: (number[] | null)[] } | null = null;
    private strokeOn = false;
    private sc = 0;
    private fillOn = false;
    private fc = 0;
    private bg = 0;
    private tc = 0;
    private textBuf = '';
    private tx = 0;
    private ty = 0;
    private sx = 1;
    private sy = 1;
    private gScroll = 0; // (ArduinoGraphics' own speed: 0 until textScrollSpeed() sets it)
    private mScroll = 100;
    begin() {
      if (!init.matrix) warnOnce('nomatrix', 'ArduinoLEDMatrix: this board has no LED matrix (the UNO R4 WiFi has one): nothing shows');
      if (!this.ticking) {
        this.ticking = true;
        // (the real one checks every 0.1 ms: millis() - last > interval. Here it's looked at when the
        // program waits or loops, so each frame starts when it was due, not when it was noticed)
        tickers.push(() => {
          for (let n = 0; n < 200 && this.interval !== 0; n++) {
            const due = this.last + this.interval + 1;
            if (now() < due) break;
            this.next();
            // (far behind, as autoscroll() without play(): from now on, as the real one does)
            this.last = now() - due > 1000 ? Math.floor(now()) : due;
          }
        });
      }
      return 1;
    }
    end() {}
    autoscroll(ms: number) { this.interval = Number(ms) >>> 0; }
    /** one LED on or off at once (by its number, 0-95) */
    on(i: number) { this.poke(i, 1); }
    off(i: number) { this.poke(i, 0); }
    private poke(i: number, v: number) {
      const w = this.shownWords();
      i = Number(i);
      if (!(i >= 0 && i < 96)) return;
      const bit = 1 << (31 - (i & 31));
      w[i >> 5] = (v ? w[i >> 5] | bit : w[i >> 5] & ~bit) >>> 0;
      matrixShow(w);
    }
    private shownWords() {
      const b = matrixShown ? matrixShown.split(',').map(Number) : new Array(12).fill(0);
      const w = [0, 0, 0];
      for (let i = 0; i < 96; i++) if ((b[i >> 3] >> (i & 7)) & 1) w[i >> 5] |= 1 << (31 - (i & 31));
      return w.map((x) => x >>> 0);
    }
    next() {
      if (!this.frames.length) return;
      const f = this.frames[this.cur];
      this.interval = f[3] >>> 0;
      this.cur = (this.cur + 1) % this.frames.length;
      if (this.cur === 0) {
        if (!this.looping) this.interval = 0;
        this.cb?.();
        this.done = true;
      }
      matrixShow(f);
    }
    loadFrame(buf: any) {
      const w = flatNums(buf);
      this.frames = [[w[0] >>> 0, w[1] >>> 0, w[2] >>> 0, 0]];
      this.cur = 0;
      this.next();
      this.interval = 0;
    }
    renderFrame(n: number) {
      if (!this.frames.length) return;
      this.cur = (Number(n) || 0) % this.frames.length;
      this.next();
      this.interval = 0;
    }
    play(loop = false) {
      this.looping = !!loop;
      this.done = false;
      this.last = Math.floor(now());
      this.next();
    }
    sequenceDone() {
      if (this.done) { this.done = false; return true; }
      return false;
    }
    loadSequence(frames: any) {
      const all = flatNums(frames);
      this.frames = [];
      for (let i = 0; i + 3 < all.length; i += 4) this.frames.push(all.slice(i, i + 4).map((x) => x >>> 0));
      this.cur = 0;
    }
    loadWrapper(frames: any) { this.loadSequence(frames); }
    /** a picture as 0/1 pixels: renderBitmap(frame, 8, 12) with uint8_t frame[8][12] */
    renderBitmap(bitmap: any, rows = 8, cols = 12) { this.loadPixels(bitmap, (Number(rows) || 8) * (Number(cols) || 12)); }
    loadPixels(arr: any, size = 96) {
      // (as the real one packs them: one bit each, the top bit first, 32 to a word)
      const px = flatNums(arr), words: number[] = [];
      let part = 0;
      for (let i = 0; i < size; i++) {
        part = (part | ((px[i] ?? 0) & 255)) >>> 0;
        if ((i + 1) % 32 === 0) words.push(part);
        part = (part << 1) >>> 0;
      }
      this.loadFrame(words);
    }
    setCallback(fn: any) { this.cb = typeof fn === 'function' ? fn : null; }
    clear() {
      this.loadFrame([0, 0, 0]);
      for (const r of this.canvas) r.fill(0);
    }
    // --- ArduinoGraphics
    width() { return 12; }
    height() { return 8; }
    beginDraw() {}
    endDraw() { this.loadPixels(this.canvas, 96); }
    set(x: number, y: number, r: number, g = r, b = r) {
      x = Math.trunc(x); y = Math.trunc(y);
      if (y >= 8 || x >= 12 || y < 0 || x < 0) return;
      this.canvas[y][x] = ((r | g | b) & 0xffffff) > 0 ? 1 : 0;
    }
    private col = (a: any[]) => (a.length >= 3 ? ((a[0] & 255) << 16) | ((a[1] & 255) << 8) | (a[2] & 255) : Number(a[0]) >>> 0) & 0xffffff;
    background(...a: any[]) { if (!a.length) return this.bg; this.bg = this.col(a); }
    fill(...a: any[]) { this.fillOn = true; this.fc = this.col(a); }
    noFill() { this.fillOn = false; }
    stroke(...a: any[]) { this.strokeOn = true; this.sc = this.col(a); }
    noStroke() { this.strokeOn = false; }
    point(x: number, y: number) { if (this.strokeOn) this.set(x, y, this.sc); }
    line(x1: number, y1: number, x2: number, y2: number) {
      if (!this.strokeOn) return;
      [x1, y1, x2, y2] = [x1, y1, x2, y2].map(Math.trunc);
      if (x1 === x2) { for (let y = y1; y <= y2; y++) this.set(x1, y, this.sc); return; }
      if (y1 === y2) { for (let x = x1; x <= x2; x++) this.set(x, y1, this.sc); return; }
      // (Bresenham, as theirs)
      const steep = Math.abs(y2 - y1) >= Math.abs(x2 - x1);
      if (!steep && x1 > x2) [x1, y1, x2, y2] = [x2, y2, x1, y1];
      if (steep && y1 > y2) [x1, y1, x2, y2] = [x2, y2, x1, y1];
      const dx = x2 - x1, dy = y2 - y1;
      if (!steep) {
        const yi = dy < 0 ? -1 : 1, ady = Math.abs(dy);
        let D = 2 * ady - dx, y = y1;
        for (let x = x1; x <= x2; x++) { this.set(x, y, this.sc); if (D > 0) { y += yi; D -= 2 * dx; } D += 2 * ady; }
      } else {
        const xi = dx < 0 ? -1 : 1, adx = Math.abs(dx);
        let D = 2 * adx - dy, x = x1;
        for (let y = y1; y <= y2; y++) { this.set(x, y, this.sc); if (D > 0) { x += xi; D -= 2 * dy; } D += 2 * adx; }
      }
    }
    rect(x: number, y: number, w: number, h: number) {
      if (!this.strokeOn && !this.fillOn) return;
      const x1 = Math.trunc(x), y1 = Math.trunc(y), x2 = x1 + Math.trunc(w) - 1, y2 = y1 + Math.trunc(h) - 1;
      for (let i = x1; i <= x2; i++)
        for (let j = y1; j <= y2; j++) {
          if ((i === x1 || i === x2 || j === y1 || j === y2) && this.strokeOn) this.set(i, j, this.sc);
          else if (this.fillOn) this.set(i, j, this.fc);
        }
    }
    circle(x: number, y: number, d: number) { this.ellipse(x, y, d, d); }
    ellipse(x: number, y: number, w: number, h: number) {
      if (!this.strokeOn && !this.fillOn) return;
      const a = Math.trunc(w / 2), b = Math.trunc(h / 2), a2 = a * a, b2 = b * b;
      if (this.fillOn) for (let j = -b; j <= b; j++) for (let i = -a; i <= a; i++) if (i * i * b2 + j * j * a2 <= a2 * b2) this.set(x + i, y + j, this.fc);
      if (this.strokeOn) {
        for (let i = -a; i <= a; i++) { const yv = Math.trunc(b * Math.sqrt(Math.max(0, 1 - (i * i) / (a2 || 1)))); this.set(x + i, y + yv, this.sc); this.set(x + i, y - yv, this.sc); }
        for (let j = -b; j <= b; j++) { const xv = Math.trunc(a * Math.sqrt(Math.max(0, 1 - (j * j) / (b2 || 1)))); this.set(x + xv, y + j, this.sc); this.set(x - xv, y + j, this.sc); }
      }
    }
    textFont(f: any) { this.font = f && typeof f === 'object' && Array.isArray(f.glyphs) ? f : null; }
    textSize(sx: number, sy = sx) { this.sx = Number(sx) > 0 ? Math.trunc(sx) : 1; this.sy = Number(sy) > 0 ? Math.trunc(sy) : 1; }
    textFontWidth() { return this.font ? this.font.w * this.sx : 0; }
    textFontHeight() { return this.font ? this.font.h * this.sy : 0; }
    private bitmap(rows: number[] | null, x: number, y: number, w: number, h: number) {
      if (!this.strokeOn || !rows || x + w * this.sx < 0 || y + h * this.sy < 0 || x > 12 || y > 8) return;
      for (let j = 0; j < h; j++) {
        const b = rows[j] ?? 0;
        for (let ys = 0; ys < this.sy; ys++) {
          let xx = x;
          for (let i = 0; i < w; i++) {
            const on = b & (1 << (7 - i));
            for (let xs = 0; xs < this.sx; xs++) this.set(xx++, y, on ? this.sc : this.bg);
            if (xx >= 12) break;
          }
          y++;
        }
      }
    }
    text(str: any, x = 0, y = 0) {
      if (!this.font || !this.strokeOn) return;
      for (const ch of String(str ?? '')) {
        const c = ch.charCodeAt(0) & 255;
        if (ch === '\n') y += this.font.h * this.sy;
        else if (ch === '\r') x = 0;
        else {
          this.bitmap(this.font.glyphs[c] ?? this.font.glyphs[0x20] ?? null, x, y, this.font.w, this.font.h);
          x += this.font.w * this.sx;
        }
      }
    }
    // Print: what's printed between beginText and endText is the text
    write(b: any) { this.textBuf += typeof b === 'number' ? String.fromCharCode(b) : String(b); return 1; }
    print(x: any = '', f?: number) { this.textBuf += fmt(x, f); return 1; }
    println(x: any = '', f?: number) { this.textBuf += fmt(x, f) + '\r\n'; return 1; }
    flush() { this.textBuf = ''; }
    beginText(x = 0, y = 0, ...c: any[]) {
      this.textBuf = '';
      this.tx = Math.trunc(x);
      this.ty = Math.trunc(y);
      if (c.length) this.tc = this.col(c);
    }
    textScrollSpeed(ms = 150) { this.gScroll = this.mScroll = Math.max(0, Number(ms) || 0); }
    endText(dir = 0) {
      const keep = [this.strokeOn, this.sc] as const;
      const space = this.font?.glyphs[0x20] ?? null, fontW = this.font?.w ?? 0, fontH = this.font?.h ?? 0;
      const t = this.textBuf, n = t.length, fw = this.textFontWidth(), fh = this.textFontHeight();
      const frame = (draw: () => void) => { draw(); this.endDraw(); api.delay(this.gScroll); };
      if (dir === SCROLL.SCROLL_LEFT) {
        const len = n * fw + this.tx + 1;
        for (let i = 0; i < len; i++) frame(() => {
          const x = this.tx - i;
          this.stroke(this.tc); this.text(t, x, this.ty);
          const cx = x + n * fw;
          this.stroke(this.bg); this.line(cx, this.ty, cx, this.ty + fh - 1);
        });
      } else if (dir === SCROLL.SCROLL_RIGHT) {
        const len = n * fw + this.tx;
        for (let i = 0; i < len; i++) frame(() => {
          const x = this.tx - (len - i - 1);
          this.stroke(this.tc); this.text(t, x, this.ty);
          this.stroke(this.bg); this.line(x - 1, this.ty, x - 1, this.ty + fh - 1);
          this.bitmap(space, x - 1, this.ty, 1, fontH);
        });
      } else if (dir === SCROLL.SCROLL_UP) {
        const len = fh + this.ty + 1;
        for (let i = 0; i < len; i++) frame(() => {
          const y = this.ty - i;
          this.stroke(this.tc); this.text(t, this.tx, y);
          this.stroke(this.bg); this.line(this.tx, y + fh, this.tx + fw * n - 1, y + fh);
        });
      } else if (dir === SCROLL.SCROLL_DOWN) {
        const len = fh + this.ty;
        for (let i = 0; i < len; i++) frame(() => {
          const y = this.ty - (len - i - 1);
          this.stroke(this.tc); this.text(t, this.tx, y);
          this.stroke(this.bg); this.line(this.tx, y - 1, this.tx + fw * n - 1, y - 1);
          this.bitmap(space, this.tx, y - 1, fontW, 1);
        });
      } else {
        this.stroke(this.tc);
        this.text(t, this.tx, this.ty);
      }
      if (keep[0]) this.stroke(keep[1]); else this.noStroke();
      this.textBuf = '';
      this.endDraw(); // (the matrix's endText shows the canvas)
    }
  }
  Object.assign(api, { ArduinoLEDMatrix, ...SCROLL, NUM_LEDS: 96, ...MATRIX_FONTS, ...LEDMATRIX_GALLERY });

  // ------------------------------------------------------------------------------- Bluetooth LE (ArduinoBLE)
  // The board as a BLE peripheral, the thing a phone app connects to. Its services and values go to
  // the bench (BLE_PIN), where the run panel is the phone: it connects, sees the values (and their
  // notifications) and writes. As in ArduinoBLE, what the phone did reaches the program only in
  // BLE.poll(), BLE.central() and central.connected() / BLE.connected(); its event handlers run there.
  const BLE_EVENTS = { BLEConnected: 0, BLEDisconnected: 1, BLEDiscovered: 2, BLESubscribed: 0, BLEUnsubscribed: 1, BLEWritten: 3, BLEUpdated: 3 };
  const bleSend = (m: any) => {
    if (!init.ble) return;
    const data = Array.from(enc.encode(JSON.stringify(m)));
    if (data.length > 4096) { warnOnce('blebig', 'Bluetooth: too many services and values to show (most 4 KB of them)'); return; }
    const raw = { pin: BLE_PIN, proto: protoCode('data'), baud: 0, data };
    while (!ringWrite(sh.pktOut, ctl, CTL.PKO_HEAD, CTL.PKO_TAIL, raw)) {
      const s = Atomics.load(ctl, CTL.STEP);
      Atomics.wait(ctl, CTL.STEP, s, 50);
    }
  };
  const PHONE = '7c:2e:0d:1a:b4:42'; // (the bench's phone)
  const ble = {
    begun: false, name: 'Arduino', advertising: false, advService: '', connected: false, central: '', connectable: true,
    services: [] as BLEService[], chars: new Map<string, BLECharacteristic>(), handlers: new Map<number, (d: any) => void>(),
  };
  const bleFire = (ev: number, d: any) => { const f = ble.handlers.get(ev); if (f) f(d); };
  const bleTable = () => {
    if (!ble.begun) return;
    bleSend({
      t: 'gatt', name: ble.name, adv: ble.advertising, advService: ble.advService, connected: ble.connected,
      chars: [...ble.chars.values()].map((c) => ({ uuid: c.uuidStr, svc: c.svc, props: c.props, kind: c.kind, size: c.size, bytes: c.bytes, desc: c.desc })),
    });
  };
  const bleUuid = (u: any) => String(u ?? '').trim().toLowerCase();
  class BLEDescriptor {
    uuidStr: string;
    text: string;
    constructor(uuid: any, value: any = '') { this.uuidStr = bleUuid(uuid); this.text = typeof value === 'string' ? value : ''; }
    uuid() { return this.uuidStr; }
  }
  class BLECharacteristic {
    uuidStr: string;
    props: number;
    size: number;
    fixed: boolean;
    kind: BleKind;
    bytes: number[] = [];
    svc = '';
    desc = '';
    private wasWritten = false;
    subs = false;
    handlers = new Map<number, (d: any, c: any) => void>();
    constructor(uuid: any, props: any = 0, size: any = 0, fixed: any = false, kind: BleKind = 'bytes') {
      this.uuidStr = bleUuid(uuid);
      this.props = Number(props) || 0;
      this.kind = kind;
      if (typeof size === 'string') { this.bytes = bleEncode('bytes', size); this.size = Math.max(this.bytes.length, 1); }
      else this.size = Math.max(0, Math.min(512, Number(size) || 0));
      this.fixed = !!fixed;
    }
    uuid() { return this.uuidStr; }
    properties() { return this.props; }
    valueSize() { return this.size; }
    valueLength() { return this.bytes.length; }
    value(): any { return this.bytes.slice(); }
    /** (from the phone) */
    took(bytes: number[]) {
      this.bytes = bytes.slice(0, this.size || 512);
      this.wasWritten = true;
    }
    readValue(buf: any, len?: number) {
      const out = unref(buf);
      const n = Math.min(this.bytes.length, len ?? (Array.isArray(out) || ArrayBuffer.isView(out) ? (out as any).length : 4));
      if (Array.isArray(out) || ArrayBuffer.isView(out)) { for (let i = 0; i < n; i++) (out as any)[i] = this.bytes[i]; }
      else if (buf instanceof Ref) buf.value = this.bytes.slice(0, n).reduce((a, b, i) => a + b * 2 ** (8 * i), 0);
      return n;
    }
    protected put(bytes: number[]) {
      const cut = bytes.slice(0, this.size || 512);
      const changed = cut.length !== this.bytes.length || cut.some((b, i) => b !== this.bytes[i]);
      this.bytes = cut;
      // (to the phone: its new value; a notification if it's subscribed)
      if (ble.chars.get(this.uuidStr) === this && (changed || this.subs)) bleSend({ t: 'val', uuid: this.uuidStr, bytes: cut });
      return 1;
    }
    writeValue(v: any, len?: any, _withResponse?: any) {
      v = unref(v);
      let bytes: number[];
      if (typeof v === 'number' || typeof v === 'boolean') {
        // (writeValue(uint8_t / int16_t / int32_t...): as many bytes as the value has room for)
        const n = typeof len === 'number' ? 0 : Math.min(4, this.size || 1);
        bytes = bleEncode(n === 1 ? 'u8' : n === 2 ? 'u16' : 'u32', Number(v)).slice(0, n || 1);
      } else bytes = bleEncode('bytes', v);
      if (typeof len === 'number') bytes = bytes.slice(0, Math.max(0, len));
      return this.put(bytes);
    }
    setValue(v: any, len?: any) { return this.writeValue(v, len); }
    broadcast() { return 1; }
    written() { const w = this.wasWritten; this.wasWritten = false; return w; }
    subscribed() { return this.subs; }
    valueUpdated() { return false; }
    setEventHandler(ev: number, fn: any) { if (typeof fn === 'function') this.handlers.set(Number(ev), fn); }
    addDescriptor(d: any) { if (d instanceof BLEDescriptor && d.uuidStr === '2901') this.desc = d.text; }
    descriptorCount() { return this.desc ? 1 : 0; }
    hasDescriptor(u: any) { return !!this.desc && bleUuid(u) === '2901'; }
    canRead() { return !!(this.props & BLE_PROPS.BLERead); }
    canWrite() { return !!(this.props & (BLE_PROPS.BLEWrite | BLE_PROPS.BLEWriteWithoutResponse)); }
    canSubscribe() { return !!(this.props & (BLE_PROPS.BLENotify | BLE_PROPS.BLEIndicate)); }
    canUnsubscribe() { return this.canSubscribe(); }
    read() { return false; }
    subscribe() { return false; }
    unsubscribe() { return false; }
    valueOf() { return true; } // ("if (characteristic)")
  }
  const typedChar = (kind: BleKind) =>
    class extends BLECharacteristic {
      constructor(uuid: any, props: any = 0) {
        super(uuid, props, BLE_SIZE[kind], true, kind);
        this.bytes = bleEncode(kind, 0); // (it starts at 0, as theirs)
      }
      value() { return bleDecode(kind, this.bytes); }
      valueLE() { return this.value(); }
      valueBE() { return bleDecode(kind, this.bytes.slice().reverse()); }
      writeValue(v: any) { return this.put(bleEncode(kind, unref(v))); }
      setValue(v: any) { return this.writeValue(v); }
      writeValueLE(v: any) { return this.writeValue(v); }
      writeValueBE(v: any) { return this.put(bleEncode(kind, unref(v)).reverse()); }
    };
  class BLEStringCharacteristic extends BLECharacteristic {
    constructor(uuid: any, props: any = 0, maxLen: any = 20) { super(uuid, props, Number(maxLen) || 20, false, 'string'); }
    value() { return bleDecode('string', this.bytes); }
    writeValue(v: any) { return this.put(bleEncode('string', String(unref(v) ?? ''))); }
    setValue(v: any) { return this.writeValue(v); }
  }
  class BLEService {
    uuidStr: string;
    chars: BLECharacteristic[] = [];
    constructor(uuid: any) { this.uuidStr = bleUuid(uuid); }
    uuid() { return this.uuidStr; }
    addCharacteristic(c: BLECharacteristic) {
      if (!(c instanceof BLECharacteristic)) throw new Error('addCharacteristic: that is not a BLE characteristic');
      c.svc = this.uuidStr;
      if (!this.chars.includes(c)) this.chars.push(c);
    }
    characteristicCount() { return this.chars.length; }
    hasCharacteristic(u: any) { return this.chars.some((c) => c.uuidStr === bleUuid(u)); }
    characteristic(x: any) { return typeof x === 'number' ? this.chars[x] ?? null : this.chars.find((c) => c.uuidStr === bleUuid(x)) ?? null; }
    valueOf() { return true; }
  }
  /** the other end of a connection (here: the bench's phone) */
  class BLEDevice {
    constructor(private addr = '') {}
    address() { return this.addr; }
    connected() { blePoll(); return ble.connected && ble.central === this.addr; }
    disconnect() { return BLE.disconnect(); }
    poll() { blePoll(); }
    rssi() { return ble.connected ? -48 : 127; }
    hasLocalName() { return true; }
    localName() { return 'Bench phone'; }
    deviceName() { return 'Bench phone'; }
    discoverAttributes() { return false; }
    connect() { return false; }
    valueOf() { return true; }
    toString() { return this.addr; }
  }
  let blePolls = 0;
  const blePoll = () => {
    if (!ble.begun) return;
    // (a poll takes the chip a little while, ~20 us talking to its radio: a loop of nothing but
    //  BLE.poll() runs about as many times a second as on the board, not millions)
    spend(0.02);
    pumpIn();
    const k = `${BLE_PIN}:${protoCode('data')}`;
    const q = inbox.get(k) ?? [];
    inbox.delete(k);
    blePolls++;
    for (const m of q) {
      let msg: any;
      try { msg = JSON.parse(dec.decode(new Uint8Array(m.data))); } catch { continue; }
      const c = msg.uuid ? ble.chars.get(String(msg.uuid)) : undefined;
      const central = new BLEDevice(ble.central || PHONE);
      if (msg.t === 'connect') {
        if (ble.connected || !ble.advertising || !ble.connectable) continue;
        ble.connected = true;
        ble.central = PHONE;
        ble.advertising = false; // (connected: it stops advertising...)
        bleTable();
        bleFire(BLE_EVENTS.BLEConnected, new BLEDevice(PHONE));
      } else if (msg.t === 'disconnect') {
        if (!ble.connected) continue;
        bleDropped();
      } else if (msg.t === 'write' && c && ble.connected) {
        if (!(c.props & (BLE_PROPS.BLEWrite | BLE_PROPS.BLEWriteWithoutResponse))) continue;
        if (c.fixed && msg.bytes.length !== c.size) { warnOnce(`blefix:${c.uuidStr}`, `Bluetooth: the phone wrote ${msg.bytes.length} bytes to ${c.uuidStr}, which takes exactly ${c.size}: ignored`); continue; }
        c.took(msg.bytes);
        c.handlers.get(BLE_EVENTS.BLEWritten)?.(central, c);
      } else if (msg.t === 'sub' && c && ble.connected) {
        c.subs = !!msg.on;
        c.handlers.get(c.subs ? BLE_EVENTS.BLESubscribed : BLE_EVENTS.BLEUnsubscribed)?.(central, c);
      } else if (msg.t === 'read' && c && ble.connected) c.handlers.get(BLE_PROPS.BLERead)?.(central, c);
    }
  };
  const bleDropped = () => {
    const who = new BLEDevice(ble.central);
    ble.connected = false;
    ble.central = '';
    for (const c of ble.chars.values()) if (c.subs) { c.subs = false; c.handlers.get(BLE_EVENTS.BLEUnsubscribed)?.(who, c); }
    ble.advertising = true; // (...and advertises again once the phone has gone, as ArduinoBLE does)
    bleTable();
    bleFire(BLE_EVENTS.BLEDisconnected, who);
  };
  const BLE = {
    begin() {
      if (!init.ble) { warnOnce('noble', 'BLE.begin(): this board has no Bluetooth LE (an UNO R4 WiFi or an ESP32 has)'); return 0; }
      ble.begun = true;
      bleSend({ t: 'begin' });
      return 1;
    },
    end() { ble.begun = false; ble.advertising = false; ble.connected = false; bleSend({ t: 'end' }); },
    poll(_ms?: number) { blePoll(); },
    connected() { blePoll(); return ble.connected; },
    disconnect() { if (!ble.connected) return false; bleSend({ t: 'dropped' }); bleDropped(); return true; },
    address() { return MAC.map((b) => b.toString(16).padStart(2, '0')).join(':'); },
    rssi() { return ble.connected ? -48 : 127; },
    setLocalName(n: any) { ble.name = String(n ?? ''); bleTable(); return true; },
    setDeviceName(n: any) { if (!ble.name || ble.name === 'Arduino') ble.name = String(n ?? ''); bleTable(); },
    setAppearance() {},
    setAdvertisedServiceUuid(u: any) { ble.advService = bleUuid(u); return true; },
    setAdvertisedService(s: any) { ble.advService = s instanceof BLEService ? s.uuidStr : bleUuid(s); return true; },
    setAdvertisedServiceData() { return true; },
    setManufacturerData() { return true; },
    setAdvertisingData() {},
    setScanResponseData() {},
    addService(s: BLEService) {
      if (!(s instanceof BLEService)) throw new Error('BLE.addService: that is not a BLEService');
      if (!ble.services.includes(s)) ble.services.push(s);
      for (const c of s.chars) ble.chars.set(c.uuidStr, c);
      bleTable();
    },
    advertise() {
      if (!ble.begun) { warnOnce('bleadv', 'BLE.advertise() before BLE.begin()'); return 0; }
      if (!ble.connected) ble.advertising = true;
      bleTable();
      return 1;
    },
    stopAdvertise() { ble.advertising = false; bleTable(); },
    central() { blePoll(); return ble.connected ? new BLEDevice(ble.central) : null; },
    available() { blePoll(); return null; },
    scan() { warnOnce('blescan', 'BLE.scan(): finding other boards over Bluetooth is not in the bench yet (a phone connecting to this board is: the run panel)'); return 1; },
    scanForName() { return BLE.scan(); },
    scanForUuid() { return BLE.scan(); },
    scanForAddress() { return BLE.scan(); },
    stopScan() {},
    setEventHandler(ev: any, fn: any) { if (typeof fn === 'function') ble.handlers.set(Number(ev), fn); },
    setConnectable(b: any) { ble.connectable = !!b; },
    setAdvertisingInterval() {}, setConnectionInterval() {}, setSupervisionTimeout() {}, setTimeout() {},
    debug() {}, noDebug() {}, setPairable() {}, pairable: () => false, paired: () => false,
  };
  Object.assign(api, {
    BLE, BLEService, BLECharacteristic, BLEDescriptor, BLEDevice, BLEStringCharacteristic, ...BLE_PROPS, ...BLE_EVENTS,
    BLEBoolCharacteristic: typedChar('bool'), BLEBooleanCharacteristic: typedChar('bool'), BLECharCharacteristic: typedChar('i8'),
    BLEUnsignedCharCharacteristic: typedChar('u8'), BLEByteCharacteristic: typedChar('u8'), BLEShortCharacteristic: typedChar('i16'),
    BLEUnsignedShortCharacteristic: typedChar('u16'), BLEWordCharacteristic: typedChar('u16'), BLEIntCharacteristic: typedChar('i32'),
    BLEUnsignedIntCharacteristic: typedChar('u32'), BLELongCharacteristic: typedChar('i32'), BLEUnsignedLongCharacteristic: typedChar('u32'),
    BLEFloatCharacteristic: typedChar('f32'), BLEDoubleCharacteristic: typedChar('f64'),
  });

  // ------------------------------------------------------------------------------- I2S sound out (ESP32s)
  // ESP_I2S.h (core 3: I2SClass) and driver/i2s.h (the older i2s_driver_install / i2s_write). The
  // samples go out on the data pin as messages (a 6-byte header, then 16-bit samples, little-endian),
  // to an amp wired there (elec/audio.ts). Writing waits as the real DMA buffers do: a write returns
  // once what's queued is down to the buffers' length, so a program plays in real (simulated) time.
  const I2S_K = {
    I2S_NUM_0: 0, I2S_NUM_1: 1, I2S_MODE_MASTER: 1, I2S_MODE_SLAVE: 2, I2S_MODE_TX: 4, I2S_MODE_RX: 8, I2S_MODE_DAC_BUILT_IN: 16, I2S_MODE_ADC_BUILT_IN: 32, I2S_MODE_PDM: 64,
    I2S_BITS_PER_SAMPLE_8BIT: 8, I2S_BITS_PER_SAMPLE_16BIT: 16, I2S_BITS_PER_SAMPLE_24BIT: 24, I2S_BITS_PER_SAMPLE_32BIT: 32,
    I2S_CHANNEL_FMT_RIGHT_LEFT: 0, I2S_CHANNEL_FMT_ALL_RIGHT: 1, I2S_CHANNEL_FMT_ALL_LEFT: 2, I2S_CHANNEL_FMT_ONLY_RIGHT: 3, I2S_CHANNEL_FMT_ONLY_LEFT: 4,
    I2S_COMM_FORMAT_STAND_I2S: 1, I2S_COMM_FORMAT_STAND_MSB: 2, I2S_COMM_FORMAT_STAND_PCM_SHORT: 4, I2S_COMM_FORMAT_STAND_PCM_LONG: 12,
    I2S_COMM_FORMAT_I2S: 1, I2S_COMM_FORMAT_I2S_MSB: 2, I2S_COMM_FORMAT_I2S_LSB: 4, I2S_CHANNEL_MONO: 1, I2S_CHANNEL_STEREO: 2,
    I2S_PIN_NO_CHANGE: -1, ESP_INTR_FLAG_LEVEL1: 2, ESP_INTR_FLAG_DEFAULT: 0, portMAX_DELAY: 0xffffffff,
    I2S_MODE_STD: 0, I2S_MODE_TDM: 1, I2S_MODE_PDM_TX: 2, I2S_MODE_PDM_RX: 3,
    I2S_DATA_BIT_WIDTH_8BIT: 8, I2S_DATA_BIT_WIDTH_16BIT: 16, I2S_DATA_BIT_WIDTH_24BIT: 24, I2S_DATA_BIT_WIDTH_32BIT: 32,
    I2S_SLOT_MODE_MONO: 1, I2S_SLOT_MODE_STEREO: 2, I2S_STD_SLOT_LEFT: 1, I2S_STD_SLOT_RIGHT: 2, I2S_STD_SLOT_BOTH: 3,
  };
  const i2s = { on: false, rate: 44100, bits: 16, chans: 2, bck: -1, ws: -1, dout: -1, bufFrames: 6 * 240, clock: 0, frames: 0 };
  const I2S_MAGIC = 0xa5;
  const needI2s = (fn: string) => {
    if (!init.i2s) { warnOnce('noi2s', `${fn}: this board has no I2S sound out (an ESP32 has)`); return false; }
    return true;
  };
  /** a buffer the program hands over (an int16_t / int32_t / uint8_t array of `bytes` bytes) as 16-bit samples */
  const i2sSamples = (buf: any, bytes: number): number[] => {
    const a = flatNums(buf);
    const n = Math.max(0, Math.min(Number(bytes) || 0, 1 << 20));
    if (!a.length || !n) return [];
    // (bytes per element: as declared (int16_t buf[]: 2), else guessed from the byte count)
    const ew = unref(buf)?.__ew;
    const per = ew === 2 || ew === 4 ? ew : Math.max(1, Math.round(n / a.length));
    const out: number[] = [];
    if (per === 1) {
      // raw bytes: little-endian samples of the program's width
      const w = i2s.bits >> 3;
      for (let i = 0; i + w <= Math.min(n, a.length); i += w) {
        if (w === 1) out.push(((a[i] & 255) - 128) << 8);
        else { const hi = a[i + w - 1] & 255, lo = a[i + w - 2] & 255; const x = (hi << 8) | lo; out.push(x & 0x8000 ? x - 0x10000 : x); }
      }
    } else if (per === 2) for (let i = 0; i < Math.min(a.length, n / 2); i++) out.push((a[i] << 16) >> 16);
    else for (let i = 0; i < Math.min(a.length, n / 4); i++) {
      const x = a[i] | 0;
      if (i2s.bits === 32 || i2s.bits === 24) out.push(x >> 16); // (a 32-bit sample: its top 16 bits)
      else out.push((x << 16) >> 16, x >> 16); // (two 16-bit samples in one word: low half first)
    }
    return out;
  };
  const i2sOut = (samples: number[]) => {
    if (!i2s.on) { warnOnce('i2soff', 'I2S: write before it was started (begin / i2s_driver_install)'); return 0; }
    if (i2s.dout < 0) { warnOnce('i2spins', 'I2S: no data-out pin set (setPins / i2s_set_pin): the sound goes nowhere'); return 0; }
    const ch = i2s.chans, frames = Math.floor(samples.length / ch);
    const maxFrames = Math.floor(4090 / 2 / ch);
    for (let f = 0; f < frames; f += maxFrames) {
      const n = Math.min(maxFrames, frames - f);
      // (the DMA buffers: wait until what's queued fits)
      const t = now();
      if (i2s.clock < t) i2s.clock = t;
      const bufMs = (i2s.bufFrames / i2s.rate) * 1000;
      if (i2s.clock - t > bufMs) waitUntil(i2s.clock - bufMs);
      const data = [I2S_MAGIC, i2s.rate & 255, (i2s.rate >> 8) & 255, (i2s.rate >> 16) & 255, ch, 16];
      for (let i = f * ch; i < (f + n) * ch; i++) { const s = Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0))); data.push(s & 255, (s >> 8) & 255); }
      linkSend(i2s.dout, 'raw', data);
      i2s.clock += (n / i2s.rate) * 1000;
      i2s.frames += n;
    }
    return frames;
  };
  class I2SClass {
    private err = 0;
    setPins(bclk: number, ws: number, dout: number, _din = -1, _mclk = -1) { i2s.bck = Number(bclk); i2s.ws = Number(ws); i2s.dout = Number(dout); return true; }
    setPinsPdmTx() { warnOnce('pdm', 'I2S: PDM sound out is not in the bench (standard I2S is: I2S_MODE_STD)'); return false; }
    setTimeout() {}
    begin(mode: number, rate: number, bits: number, slot: number, _mask = -1) {
      if (!needI2s('I2S.begin')) return false;
      if (Number(mode) !== 0) { warnOnce('i2smode', 'I2S.begin: only I2S_MODE_STD is in the bench'); return false; }
      Object.assign(i2s, { on: true, rate: Number(rate) || 44100, bits: Number(bits) || 16, chans: Number(slot) === 1 ? 1 : 2, clock: now() });
      return true;
    }
    configureTX(rate: number, bits: number, slot: number) { Object.assign(i2s, { rate: Number(rate) || i2s.rate, bits: Number(bits) || i2s.bits, chans: Number(slot) === 1 ? 1 : 2 }); return true; }
    end() { i2s.on = false; return true; }
    /** write(buffer, bytes) or one byte */
    write(buf: any, len?: number) {
      if (len === undefined) return typeof buf === 'number' ? 1 : 0;
      i2sOut(i2sSamples(buf, len));
      return Number(len) || 0;
    }
    /** a WAV file in memory (16-bit PCM): its own rate and channels */
    playWAV(data: any, len?: number) {
      const b = flatNums(data).slice(0, len ?? undefined).map((x) => x & 255);
      const u32 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
      const tag = (i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
      if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') { warnOnce('wav', 'I2S.playWAV: that is not a WAV file'); return; }
      let at = 12, fmt: { ch: number; rate: number; bits: number } | null = null;
      const keep = { rate: i2s.rate, chans: i2s.chans, bits: i2s.bits };
      while (at + 8 <= b.length) {
        const id = tag(at), size = u32(at + 4);
        if (id === 'fmt ') fmt = { ch: b[at + 10] | (b[at + 11] << 8), rate: u32(at + 12), bits: b[at + 22] | (b[at + 23] << 8) };
        if (id === 'data' && fmt) {
          if (fmt.bits !== 16) { warnOnce('wavbits', `I2S.playWAV: ${fmt.bits}-bit WAV: only 16-bit is in the bench`); return; }
          Object.assign(i2s, { rate: fmt.rate, chans: Math.min(2, fmt.ch), bits: 16 });
          i2sOut(i2sSamples(b.slice(at + 8, at + 8 + size), Math.min(size, b.length - at - 8)));
          Object.assign(i2s, keep);
          return;
        }
        at += 8 + size + (size & 1);
      }
    }
    playMP3() { warnOnce('mp3', 'I2S.playMP3: MP3 is not in the bench (a 16-bit WAV is: playWAV)'); return false; }
    available() { return 0; }
    read() { return -1; }
    readBytes() { return 0; }
    lastError() { return this.err; }
    valueOf() { return i2s.on; }
  }
  // (the configs as objects, for programs that fill them in one field at a time)
  class i2s_config_t { mode = 0; sample_rate = 44100; bits_per_sample = 16; channel_format = 0; communication_format = 1; intr_alloc_flags = 0; dma_buf_count = 8; dma_buf_len = 64; use_apll = false; tx_desc_auto_clear = false; fixed_mclk = 0; }
  class i2s_pin_config_t { mck_io_num = -1; bck_io_num = -1; ws_io_num = -1; data_out_num = -1; data_in_num = -1; }
  Object.assign(api, {
    I2SClass, i2s_config_t, i2s_pin_config_t, ...I2S_K,
    i2s_driver_install(_port: number, cfg: any, _q = 0, _queue: any = null) {
      if (!needI2s('i2s_driver_install')) return api.ESP_FAIL;
      const c = unref(cfg) ?? {};
      const mode = Number(c.mode) || 0;
      if (mode & I2S_K.I2S_MODE_DAC_BUILT_IN) warnOnce('i2sdac', 'i2s_driver_install: the built-in DAC mode is not in the bench (an amp on I2S pins is)');
      if (!(mode & I2S_K.I2S_MODE_TX)) warnOnce('i2stx', 'i2s_driver_install: only sending (I2S_MODE_TX) is in the bench');
      const fmt = Number(c.channel_format) || 0;
      Object.assign(i2s, {
        on: true, rate: Number(c.sample_rate) || 44100, bits: Number(c.bits_per_sample) || 16,
        chans: fmt === I2S_K.I2S_CHANNEL_FMT_ONLY_LEFT || fmt === I2S_K.I2S_CHANNEL_FMT_ONLY_RIGHT ? 1 : 2,
        bufFrames: (Number(c.dma_buf_count) || 8) * (Number(c.dma_buf_len) || 64), clock: now(),
      });
      return api.ESP_OK;
    },
    i2s_set_pin(_port: number, pins: any) {
      const p = unref(pins);
      if (!p) { warnOnce('i2snopin', 'i2s_set_pin(port, NULL): the built-in DAC is not in the bench'); return api.ESP_FAIL; }
      if (Number(p.bck_io_num) >= 0) i2s.bck = Number(p.bck_io_num);
      if (Number(p.ws_io_num) >= 0) i2s.ws = Number(p.ws_io_num);
      if (Number(p.data_out_num) >= 0) i2s.dout = Number(p.data_out_num);
      return api.ESP_OK;
    },
    i2s_write(_port: number, src: any, size: number, written: any, _ticks?: number) {
      i2sOut(i2sSamples(src, size));
      if (written instanceof Ref) written.value = Number(size) || 0;
      return api.ESP_OK;
    },
    i2s_set_sample_rates(_port: number, rate: number) { i2s.rate = Number(rate) || i2s.rate; return api.ESP_OK; },
    i2s_set_clk(_port: number, rate: number, bits: number, ch: number) { Object.assign(i2s, { rate: Number(rate) || i2s.rate, bits: Number(bits) || i2s.bits, chans: Number(ch) === 1 ? 1 : 2 }); return api.ESP_OK; },
    i2s_zero_dma_buffer() { return api.ESP_OK; },
    i2s_start() { return api.ESP_OK; },
    i2s_stop() { return api.ESP_OK; },
    i2s_driver_uninstall() { i2s.on = false; return api.ESP_OK; },
  });

  // ------------------------------------------------------------------------------- messages on wires
  // Faster than pin changes: a serial port's bytes, an LED strip's pixels, a sensor's answer. They
  // go to the parts wired to that pin (layout.ts rings; the simulation side is sketchBoard).
  const inbox = new Map<string, { data: number[]; baud: number }[]>();
  const pumpIn = () => {
    for (const p of ringRead(sh.pktIn, ctl, CTL.PKI_HEAD, CTL.PKI_TAIL)) {
      const k = `${p.pin}:${p.proto}`;
      const q = inbox.get(k) ?? [];
      if (q.length < 256) q.push({ data: p.data, baud: p.baud });
      inbox.set(k, q);
    }
  };
  /** send a message on a pin: linkSend(pin, 'pixels', [r, g, b, ...]) */
  const linkSend = (p: number, proto: string | number, data: ArrayLike<number>, baud = 0) => {
    pin(p, 'linkSend');
    const raw = { pin: p, proto: protoCode(proto), baud, data: Array.from(data ?? [], (x) => Number(x) & 255) };
    if (raw.data.length > 4096) throw new Error(`linkSend: ${raw.data.length} bytes in one message (most is 4096)`);
    while (!ringWrite(sh.pktOut, ctl, CTL.PKO_HEAD, CTL.PKO_TAIL, raw)) { // full: let the simulation take some
      const s = Atomics.load(ctl, CTL.STEP);
      Atomics.wait(ctl, CTL.STEP, s, 50);
    }
  };
  /** the messages that arrived on a pin since the last call: [{ data: [...], baud }] */
  const linkReceive = (p: number, proto: string | number) => {
    pumpIn();
    const k = `${pin(p, 'linkReceive')}:${protoCode(proto)}`;
    const q = inbox.get(k) ?? [];
    inbox.delete(k);
    return q;
  };

  /** A serial port on two pins (Serial1, Serial2, SoftwareSerial): its bytes go to whatever is wired
   *  to its TX pin, and it hears whatever is sent to its RX pin. Both ends need the same baud rate. */
  class HardwareSerial {
    private baud = 0;
    private rxBuf: number[] = [];
    private txBuf: number[] = [];
    private warnedBaud = false;
    constructor(public rxPin = -1, public txPin = -1, private label = 'Serial1') {}
    begin(baud = 9600, _config?: number, rx?: number, tx?: number) {
      if (rx !== undefined && rx >= 0) this.rxPin = rx;
      if (tx !== undefined && tx >= 0) this.txPin = tx;
      if (this.txPin < 0 || this.rxPin < 0) throw new Error(`${this.label}: this board has no pins for it; give them: ${this.label}.begin(9600, SERIAL_8N1, rxPin, txPin)`);
      pin(this.txPin, `${this.label} TX`);
      pin(this.rxPin, `${this.label} RX`);
      this.baud = Number(baud) || 9600;
      sh.mode[this.txPin] = MODE.OUTPUT; // a serial line rests HIGH
      sh.out[this.txPin] = 1;
      sh.hz[this.txPin] = 0;
      sh.mode[this.rxPin] = MODE.INPUT_PULLUP;
      console.debug?.(`[serial] ${this.label} at ${this.baud} baud: TX pin ${this.txPin}, RX pin ${this.rxPin}`);
    }
    setTX(p: number) { this.txPin = p; return true; }
    setRX(p: number) { this.rxPin = p; return true; }
    setPins(rx: number, tx: number) { this.rxPin = rx; this.txPin = tx; }
    end() { this.baud = 0; }
    listen() { return true; }
    isListening() { return this.baud > 0; }
    private take() {
      if (!this.baud) return;
      for (const m of linkReceive(this.rxPin, 'uart')) {
        if (m.baud && Math.abs(m.baud - this.baud) > this.baud * 0.03) {
          // a different speed at each end: what arrives is garbage, as on a real wire
          if (!this.warnedBaud) {
            this.warnedBaud = true;
            warnOnce(`baud:${this.label}`, `${this.label} is at ${this.baud} baud but receives ${m.baud} baud: the bytes come out as garbage. Use the same speed at both ends.`);
          }
          for (const _b of m.data) this.rxBuf.push((Math.random() * 256) | 0);
        } else this.rxBuf.push(...m.data);
      }
      if (this.rxBuf.length > 4096) this.rxBuf.splice(0, this.rxBuf.length - 4096); // (a real buffer overflows too)
    }
    private sendOut() {
      if (!this.txBuf.length) return;
      if (!this.baud) {
        warnOnce(`nobegin:${this.label}`, `${this.label}.print() before ${this.label}.begin(baud): nothing is sent`);
        this.txBuf = [];
        return;
      }
      for (let i = 0; i < this.txBuf.length; i += 1024) linkSend(this.txPin, 'uart', this.txBuf.slice(i, i + 1024), this.baud);
      this.txBuf = [];
    }
    available() { this.take(); return this.rxBuf.length; }
    availableForWrite() { return 64; }
    read() { this.take(); return this.rxBuf.length ? this.rxBuf.shift()! : -1; }
    peek() { this.take(); return this.rxBuf.length ? this.rxBuf[0] : -1; }
    write(x: any, n?: number) {
      if (typeof x === 'number') this.txBuf.push(x & 255);
      else if (typeof x === 'string') this.txBuf.push(...enc.encode(x));
      else this.txBuf.push(...Array.from(x as ArrayLike<number>).slice(0, n ?? (x as ArrayLike<number>).length).map((b) => Number(b) & 255));
      this.sendOut();
      return 1;
    }
    print(x: any = '', f?: number) { this.write(fmt(x, f)); return 1; }
    println(x: any = '', f?: number) { this.write(fmt(x, f) + '\r\n'); return 1; }
    printf(f: string, ...a: any[]) { this.write(sprintf(f, ...a)); }
    flush() { this.sendOut(); }
    setTimeout(ms: number) { this.timeout = ms; }
    private timeout = 1000;
    /** wait (in simulation time) until a byte comes, up to the timeout */
    private next() {
      const until = now() + this.timeout;
      for (;;) {
        const b = this.read();
        if (b >= 0) return b;
        if (now() >= until) return -1;
        waitUntil(now() + 1);
      }
    }
    readStringUntil(end: string) {
      let s = '';
      const stop = String(end).charCodeAt(0);
      for (;;) {
        const b = this.next();
        if (b < 0 || b === stop) break;
        s += String.fromCharCode(b);
      }
      return s;
    }
    readString() {
      let s = '';
      for (;;) {
        const b = this.next();
        if (b < 0) break;
        s += String.fromCharCode(b);
      }
      return s;
    }
    readBytes(buf: number[] | Uint8Array, n: number) {
      let got = 0;
      while (got < n) {
        const b = this.next();
        if (b < 0) break;
        buf[got++] = b;
      }
      return got;
    }
    parseInt() {
      let s = '';
      for (;;) {
        const b = this.peek();
        if (b < 0) { if (s || this.next() < 0) break; continue; }
        const ch = String.fromCharCode(b);
        if (/[0-9]/.test(ch) || (ch === '-' && !s)) { s += ch; this.read(); }
        else if (s) break;
        else this.read();
      }
      return s ? parseInt(s, 10) : 0;
    }
    valueOf() { return this.baud > 0; } // ("if (Serial1)")
  }
  const serialPin = (k: string) => (typeof C[k] === 'number' ? C[k] : -1);
  const Serial1 = new HardwareSerial(serialPin('__RX1'), serialPin('__TX1'), 'Serial1');
  const Serial2 = new HardwareSerial(serialPin('__RX2'), serialPin('__TX2'), 'Serial2');
  const Serial3 = new HardwareSerial(serialPin('__RX3'), serialPin('__TX3'), 'Serial3'); // (an Arduino Mega has a third)
  /** SoftwareSerial bt(rxPin, txPin): a serial port on any two pins */
  class SoftwareSerial extends HardwareSerial {
    constructor(rx: number, tx: number) { super(rx, tx, 'SoftwareSerial'); }
  }
  Object.assign(api, { Serial1, Serial2, Serial3, SoftwareSerial, HardwareSerial, SERIAL_8N1: 0x800001c, SERIAL_8E1: 0x800001e, linkSend, linkReceive });

  // Adafruit_AMG88xx (the AMG8833 thermal camera): the library's calls, done the library's way, as
  // I2C register reads and writes (so the chip on the bench answers them like the real one)
  class Adafruit_AMG88xx {
    private addr = 0x69;
    private w(reg: number, v: number) { Wire.beginTransmission(this.addr); Wire.write(reg); Wire.write(v); return Wire.endTransmission(); }
    private r(reg: number, n: number) {
      Wire.beginTransmission(this.addr); Wire.write(reg); Wire.endTransmission();
      Wire.requestFrom(this.addr, n);
      const out: number[] = [];
      while (Wire.available()) out.push(Wire.read());
      return out;
    }
    begin(addr: number = 0x69) {
      this.addr = addr;
      if (this.w(0x00, 0x00) !== 0) return false; // normal mode (no answer: not there)
      this.w(0x01, 0x3f); // initial reset
      this.w(0x03, 0x00); // interrupts off
      this.w(0x02, 0x00); // 10 frames a second
      waitUntil(now() + 100);
      return true;
    }
    readPixels(buf: number[], size = 64) {
      const n = Math.min(64, size);
      const raw = this.r(0x80, n * 2);
      for (let i = 0; i < n; i++) {
        let v = ((raw[i * 2 + 1] ?? 0) << 8) | (raw[i * 2] ?? 0);
        if (v & 0x800) v -= 0x1000; // (12-bit, two's complement)
        buf[i] = v * 0.25;
      }
    }
    readPixelsRaw(buf: number[], size = 128) { this.r(0x80, Math.min(128, size)).forEach((b, i) => (buf[i] = b)); }
    readThermistor() {
      const raw = this.r(0x0e, 2);
      const v = (((raw[1] ?? 0) & 0x07) << 8) | (raw[0] ?? 0);
      return ((raw[1] ?? 0) & 0x08 ? -v : v) * 0.0625;
    }
    setMovingAverageMode(on: any) { this.w(0x07, on ? 0x20 : 0x00); }
    disableInterrupt() { this.w(0x03, 0x00); }
    enableInterrupt() { this.w(0x03, 0x01); }
    setInterruptMode() {}
    setInterruptLevels() {}
    getInterrupt() {}
    clearInterrupt() { this.w(0x05, 0x0e); }
  }
  Object.assign(api, { Adafruit_AMG88xx, AMG88xx_PIXEL_ARRAY_SIZE: 64, AMG88xx_ADDRESS: 0x69, AMG88xx_NORMAL_MODE: 0, AMG88xx_SLEEP_MODE: 0x10, AMG88xx_STAND_BY_60: 0x20, AMG88xx_STAND_BY_10: 0x21 });

  // RPLidar (the RoboPeak / Slamtec Arduino library): it talks the lidar's own serial protocol
  const RESULT_OK = 0, RESULT_FAIL_BIT = 0x80000000, RESULT_OPERATION_TIMEOUT = 0x80008002, RESULT_INVALID_DATA = 0x80008000;
  class RPLidarMeasurement { distance = 0; angle = 0; quality = 0; startBit = false; }
  class rplidar_response_device_info_t { model = 0; firmware_version = 0; hardware_version = 0; serialnum: number[] = []; }
  class rplidar_response_device_health_t { status = 0; error_code = 0; }
  class RPLidar {
    private s: any = null;
    private point = new RPLidarMeasurement();
    begin(serial: any) {
      this.s = serial;
      this.s.end?.();
      this.s.begin(115200);
      return true;
    }
    end() { this.s?.end?.(); this.s = null; }
    isOpen() { return !!this.s; }
    getCurrentPoint() { return this.point; }
    private send(cmd: number) { this.s.write([0xa5, cmd], 2); }
    /** wait for n bytes (timeout ms): null if they didn't come */
    private take(n: number, timeout: number) {
      const out: number[] = [];
      const end = now() + timeout;
      while (out.length < n) {
        if (this.s.available() > 0) { out.push(this.s.read()); continue; }
        if (now() >= end) return null;
        waitUntil(Math.min(end, now() + 1));
      }
      return out;
    }
    private header(type: number, timeout: number) {
      const end = now() + timeout;
      let prev = -1;
      while (now() < end) {
        const b = this.take(1, end - now());
        if (!b) return false;
        if (prev === 0xa5 && b[0] === 0x5a) {
          const rest = this.take(5, end - now());
          return !!rest && rest[4] === type;
        }
        prev = b[0];
      }
      return false;
    }
    startScan(force: any = false, timeout = 2000) {
      if (!this.s) return RESULT_OPERATION_TIMEOUT;
      this.stop();
      while (this.s.available()) this.s.read(); // (what was left from before)
      this.send(force ? 0x21 : 0x20);
      return this.header(0x81, timeout) ? RESULT_OK : RESULT_OPERATION_TIMEOUT;
    }
    stop() { if (this.s) this.send(0x25); return RESULT_OK; }
    reset() { if (this.s) this.send(0x40); return RESULT_OK; }
    waitPoint(timeout = 500) {
      if (!this.s) return RESULT_OPERATION_TIMEOUT;
      const end = now() + timeout;
      const node: number[] = [];
      while (now() < end) {
        const b = this.take(1, end - now());
        if (!b) break;
        const c = b[0];
        // (the library's checks, byte by byte: S and not-S differ; the check bit is set)
        if (node.length === 0) { const s = c & 1, ns = (c >> 1) & 1; if (s === ns) continue; }
        else if (node.length === 1 && !(c & 1)) { node.length = 0; continue; }
        node.push(c);
        if (node.length === 5) {
          this.point.distance = (node[3] | (node[4] << 8)) / 4;
          this.point.angle = ((node[1] >> 1) | (node[2] << 7)) / 64;
          this.point.quality = node[0] >> 2;
          this.point.startBit = (node[0] & 1) === 1;
          return RESULT_OK;
        }
      }
      return RESULT_OPERATION_TIMEOUT;
    }
    getHealth(info: rplidar_response_device_health_t, timeout = 1000) {
      if (!this.s) return RESULT_OPERATION_TIMEOUT;
      this.send(0x52);
      if (!this.header(0x06, timeout)) return RESULT_OPERATION_TIMEOUT;
      const d = this.take(3, timeout);
      if (!d) return RESULT_OPERATION_TIMEOUT;
      info.status = d[0]; info.error_code = d[1] | (d[2] << 8);
      return RESULT_OK;
    }
    getDeviceInfo(info: rplidar_response_device_info_t, timeout = 1000) {
      if (!this.s) return RESULT_OPERATION_TIMEOUT;
      this.send(0x50);
      if (!this.header(0x04, timeout)) return RESULT_OPERATION_TIMEOUT;
      const d = this.take(20, timeout);
      if (!d) return RESULT_OPERATION_TIMEOUT;
      info.model = d[0]; info.firmware_version = d[1] | (d[2] << 8); info.hardware_version = d[3]; info.serialnum = d.slice(4);
      return RESULT_OK;
    }
  }
  Object.assign(api, {
    RPLidar, RPLidarMeasurement, rplidar_response_device_info_t, rplidar_response_device_health_t,
    RESULT_OK, RESULT_FAIL_BIT, RESULT_OPERATION_TIMEOUT, RESULT_INVALID_DATA,
    IS_OK: (x: number) => ((x >>> 0) & RESULT_FAIL_BIT) === 0, IS_FAIL: (x: number) => ((x >>> 0) & RESULT_FAIL_BIT) !== 0,
    RPLIDAR_SERIAL_BAUDRATE: 115200, RPLIDAR_DEFAULT_TIMEOUT: 500,
  });

  // ------------------------------------------------------------------------------- SPI
  // The board's SPI pins (SCK, MOSI, MISO) reach every SPI part wired to them; the one whose CS pin
  // the program holds LOW answers. A transfer that needs the answer waits for it (one simulation
  // step); bytes that only go out (a screen's pixels: SPI.writeBytes) don't wait.
  /** which of the board's pins are high now (sent with each SPI message: CS, a screen's DC pin) */
  const snap = () => {
    const b = new Array(SPI_SNAP).fill(0);
    for (let p = 0; p < PINS; p++) {
      const m = sh.mode[p];
      if ((m === MODE.OUTPUT && sh.out[p]) || m === MODE.INPUT_PULLUP) b[p >> 3] |= 1 << (p & 7);
    }
    return b;
  };
  let spiOn = false;
  const spiCheck = () => {
    if (!spiOn) warnOnce('spibegin', 'SPI used before SPI.begin(): call SPI.begin() in setup()');
    spiOn = true;
  };
  const spiExchange = (bytes: number[]): number[] => {
    spiCheck();
    const out: number[] = [];
    // (the request area holds the pin levels and then the bytes: more would be cut off)
    const room = sh.req.length - SPI_SNAP;
    for (let i = 0; i < bytes.length; i += room) {
      const chunk = bytes.slice(i, i + room);
      spend((chunk.length * 8) / 4000 + 0.005); // (8 clocks a byte at a usual 4 MHz)
      const r = request(REQ.SPI, chunk.length, 0, 0, [...snap(), ...chunk]);
      for (let j = 0; j < chunk.length; j++) out.push(r.status === 0 ? (r.data[j] ?? 0xff) : 0xff);
    }
    return out;
  };
  const spiSend = (bytes: number[]) => {
    spiCheck();
    for (let i = 0; i < bytes.length; i += 4000) {
      const data = [...snap(), ...bytes.slice(i, i + 4000)];
      while (!ringWrite(sh.pktOut, ctl, CTL.PKO_HEAD, CTL.PKO_TAIL, { pin: 0, proto: protoCode('spi'), baud: 0, data })) {
        const st = Atomics.load(ctl, CTL.STEP);
        Atomics.wait(ctl, CTL.STEP, st, 50);
      }
    }
  };
  const bytesOf = (x: any, n?: number): number[] => {
    if (typeof x === 'string') return Array.from(x.slice(0, n ?? x.length), (ch) => ch.charCodeAt(0) & 255);
    if (x && typeof x === 'object' && typeof x.length === 'number') return Array.from({ length: Math.min(n ?? x.length, x.length) }, (_, i) => Number(x[i]) & 255);
    return [Number(x) & 255];
  };
  class SPISettings {
    constructor(public clock = 4000000, public order = 1, public mode = 0) {}
  }
  const SPI = {
    begin() { spiOn = true; },
    end() { spiOn = false; },
    beginTransaction(_s?: SPISettings) { spiOn = true; },
    endTransaction() {},
    setBitOrder() {},
    setDataMode() {},
    setClockDivider() {},
    setFrequency() {},
    usingInterrupt() {},
    /** one byte out, the answer back; or a whole buffer, its answers written into it */
    transfer(x: any, n?: number) {
      if (x && typeof x === 'object' && typeof x.length === 'number') {
        const r = spiExchange(bytesOf(x, n));
        for (let i = 0; i < r.length; i++) x[i] = r[i];
        return x;
      }
      return spiExchange([Number(x) & 255])[0];
    },
    transfer16(x: number) {
      const r = spiExchange([(x >> 8) & 255, x & 255]);
      return (r[0] << 8) | r[1];
    },
    /** bytes out only (no answers): fast */
    writeBytes(buf: any, n?: number) { spiSend(bytesOf(buf, n)); },
    write(b: number) { spiSend([b & 255]); },
    write16(x: number) { spiSend([(x >> 8) & 255, x & 255]); },
    writePixels(buf: any, n?: number) { spiSend(bytesOf(buf, n)); },
    transferBytes(out: any, into: any, n: number) {
      const r = spiExchange(bytesOf(out, n));
      if (into) for (let i = 0; i < r.length; i++) into[i] = r[i];
    },
  };
  Object.assign(api, { SPI, SPISettings, SPI_MODE0: 0, SPI_MODE1: 1, SPI_MODE2: 2, SPI_MODE3: 3, SPI_CLOCK_DIV2: 2, SPI_CLOCK_DIV4: 4, SPI_CLOCK_DIV8: 8, SPI_CLOCK_DIV16: 16, SPI_CLOCK_DIV32: 32, SPI_CLOCK_DIV64: 64, SPI_CLOCK_DIV128: 128 });

  // ------------------------------------------------------------------------------- &x and sizeof
  // "&x" in a call hands over the variable itself, so a library can fill it in (radio.read(&value,
  // sizeof(value)), mpu.getEvent(&a, &g, &temp)). Objects and arrays are handed over as they are.
  class Ref {
    constructor(private g: () => any, private s: (v: any) => void, public type = '', public size = 0) {}
    get value() { return this.g(); }
    set value(v: any) { this.s(v); }
    valueOf() { return this.g(); }
    toString() { return String(this.g()); }
  }
  const __ref = (g: () => any, s: (v: any) => void, type = '', size = 0) => {
    const v = g();
    // (a char array handed over is a text the library may replace: "radio.read(&text, sizeof(text))")
    return v && typeof v === 'object' && !(type === 's' && Array.isArray(v)) ? v : new Ref(g, s, type, size);
  };
  /** the size in bytes of something whose type the translator didn't know */
  const __sizeof = (x: any): number => {
    if (x instanceof Ref) return x.size || __sizeof(x.value);
    if (typeof x === 'string') return x.length + 1;
    if (x && typeof x === 'object' && typeof x.length === 'number') return x.length;
    if (x && typeof x === 'object') return Object.keys(x).length * 4;
    return typeof x === 'boolean' ? 1 : 4;
  };
  /** set what a "&x" handed to a library points at */
  const setRef = (r: any, v: any) => { if (r instanceof Ref) r.value = v; };
  const isRef = (r: any) => r instanceof Ref;
  Object.assign(api, { __ref, __sizeof, setRef, isRef, Ref });

  // ------------------------------------------------------------------------------- C++ bits
  // (what translated sketches call: fixed-size number casts, chars, structs, String's C++ methods)
  const i16 = (x: number) => (Math.trunc(Number(x)) << 16) >> 16;
  // (flash memory is plain memory here: "pgm_read_byte(&table[i])" is handed the value itself)
  const flash = (x: any) => (typeof x === 'string' ? x.charCodeAt(0) || 0 : Number(x instanceof Ref ? x.value : x) || 0);
  Object.assign(api, { pgm_read_byte: flash, pgm_read_byte_near: flash, pgm_read_word: flash, pgm_read_word_near: flash, pgm_read_dword: flash });
  Object.assign(api, {
    __i16: i16,
    __i8: (x: number) => (Math.trunc(Number(x)) << 24) >> 24,
    __u8: (x: number) => Math.trunc(Number(x)) & 0xff,
    __u16: (x: number) => Math.trunc(Number(x)) & 0xffff,
    __u32: (x: number) => Math.trunc(Number(x)) >>> 0,
    __char: (x: any) => (typeof x === 'number' ? (x < 0 ? '' : String.fromCharCode(x & 0xff)) : x),
    __struct: (o: any, fields: string[], vals: any[]) => { vals.forEach((v, i) => { if (fields[i] !== undefined) o[fields[i]] = v; }); return o; },
    /** an array of 16- or 32-bit numbers ("int16_t buf[256];"): its element size, for byte counts (I2S) */
    __sized: (a: any[], w: number) => { try { Object.defineProperty(a, '__ew', { value: w }); } catch { /* frozen */ } return a; },
    __strReplace: (str: any, a: any, b: any) => String(str).split(String(a)).join(String(b)),
    memset: (arr: any, v: number, n?: number) => { if (arr && typeof arr.fill === 'function') arr.fill(v, 0, n === undefined ? undefined : Math.min(arr.length, n)); return arr; },
    memcpy: (dst: any, src: any, n: number) => {
      // (a struct that came by radio: its fields, as the sender had them)
      if (src && src.__obj !== undefined) {
        const v = JSON.parse(JSON.stringify(src.__obj));
        if (dst instanceof Ref) dst.value = v;
        else if (dst && typeof dst === 'object' && v && typeof v === 'object') Object.assign(dst, v);
        return dst;
      }
      for (let i = 0; i < n && i < src.length; i++) dst[i] = src[i];
      return dst;
    },
    strlen: (x: any) => String(x ?? '').replace(/\0[\s\S]*$/, '').length,
    strcmp: (a: any, b: any) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
    sqrtf: Math.sqrt, sinf: Math.sin, cosf: Math.cos, tanf: Math.tan, asinf: Math.asin, acosf: Math.acos, atanf: Math.atan, atan2f: Math.atan2,
    fabsf: Math.abs, fabs: Math.abs, powf: Math.pow, expf: Math.exp, exp: Math.exp, logf: Math.log, log: Math.log, log10: Math.log10,
    floorf: Math.floor, ceilf: Math.ceil, roundf: Math.round, fminf: Math.min, fmaxf: Math.max, fmin: Math.min, fmax: Math.max,
    fmod: (a: number, b: number) => a % b, fmodf: (a: number, b: number) => a % b, asin: Math.asin, acos: Math.acos, atan: Math.atan, hypot: Math.hypot,
    radians: (d: number) => (d * Math.PI) / 180, degrees: (r: number) => (r * 180) / Math.PI, DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI, TWO_PI: Math.PI * 2, HALF_PI: Math.PI / 2,
    // String(x), and String(x, 2) (two decimals) / String(x, HEX)
    String: Object.assign((x: any = '', f?: number) => (f === undefined ? String(x ?? '') : fmt(typeof x === 'number' ? x : Number(x), f)), { fromCharCode: String.fromCharCode, raw: String.raw }),
  });
  // Arduino's String methods on JS strings (this thread's own strings: the app's aren't touched)
  const SP = String.prototype as any;
  const def = (n: string, f: (this: string, ...a: any[]) => any) => { if (!(n in SP)) Object.defineProperty(SP, n, { value: f, configurable: true, writable: true }); };
  def('toInt', function () { const n = parseInt(this, 10); return Number.isNaN(n) ? 0 : n; });
  def('toFloat', function () { const n = parseFloat(this); return Number.isNaN(n) ? 0 : n; });
  def('toDouble', function () { const n = parseFloat(this); return Number.isNaN(n) ? 0 : n; });
  def('c_str', function () { return String(this); });
  def('equals', function (o: any) { return String(this) === String(o); });
  def('equalsIgnoreCase', function (o: any) { return String(this).toLowerCase() === String(o).toLowerCase(); });
  def('isEmpty', function () { return this.length === 0; });
  def('compareTo', function (o: any) { return String(this) < String(o) ? -1 : String(this) > String(o) ? 1 : 0; });

  // ------------------------------------------------------------------------------- ESP32 extras
  // ledc: the ESP32's PWM (servos and dimming). Core 3.x: ledcAttach(pin, hz, bits), ledcWrite(pin, duty);
  // core 2.x: ledcSetup(channel, hz, bits), ledcAttachPin(pin, channel), ledcWrite(channel, duty).
  const ledcPins = new Map<number, { hz: number; bits: number }>();
  const ledcChans = new Map<number, { hz: number; bits: number; pins: number[] }>();
  const ledcOut = (p: number, hz: number, bits: number, duty: number) => {
    sh.mode[p] = MODE.OUTPUT;
    const d = Math.max(0, Math.min(1, duty / 2 ** bits));
    sh.duty[p] = d;
    sh.hz[p] = d <= 0 || d >= 1 ? 0 : hz;
    sh.out[p] = d >= 0.5 ? 1 : 0;
    if (d >= 1) sh.out[p] = 1;
  };
  Object.assign(api, {
    ledcAttach(p: number, hz: number, bits: number) { pin(p, 'ledcAttach'); ledcPins.set(p, { hz, bits }); sh.mode[p] = MODE.OUTPUT; return true; },
    ledcAttachChannel(p: number, hz: number, bits: number, ch: number) { pin(p, 'ledcAttachChannel'); ledcPins.set(p, { hz, bits }); ledcChans.set(ch, { hz, bits, pins: [p] }); return true; },
    ledcSetup(ch: number, hz: number, bits: number) { const c = ledcChans.get(ch); ledcChans.set(ch, { hz, bits, pins: c?.pins ?? [] }); return hz; },
    ledcAttachPin(p: number, ch: number) { pin(p, 'ledcAttachPin'); const c = ledcChans.get(ch) ?? { hz: 5000, bits: 8, pins: [] }; c.pins.push(p); ledcChans.set(ch, c); sh.mode[p] = MODE.OUTPUT; },
    ledcWrite(x: number, duty: number) {
      const p = ledcPins.get(x);
      if (p) return ledcOut(x, p.hz, p.bits, duty), true;
      const c = ledcChans.get(x);
      if (c) { for (const q of c.pins) ledcOut(q, c.hz, c.bits, duty); return true; }
      warnOnce(`ledc${x}`, `ledcWrite(${x}, ...): pin or channel ${x} isn't set up (ledcAttach(pin, freq, bits) first)`);
      return false;
    },
    ledcWriteTone(x: number, hz: number) { const p = ledcPins.get(x) ?? ledcChans.get(x); if (p) { p.hz = hz; api.ledcWrite(x, hz ? 2 ** (p.bits - 1) : 0); } return hz; },
    ledcDetach(p: number) { ledcPins.delete(p); sh.hz[p] = 0; return true; },
    ledcDetachPin(p: number) { sh.hz[p] = 0; },
  });
  // Preferences: the ESP32's small saved settings (kept while the run lasts)
  const prefStore = new Map<string, Map<string, any>>();
  class Preferences {
    private ns: Map<string, any> | null = null;
    begin(name: string, _ro = false) { const k = String(name); if (!prefStore.has(k)) prefStore.set(k, new Map()); this.ns = prefStore.get(k)!; return true; }
    end() { this.ns = null; }
    clear() { this.ns?.clear(); return true; }
    remove(k: string) { return !!this.ns?.delete(String(k)); }
    isKey(k: string) { return !!this.ns?.has(String(k)); }
    private get(k: string, d: any) { return this.ns?.has(String(k)) ? this.ns.get(String(k)) : d; }
    private put(k: string, v: any) { this.ns?.set(String(k), v); return 4; }
    getInt(k: string, d = 0) { return this.get(k, d); } putInt(k: string, v: number) { return this.put(k, Math.trunc(v)); }
    getUInt(k: string, d = 0) { return this.get(k, d); } putUInt(k: string, v: number) { return this.put(k, Math.trunc(v) >>> 0); }
    getLong(k: string, d = 0) { return this.get(k, d); } putLong(k: string, v: number) { return this.put(k, Math.trunc(v)); }
    getULong(k: string, d = 0) { return this.get(k, d); } putULong(k: string, v: number) { return this.put(k, Math.trunc(v) >>> 0); }
    getShort(k: string, d = 0) { return this.get(k, d); } putShort(k: string, v: number) { return this.put(k, i16(v)); }
    getUChar(k: string, d = 0) { return this.get(k, d); } putUChar(k: string, v: number) { return this.put(k, Math.trunc(v) & 255); }
    getFloat(k: string, d = 0) { return this.get(k, d); } putFloat(k: string, v: number) { return this.put(k, Number(v)); }
    getDouble(k: string, d = 0) { return this.get(k, d); } putDouble(k: string, v: number) { return this.put(k, Number(v)); }
    getBool(k: string, d = false) { return this.get(k, d); } putBool(k: string, v: any) { return this.put(k, !!v); }
    getString(k: string, d = '') { return this.get(k, d); } putString(k: string, v: any) { return this.put(k, String(v)); }
  }
  Object.assign(api, { Preferences });

  Object.assign(api, { Serial, Wire, Servo, console:{ log: (...a: any[]) => Serial.println(a.map((x) => fmt(x)).join(' ')) } });

  // ------------------------------------------------------------------------------- libraries
  for (const lib of init.libs ?? []) {
    try {
      const names = Object.keys(api);
      const ex = lib.exports.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
      // (in a function of its own: its names may be the same as ones already given, as C++ headers do)
      const got = new Function(...names, `return (function () {${lib.code}\n;return {${ex.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')}};})();`)(...names.map((n) => api[n]));
      for (const n of ex) if (got[n] === undefined) warnOnce(`lib:${n}`, `${lib.name} says it has ${n}, but it doesn't define it`);
      Object.assign(api, got);
    } catch (e: any) {
      return fail(new Error(`${lib.name} failed to load: ${e?.message ?? e}`));
    }
  }

  // ------------------------------------------------------------------------------- run it
  const names = Object.keys(api);
  let setup: (() => void) | null = null, loop: (() => void) | null = null;
  try {
    // (the program in a function of its own: it may use the board's names for its own things, as
    //  "#define SCK 3" does in C++; it starts on the same line, so error line numbers still match)
    const fn = new Function(...names, `return (function () {${init.code}\n;return [typeof setup === 'function' ? setup : null, typeof loop === 'function' ? loop : null];})();`);
    [setup, loop] = fn(...names.map((n) => api[n]));
  } catch (e) {
    return fail(e);
  }
  if (!setup && !loop) return fail(new Error('the program has neither setup() nor loop()'));
  try {
    Atomics.store(ctl, CTL.STATE, 1);
    post({ type: 'state', state: 'setup' });
    setup?.();
    Atomics.store(ctl, CTL.STATE, 2);
    post({ type: 'state', state: 'loop' });
    let n = 0;
    for (;;) {
      if (!loop) { waitUntil(now() + 1000); continue; }
      loop();
      whileWaiting();
      for (const t of tickers) t(); // (a loop() that never waits still plays the matrix's animation)
      if (++n % 64 === 0 && now() - lastFlush > 30) flush();
    }
  } catch (e) {
    fail(e);
  }

  function fail(e: any) {
    flush();
    const stack = String(e?.stack ?? '');
    const m = /<anonymous>:(\d+):(\d+)/.exec(stack) ?? /anonymous.*?:(\d+):(\d+)/.exec(stack);
    const line = m ? Number(m[1]) - 2 : null; // new Function() puts two lines in front of the code
    Atomics.store(ctl, CTL.STATE, 3);
    post({ type: 'error', message: String(e?.message ?? e), line });
  }
}
