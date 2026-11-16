// The simulation's side of a running program: starts its thread, moves simulation time forward for
// it, answers its requests (I2C, pulseIn), passes serial both ways.
import { CTL, EVENTS, PROTOS, REQ, SPI_SNAP, Shared, ringRead, ringWrite, protoCode } from './layout';
import SketchWorker from './worker.ts?worker';

export interface HostEvents {
  serial(text: string): void;
  error(message: string, line: number | null): void;
  warn(message: string): void;
  state(s: string): void;
}
export interface Requests {
  /** an emulated chip may take a few steps to answer: then a Promise */
  i2cWrite(addr: number, bytes: number[]): boolean | Promise<boolean>;
  i2cRead(addr: number, n: number): number[] | null | Promise<number[] | null>;
  pulseIn(pin: number, level: number, timeoutUs: number): number;
  /** Wi-Fi: mode 0 off, 1 join a network, 2 make its own (access point); answers with WL_* status */
  wifiJoin?(mode: number, ssid: string, pass: string): number;
  httpListen?(port: number): boolean;
  /** SPI: bytes out with the board's pin levels at that moment (SPI_SNAP bytes), the answers back */
  spi?(snap: number[], bytes: number[]): number[] | Promise<number[]>;
}

export class SketchHost {
  sh = new Shared();
  private worker: Worker;
  state = 'starting';
  error: string | null = null;

  constructor(code: string, constants: Record<string, number>, analogPins: number[], libs: { name: string; code: string; exports: string[] }[], private ev: HostEvents, wifi = false, wifiWaits = false) {
    this.worker = new SketchWorker();
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'serial') ev.serial(m.text);
      else if (m.type === 'error') {
        this.state = 'error';
        this.error = m.message;
        ev.error(m.message, m.line);
      } else if (m.type === 'warn') ev.warn(m.message);
      else if (m.type === 'state') {
        this.state = m.state;
        ev.state(m.state);
      }
    };
    this.worker.onerror = (e) => {
      this.state = 'error';
      this.error = e.message;
      ev.error(e.message, null);
    };
    this.worker.postMessage({ type: 'start', sab: this.sh.sab, code, constants, analogPins, libs, wifi, wifiWaits });
  }

  /** Simulation time moved on: wake the program if it's waiting. */
  tick(ms: number) {
    this.sh.f64[0] = ms;
    Atomics.add(this.sh.ctl, CTL.STEP, 1);
    Atomics.notify(this.sh.ctl, CTL.STEP);
  }

  private busy = false;

  /** Answer the program's waiting request, if any (now, or when an emulated chip has answered). */
  serve(r: Requests) {
    const c = this.sh.ctl;
    if (this.busy || Atomics.load(c, CTL.REQ) !== 1) return;
    const type = c[CTL.REQ_TYPE], a0 = c[CTL.ARG0], a1 = c[CTL.ARG1], a2 = c[CTL.ARG2];
    const finish = (status: number, data: number[] = []) => {
      this.busy = false;
      this.sh.resp.set(data.slice(0, 512));
      c[CTL.RESP_LEN] = data.length;
      c[CTL.RESP_STATUS] = status;
      Atomics.store(c, CTL.REQ, 2);
      Atomics.notify(c, CTL.REQ);
    };
    const later = <T>(x: T | Promise<T>, done: (v: T) => void) => {
      if (x instanceof Promise) {
        this.busy = true;
        x.then(done, () => finish(2));
      } else done(x);
    };
    if (type === REQ.I2C_WRITE) later(r.i2cWrite(a0, Array.from(this.sh.req.slice(0, a1))), (ok) => finish(ok ? 0 : 2));
    else if (type === REQ.I2C_READ) later(r.i2cRead(a0, a1), (got) => (got ? finish(0, got) : finish(2)));
    else if (type === REQ.PULSE_IN) finish(r.pulseIn(a0, a1, a2));
    else if (type === REQ.SPI) {
      const raw = Array.from(this.sh.req.slice(0, SPI_SNAP + a0));
      if (!r.spi) finish(0, new Array(a0).fill(0xff));
      else later(r.spi(raw.slice(0, SPI_SNAP), raw.slice(SPI_SNAP)), (got) => finish(0, got));
    }
    else if (type === REQ.WIFI_JOIN) {
      let cfg = { ssid: '', pass: '' };
      try { cfg = JSON.parse(new TextDecoder().decode(this.sh.req.slice(0, a1 || 512)).replace(/[\u0000]+$/, '')); } catch { /* none */ }
      finish(r.wifiJoin ? r.wifiJoin(a0, cfg.ssid, cfg.pass) : 0);
    } else if (type === REQ.HTTP_LISTEN) finish(r.httpListen?.(a0) ? 0 : 2);
    else finish(2);
  }

  /** Pin changes the program made since the last call, in order: [pin number, level]. */
  takeEvents(): [number, 0 | 1][] {
    const c = this.sh.ctl;
    const h = Atomics.load(c, CTL.EV_HEAD);
    let t = Atomics.load(c, CTL.EV_TAIL);
    if (h === t) return [];
    const out: [number, 0 | 1][] = [];
    while (t !== h) {
      const e = this.sh.ev[t];
      out.push([e >> 1, (e & 1) as 0 | 1]);
      t = (t + 1) % EVENTS;
    }
    Atomics.store(c, CTL.EV_TAIL, t);
    Atomics.notify(c, CTL.STEP);
    return out;
  }

  // ---- web requests to the program's WebServer (one at a time; the program answers in handleClient())
  private webQueue: { req: any; resolve(r: { status: number; type: string; body: string; headers: Record<string, string> }): void; at: number }[] = [];
  private webBusy: (typeof this.webQueue)[number] | null = null;
  /** Wi-Fi state the program sees */
  setWifi(status: number, ip: number) {
    Atomics.store(this.sh.ctl, CTL.WIFI_STATUS, status);
    Atomics.store(this.sh.ctl, CTL.WIFI_IP, ip | 0);
  }
  webRequest(req: { method: string; path: string; args: Record<string, string>; body: string; headers: Record<string, string> }) {
    return new Promise<{ status: number; type: string; body: string; headers: Record<string, string> }>((resolve) => {
      this.webQueue.push({ req, resolve, at: performance.now() });
      this.pumpWeb();
    });
  }
  /** called every step (and when a request arrives) */
  pumpWeb() {
    const c = this.sh.ctl;
    if (this.webBusy && Atomics.load(c, CTL.HTTP) === 2) {
      let r = { status: 500, type: 'text/plain', body: 'bad answer from the board', headers: {} as Record<string, string> };
      try { r = JSON.parse(new TextDecoder().decode(this.sh.httpResp.slice(0, c[CTL.HTTP_RESP_LEN]))); } catch { /* keep the 500 */ }
      Atomics.store(c, CTL.HTTP, 0);
      this.webBusy.resolve(r);
      this.webBusy = null;
    }
    if (this.webBusy && performance.now() - this.webBusy.at > 10000) {
      // never picked up: the program isn't calling server.handleClient() (or it's stuck)
      Atomics.store(c, CTL.HTTP, 0);
      this.webBusy.resolve({ status: 504, type: 'text/plain', body: "The board didn't answer within 10 s. Does loop() call server.handleClient()? (A long delay() in loop() keeps it from answering.)", headers: {} });
      this.webBusy = null;
    }
    if (!this.webBusy && this.webQueue.length && Atomics.load(c, CTL.HTTP) === 0) {
      this.webBusy = this.webQueue.shift()!;
      this.webBusy.at = performance.now();
      const bytes = new TextEncoder().encode(JSON.stringify(this.webBusy.req)).slice(0, this.sh.httpReq.length);
      this.sh.httpReq.set(bytes);
      c[CTL.HTTP_LEN] = bytes.length;
      Atomics.store(c, CTL.HTTP, 1);
      Atomics.notify(c, CTL.STEP);
    }
  }

  /** Messages the program sent on its pins since the last call (serial ports, LED strips...). */
  takePackets() {
    return ringRead(this.sh.pktOut, this.sh.ctl, CTL.PKO_HEAD, CTL.PKO_TAIL).map((p) => ({ pin: p.pin, proto: PROTOS[p.proto] ?? String(p.proto), baud: p.baud, data: p.data }));
  }
  /** A message for the program, arriving on one of its pins. false = its inbox is full (dropped). */
  givePacket(pin: number, proto: string, data: number[], baud = 0) {
    const ok = ringWrite(this.sh.pktIn, this.sh.ctl, CTL.PKI_HEAD, CTL.PKI_TAIL, { pin, proto: protoCode(proto), baud, data });
    if (ok) Atomics.notify(this.sh.ctl, CTL.STEP);
    return ok;
  }

  /** Bytes typed into the serial monitor. */
  sendSerial(text: string) {
    const c = this.sh.ctl;
    let h = Atomics.load(c, CTL.SERIAL_HEAD);
    for (const ch of new TextEncoder().encode(text)) {
      const next = (h + 1) % 1024;
      if (next === Atomics.load(c, CTL.SERIAL_TAIL)) break; // full
      this.sh.serial[h] = ch;
      h = next;
    }
    Atomics.store(c, CTL.SERIAL_HEAD, h);
  }

  terminate() {
    this.worker.terminate();
  }
}
