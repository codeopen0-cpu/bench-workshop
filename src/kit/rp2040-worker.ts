// An emulated RP2040 (rp2040js) running real firmware (.uf2) in its own thread, kept in step with the
// simulation: pins go through shared memory, I2C transactions through a one-slot mailbox, USB
// serial out as messages. I2C works both ways: as a controller the chip's transfers go to the chips
// in the simulation (it waits for their answer), and since rp2040js only does controller mode, target
// mode (the chip answering at its own address) is added here (I2CTarget below).
import { RP2040, RPI2C, USBCDC } from 'rp2040js';
import { bootromB1 } from './bootrom-rp2040';
import { C, EVENTS, GP, MREQ, OUT, Rp2040Shared } from './rp2040-layout';

const post = (m: any) => (self as any).postMessage(m);

// ------------------------------------------------------------------------------------------ I2C target mode
const MASTER_MODE = 1;
const R_START_DET = 1 << 10, R_STOP_DET = 1 << 9, R_RD_REQ = 1 << 5, R_RX_FULL = 1 << 2;
const FIRST_DATA_BYTE = 1 << 11; // IC_DATA_CMD bit 11 on the real chip (the SDK and our firmware use it)

class I2CTarget extends RPI2C {
  rx: number[] = [];
  txByte: number | null = null;
  get targetMode() {
    return !(this.control & MASTER_MODE);
  }
  get live() {
    return this.targetMode && !!(this.enable & 1);
  }
  readUint32(offset: number): number {
    if (!this.targetMode) return super.readUint32(offset);
    switch (offset) {
      case 0x10: { // IC_DATA_CMD: next received byte
        const v = this.rx.shift() ?? 0;
        if (this.rx.length <= this.rxThreshold) this.clearInterrupts(R_RX_FULL);
        return v;
      }
      case 0x78: // IC_RXFLR
        return this.rx.length;
      case 0x74: // IC_TXFLR
        return 0;
      case 0x70: // IC_STATUS: TFNF | TFE | RFNE
        return 0b110 | (this.rx.length ? 0b1000 : 0);
    }
    return super.readUint32(offset);
  }
  writeUint32(offset: number, value: number) {
    if (this.targetMode && offset === 0x10) {
      this.txByte = value & 0xff; // the answer to a RD_REQ
      return;
    }
    super.writeUint32(offset, value);
  }
  busStart() { this.setInterrupts(R_START_DET); }
  busStop() { this.setInterrupts(R_STOP_DET); }
  busByte(b: number, first: boolean) {
    this.rx.push((b & 0xff) | (first ? FIRST_DATA_BYTE : 0));
    if (this.rx.length > this.rxThreshold) this.setInterrupts(R_RX_FULL);
  }
  busReadRequest() {
    this.txByte = null;
    this.setInterrupts(R_RD_REQ);
  }
}

// ------------------------------------------------------------------------------------------ firmware
function loadUF2(bytes: Uint8Array, mcu: RP2040) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let blocks = 0;
  for (let off = 0; off + 512 <= bytes.length; off += 512) {
    if (dv.getUint32(off, true) !== 0x0a324655 || dv.getUint32(off + 4, true) !== 0x9e5d5157) continue;
    const flags = dv.getUint32(off + 8, true), addr = dv.getUint32(off + 12, true), size = dv.getUint32(off + 16, true);
    if (flags & 1) continue; // "not main flash"
    if (addr >= 0x10000000 && addr + size <= 0x10000000 + mcu.flash.length) {
      mcu.flash.set(bytes.subarray(off + 32, off + 32 + size), addr - 0x10000000);
      blocks++;
    }
  }
  if (!blocks) throw new Error('that file has no RP2040 program in it (not a .uf2 for the RP2040?)');
  return blocks;
}

self.onmessage = (e: MessageEvent) => {
  if (e.data?.type === 'start') {
    post({ type: 'log', message: `start received (${e.data.uf2?.length ?? 0} bytes of firmware)` });
    try {
      run(e.data.sab, e.data.uf2);
    } catch (err: any) {
      post({ type: 'error', message: String(err?.message ?? err) });
    }
  }
};

function run(sab: SharedArrayBuffer, uf2: Uint8Array) {
  const sh = new Rp2040Shared(sab);
  const mcu = new RP2040(); // with its own simulation clock: time only moves when we execute
  post({ type: 'log', message: `chip created; clock: ${mcu.clock?.constructor?.name}` });
  const clock = mcu.clock as unknown as { nanos: number; nanosToNextAlarm: number; tick(n: number): void };
  mcu.loadBootrom(bootromB1);
  const blocks = loadUF2(uf2, mcu);
  const i2c = new I2CTarget(mcu, 'I2C0', 23);
  (mcu as any).i2c[0] = i2c;
  (mcu as any).peripherals[0x40044] = i2c;
  mcu.core.PC = 0x10000000;

  // I2C controller mode: each transfer goes to the simulation's chips; the chip waits for the answer
  // (its clock stands still meanwhile, so its timing isn't affected)
  const ask = (type: number, addr: number, data: number[] | number) => {
    sh.ctl[C.MREQ_TYPE] = type;
    sh.ctl[C.MREQ_ADDR] = addr;
    if (typeof data === 'number') sh.ctl[C.MREQ_LEN] = data;
    else {
      sh.mreq.set(data.slice(0, 512));
      sh.ctl[C.MREQ_LEN] = data.length;
    }
    Atomics.store(sh.ctl, C.MREQ, 1);
    while (Atomics.load(sh.ctl, C.MREQ) !== 2) Atomics.wait(sh.ctl, C.MREQ, 1, 1000);
    const ok = sh.ctl[C.MRESP_STATUS] === 0;
    const out = ok ? Array.from(sh.mresp.slice(0, sh.ctl[C.MRESP_LEN])) : null;
    Atomics.store(sh.ctl, C.MREQ, 0);
    return out;
  };
  const CMD = 1 << 8, STOP = 1 << 9, RESTART = 1 << 10;
  let mAddr = 0, mRead = false, wbuf: number[] = [], rbuf: number[] = [];
  const flush = () => {
    if (!mRead && wbuf.length) ask(MREQ.WRITE, mAddr, wbuf);
    wbuf = [];
  };
  i2c.onStart = () => {
    flush();
    i2c.completeStart();
  };
  i2c.onConnect = (addr, mode) => {
    flush();
    mAddr = addr & 0x7f;
    mRead = mode === 1;
    rbuf = [];
    i2c.completeConnect(ask(MREQ.PROBE, mAddr, 0) !== null);
  };
  i2c.onWriteByte = (v) => {
    wbuf.push(v);
    i2c.completeWrite(true);
  };
  i2c.onReadByte = () => {
    if (!rbuf.length) {
      // as many bytes as the program has queued read commands for (up to the next stop or restart)
      let n = 1;
      if (!(i2c as any).stop)
        for (const cmd of (i2c as any).txFIFO.items as number[]) {
          if (!(cmd & CMD) || cmd & RESTART) break;
          n++;
          if (cmd & STOP) break;
        }
      rbuf = ask(MREQ.READ, mAddr, n) ?? new Array(n).fill(0xff);
    }
    i2c.completeRead(rbuf.shift() ?? 0xff);
  };
  i2c.onStop = () => {
    flush();
    i2c.completeStop();
  };
  // ---- I2C at the pin level: programs that toggle SDA/SCL by hand (arduino-pico's Wire checks
  // whether a chip is there this way; software-I2C libraries do whole transfers like it). Open
  // drain: a line is low when the chip drives it low or a target pulls SDA low, else the pull-ups
  // hold it high. START/STOP/bits/ACKs decoded here; the simulation's chips answer through ask().
  const bus = { sda: -1, scl: -1 };
  const bb = { state: 0 as 0 | 1 | 2 | 3 | 4, bit: 0, byte: 0, addr: 0, pull: false, pendingAck: null as boolean | null, cur: 0, w: [] as number[], r: [] as number[], sda: 1, scl: 1, busy: false, n: 0 };
  const IDLE = 0, ADDR = 1, WRITE = 2, READ = 3, NACKED = 4;
  const line = (p: number) => (mcu.gpio[p].value === 0 /* Low */ ? 0 : 1);
  const bbFlush = () => {
    if (bb.state === WRITE && bb.w.length) ask(MREQ.WRITE, bb.addr, bb.w);
    bb.w = [];
  };
  const bbEdge = () => {
    if (bb.busy || bus.sda < 0 || mcu.gpio[bus.sda].functionSelect !== 5) return;
    bb.busy = true;
    const scl = line(bus.scl), sda = line(bus.sda) && !bb.pull ? 1 : 0;
    if (scl && bb.scl && sda !== bb.sda) {
      if (!sda) { // START (or repeated START)
        bbFlush();
        Object.assign(bb, { state: ADDR, bit: 0, byte: 0, pull: false, pendingAck: null });
      } else { // STOP
        bbFlush();
        bb.state = IDLE;
        bb.pull = false;
      }
    } else if (scl && !bb.scl && bb.state !== IDLE && bb.state !== NACKED) { // SCL rises: a bit
      bb.bit++;
      if (bb.bit <= 8 && bb.state !== READ) bb.byte = ((bb.byte << 1) | sda) & 0xff;
      if (bb.bit === 8 && bb.state === ADDR) {
        bb.addr = bb.byte >> 1;
        const ack = ask(MREQ.PROBE, bb.addr, 0) !== null;
        bb.n++;
        bb.pendingAck = ack;
        if (ack && bb.byte & 1) bb.r = ask(MREQ.READ, bb.addr, 32) ?? [];
      } else if (bb.bit === 8 && bb.state === WRITE) {
        bb.w.push(bb.byte);
        bb.pendingAck = true;
      } else if (bb.bit === 9 && bb.state === READ && sda) bb.state = NACKED; // the controller's NACK: last byte
    } else if (!scl && bb.scl && bb.state !== IDLE) { // SCL falls: the target's turn to set SDA
      if (bb.bit === 8 && bb.pendingAck !== null) {
        bb.pull = bb.pendingAck; // ACK = SDA low through the 9th clock
      } else if (bb.bit === 9) {
        if (bb.state === ADDR) bb.state = !bb.pendingAck ? NACKED : bb.byte & 1 ? READ : WRITE;
        bb.pendingAck = null;
        bb.bit = 0;
        bb.byte = 0;
        bb.pull = false;
        if (bb.state === READ) {
          bb.cur = bb.r.length ? bb.r.shift()! : 0xff;
          bb.pull = !(bb.cur & 0x80);
        }
      } else if (bb.state === READ && bb.bit >= 1 && bb.bit <= 7) bb.pull = !(bb.cur & (0x80 >> bb.bit));
      else if (bb.state === READ && bb.bit === 8) bb.pull = false; // released for the controller's ACK
    }
    bb.scl = scl;
    bb.sda = line(bus.sda) && !bb.pull ? 1 : 0;
    mcu.gpio[bus.sda].setInputValue(!!bb.sda);
    mcu.gpio[bus.scl].setInputValue(!!scl);
    bb.busy = false;
  };
  // every output change goes into the pin-change log, for clocked chips in the simulation
  const lastLv = new Int8Array(GP).fill(-1);
  const logEdge = (p: number, lv: number) => {
    const h = Atomics.load(sh.ctl, C.EV_HEAD);
    const next = (h + 1) % EVENTS;
    while (next === Atomics.load(sh.ctl, C.EV_TAIL)) { // full: let the simulation catch up
      const s = Atomics.load(sh.ctl, C.STEP);
      Atomics.wait(sh.ctl, C.STEP, s, 50);
    }
    sh.ev[h] = (p << 1) | lv;
    Atomics.store(sh.ctl, C.EV_HEAD, next);
  };
  for (const pin of mcu.gpio) pin.addListener((state) => {
    if (pin.index === bus.sda || pin.index === bus.scl) bbEdge();
    if (pin.index < GP && (state === 0 || state === 1) && state !== lastLv[pin.index]) {
      lastLv[pin.index] = state;
      logEdge(pin.index, state);
    } else if (state > 1) lastLv[pin.index] = -1;
  });

  const cdc = new USBCDC(mcu.usbCtrl);
  let serial = '';
  const dec = new TextDecoder();
  cdc.onSerialData = (buf) => (serial += dec.decode(buf, { stream: true }));
  cdc.onDeviceConnected = () => {
    for (const ch of new TextEncoder().encode('\n')) cdc.sendSerialByte(ch); // DTR: "a terminal is open"
  };
  post({ type: 'log', message: `firmware loaded (${blocks} blocks, ${(blocks / 4).toFixed(0)} KB)` });
  Atomics.store(sh.ctl, C.STATE, 1);

  const ns = () => clock.nanos;
  /** run up to n instructions (or until `until` says stop); false if the chip is asleep with nothing to wake it */
  const exec = (n: number, until?: () => boolean) => {
    const cyc = 1e9 / (mcu.clkSys || 125e6);
    for (let i = 0; i < n; i++) {
      if (mcu.core.waiting) {
        const d = clock.nanosToNextAlarm;
        if (!Number.isFinite(d) || d <= 0) return false;
        clock.tick(d);
        i += d / cyc;
      } else clock.tick(mcu.core.executeInstruction() * cyc);
      if (until && (i & 31) === 0 && until()) return true;
    }
    return true;
  };

  const lastIn = new Int32Array(GP).fill(-1);
  const syncPins = () => {
    let sda = -1, scl = -1;
    const owned = (p: number) => (p === bus.sda || p === bus.scl) && mcu.gpio[p].functionSelect === 5;
    for (let p = 0; p < GP; p++) {
      const pin = mcu.gpio[p];
      const fn = pin.functionSelect;
      sh.pull[p] = pin.pullupEnabled ? 1 : pin.pulldownEnabled ? 2 : 0;
      if (fn === 4) { // PWM: read the slice's settings straight from its registers
        const ch = mcu.pwm.channels[(p >> 1) & 7];
        const top = ch.top + 1;
        const cc = p & 1 ? ch.cc >>> 16 : ch.cc & 0xffff;
        const div = (ch.div >> 4) + (ch.div & 15) / 16 || 1;
        const enabled = ch.csr & 1;
        const hz = (mcu.clkSys || 125e6) / (div * top * (ch.csr & 2 ? 2 : 1));
        const duty = Math.min(1, cc / top);
        sh.out[p] = !enabled || duty <= 0 ? OUT.LOW : duty >= 1 ? OUT.HIGH : OUT.PWM;
        sh.duty[p] = duty;
        sh.hz[p] = hz;
      } else if (fn === 3) {
        sh.out[p] = OUT.INPUT; // the I2C pins: the bus, not GPIO
        if (p % 4 === 0 && sda < 0) sda = p; // I2C0's SDA pins: GP0, 4, 8 ... ; SCL: GP1, 5, 9 ...
        if (p % 4 === 1 && scl < 0) scl = p;
      }
      else if (pin.outputEnable) sh.out[p] = pin.outputValue ? OUT.HIGH : OUT.LOW;
      else sh.out[p] = OUT.INPUT;
      const lv = sh.inp[p];
      if (owned(p)) lastIn[p] = -1; // the bus model below sets these
      else if (lv !== lastIn[p]) {
        lastIn[p] = lv;
        pin.setInputValue(!!lv);
      }
    }
    for (let ch = 0; ch < 4; ch++) mcu.adc.channelValues[ch] = sh.adc[ch];
    // the bus stays where it was last seen while a program toggles its pins by hand
    if (sda >= 0 && scl >= 0 && (sda !== bus.sda || scl !== bus.scl)) {
      bus.sda = sda;
      bus.scl = scl;
      post({ type: 'log', message: `I2C bus on GP${sda} (SDA) / GP${scl} (SCL)` });
    }
    sh.ctl[C.I2C_SDA] = bus.sda;
    sh.ctl[C.I2C_SCL] = bus.scl;
    sh.ctl[C.SAR] = i2c.live ? i2c.slaveAddress & 0x7f : -1;
    sh.f64[1] = ns();
  };

  // one bus transaction, the way the real hardware hands it to the firmware's interrupt handler
  const transact = () => {
    const type = sh.ctl[C.REQ_TYPE], addr = sh.ctl[C.REQ_ADDR], len = sh.ctl[C.REQ_LEN];
    if (!i2c.live || (i2c.slaveAddress & 0x7f) !== addr) {
      sh.ctl[C.RESP_STATUS] = 2;
      sh.ctl[C.RESP_LEN] = 0;
      return;
    }
    const budget = 400000; // instructions the firmware gets to react
    i2c.busStart();
    if (type === 1) {
      for (let k = 0; k < len; k++) {
        if (i2c.rx.length >= 16) exec(budget, () => i2c.rx.length < 16); // FIFO full: the bus waits
        i2c.busByte(sh.req[k], k === 0);
      }
      exec(budget, () => i2c.rx.length === 0);
      i2c.busStop();
      exec(budget, () => !(i2c.intRaw & R_STOP_DET));
      sh.ctl[C.RESP_STATUS] = 0;
      sh.ctl[C.RESP_LEN] = 0;
    } else {
      for (let k = 0; k < len; k++) {
        i2c.busReadRequest();
        exec(budget, () => i2c.txByte !== null);
        sh.resp[k] = i2c.txByte ?? 0xff;
      }
      i2c.busStop();
      exec(budget, () => !(i2c.intRaw & R_STOP_DET));
      sh.ctl[C.RESP_STATUS] = 0;
      sh.ctl[C.RESP_LEN] = len;
    }
  };

  let lastPost = 0, lastBeat = 0;
  post({ type: 'log', message: 'running' });
  for (;;) {
    syncPins();
    if (Atomics.load(sh.ctl, C.REQ) === 1) {
      transact();
      Atomics.store(sh.ctl, C.REQ, 2);
    }
    // keep pace with the simulation: never more than 2 ms ahead of it
    if (ns() > sh.f64[0] + 2e6) {
      const s = Atomics.load(sh.ctl, C.STEP);
      if (ns() > sh.f64[0] + 2e6) Atomics.wait(sh.ctl, C.STEP, s, 100);
      if (Atomics.load(sh.ctl, C.REQ) !== 1) continue;
    }
    if (!exec(20000)) {
      // asleep with no timer running: wait for the simulation (pins or the bus) to wake it
      const s = Atomics.load(sh.ctl, C.STEP);
      Atomics.wait(sh.ctl, C.STEP, s, 50);
    }
    if (ns() - lastBeat > 1e9) {
      lastBeat = ns();
      post({ type: 'log', message: `alive: ${(ns() / 1e9).toFixed(1)} s chip time, PC 0x${(mcu.core.PC >>> 0).toString(16)}, ${mcu.core.waiting ? 'sleeping' : 'running'}, I2C on GP${sh.ctl[C.I2C_SDA]}/GP${sh.ctl[C.I2C_SCL]}` });
    }
    if (serial && ns() - lastPost > 20e6) {
      post({ type: 'serial', text: serial });
      serial = '';
      lastPost = ns();
    }
  }
}
