// The electrical side of a run: pins joined by wires, port contacts and parts' own internal
// connections form nets; every physics step, devices drive nets (batteries, regulators, program pins,
// pull-ups) and then read them (servo pulses, LED voltage, logic inputs). Voltages are ideal: a net is
// at whatever its strongest driver says, which is how working circuits behave. The mistakes it can't
// solve as a circuit it reports instead: shorts, floating inputs, overvoltage, missing ground.
import * as THREE from 'three';
import type { PinDef, PortDef } from '../parts/types';
import type { Project } from '../project';
import type { Sim } from '../sim';
import type { PartView } from '../views';

export type Strength = 0 | 1 | 2 | 3; // 0 pull-up/down, 1 logic output, 2 power output (battery, regulator, driver), 3 hard ground
export interface Drive {
  v: number; // volts (while high, for PWM)
  strength: Strength;
  src: string; // who, for messages: "Maker board 1 GP7"
  pwm?: { hz: number; duty: number }; // switching between v and 0
  logic?: boolean; // a logic pin (can't power a motor)
  rises?: number; // count of rising edges so far (so sensors see pulses shorter than a step)
}

export class Net {
  id = 0;
  pins: string[] = []; // "uid/pin"
  drives: Drive[] = [];
  v: number | null = null; // null = nothing drives it (floating)
  pwm: { hz: number; duty: number } | null = null;
  top: Drive | null = null;
}

export interface I2CChip {
  name: string;
  address(): number;
  /** a write transfer to this chip: [register, data...]; false = no ACK. An emulated chip answers later (a Promise). */
  write(bytes: number[]): boolean | Promise<boolean>;
  /** a read transfer of n bytes (after a register-pointer write) */
  read(n: number): number[] | null | Promise<number[] | null>;
}

export interface Device {
  view: PartView;
  /** pins this part joins inside itself (a pressed button, a hub's traces). Changing it: set circuit.dirty */
  shorts?(): [string, string][];
  drive?(c: Circuit): void;
  sense?(c: Circuit, dt: number): void;
  i2c?: { sda: string; scl: string; chips: I2CChip[] };
  /** run-mode mouse on the part */
  press?(down: boolean): void;
  /** lines for the run inspector */
  status?(): string[];
  /** text typed into this board's serial monitor */
  sendSerial?(text: string): void;
  /** about how much current it draws from its supply now, A (for power monitors) */
  current?(): number;
  /** a power source: what it gives now (V, A), what it can give (A; none: no stated limit), its voltage
   *  with nothing drawn (for how far it sags) */
  power?(): { volts: number; amps: number; maxA?: number; open: number };
  /** pin changes on this part's own pins during the last step, in order (a program toggling pins
   *  faster than the simulation steps: clocked chips need every edge) */
  pinEvents?(): [string, 0 | 1][];
  /** pin changes other parts made on the nets of this part's pins, in order (its own pin ids) */
  edges?(events: [string, 0 | 1][]): void;
  /** extra controls for the run inspector (knob slider, buttons, a text box...) */
  controls?(): Control[];
  /** messages other parts sent on the nets of this part's pins (its own pin ids): serial bytes,
   *  LED-strip pixels, a sensor's reading. See Circuit.send. */
  packets?(list: Packet[]): void;
  /** an SPI chip on its pins: what it answers (and sees: the levels of its pins at that moment) */
  spi?: SpiChip;
  dispose?(): void;
}

/** A chip on an SPI bus. A board's transfer reaches the chips on its SCK and MOSI wires whose CS pin is
 *  low; `pins` has the levels of the chip's own pins when the bytes went (a screen's DC pin, say). */
export interface SpiChip {
  sck: string;
  mosi: string;
  miso?: string;
  cs: string;
  transfer(bytes: number[], pins: Record<string, 0 | 1 | null>, reply: boolean): number[] | Promise<number[]> | void;
}

export const pinKey = (uid: string, pin: string) => `${uid}/${pin}`;

/** A control in the run inspector. Without `kind`: a slider (min/max/step, get/set). */
export type Control =
  | { kind?: 'slider'; label: string; min: number; max: number; step: number; get(): number; set(v: number): void }
  | { kind: 'button'; label: string; cols?: number; press(down: boolean): void; isDown?(): boolean }
  | { kind: 'switch'; label: string; get(): boolean; set(on: boolean): void }
  | { kind: 'text'; label: string; send(text: string): void };

/** Data sent along a wire, faster than the simulation steps could carry it as pin changes:
 *  'uart' serial bytes (with their baud rate), 'pixels' (an LED strip's colours), 'data' (a one-wire
 *  sensor's answer), 'ir' (an infrared remote's code). Delivered to the other parts on the same net. */
export interface Packet {
  pin: string; // the receiving part's own pin
  proto: string;
  data: number[];
  baud?: number;
  from?: string; // who sent it (for messages)
}
export const PACKET_MAX = 4096; // bytes in one message
const PACKETS_PER_STEP = 64; // per sender

export class Circuit {
  nets: Net[] = [];
  private byPin = new Map<string, Net>();
  dirty = true;
  time = 0;
  private warned = new Set<string>();
  private outbox: { uid: string; pin: string; p: Omit<Packet, 'pin'> }[] = [];
  private sentNow = new Map<string, number>();

  constructor(
    public project: Project,
    public views: PartView[],
    public devices: Device[],
    public sim: Sim,
    public log: (msg: string, level?: 'info' | 'warn' | 'bad') => void,
  ) {}

  warnOnce(key: string, msg: string, level: 'warn' | 'bad' = 'warn') {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(msg, level);
  }

  pinDef(uid: string, pin: string): PinDef | undefined {
    return this.views.find((v) => v.inst.uid === uid)?.build.pins?.find((p) => p.id === pin);
  }

  /** Port contacts: a male and a female port of different parts touching, facing each other. */
  private portPairs(): [string, string][] {
    const out: [string, string][] = [];
    const ports: { view: PartView; def: PortDef; pos: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    for (const v of this.views)
      for (const def of v.build.ports ?? []) {
        const body = v.bodies.get(def.body)!;
        body.updateWorldMatrix(true, false);
        ports.push({
          view: v, def,
          pos: new THREE.Vector3(...def.pos).applyMatrix4(body.matrixWorld),
          normal: new THREE.Vector3(...def.normal).transformDirection(body.matrixWorld),
        });
      }
    for (let i = 0; i < ports.length; i++)
      for (let j = i + 1; j < ports.length; j++) {
        const a = ports[i], b = ports[j];
        if (a.view === b.view || a.def.gender === b.def.gender) continue;
        if (a.pos.distanceTo(b.pos) > 1.2 || a.normal.dot(b.normal) > -0.8) continue; // not touching, or not facing
        for (let k = 0; k < 4; k++) out.push([pinKey(a.view.inst.uid, a.def.pins[k]), pinKey(b.view.inst.uid, b.def.pins[k])]);
        this.log(`${a.view.inst.name} and ${b.view.inst.name}: ports clicked together`);
      }
    return out;
  }

  private portLinks: [string, string][] | null = null;

  build() {
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      if (!parent.has(k)) parent.set(k, k);
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(k, r);
      return r;
    };
    const union = (a: string, b: string) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const v of this.views) for (const p of v.build.pins ?? []) find(pinKey(v.inst.uid, p.id));
    for (const w of this.project.wires) if (!this.broken.has(w.id)) union(pinKey(w.a.uid, w.a.pin), pinKey(w.b.uid, w.b.pin));
    this.portLinks ??= this.portPairs(); // parts glued together don't move relative to each other
    for (const [a, b] of this.portLinks) union(a, b);
    for (const d of this.devices) for (const [a, b] of d.shorts?.() ?? []) union(pinKey(d.view.inst.uid, a), pinKey(d.view.inst.uid, b));
    const byRoot = new Map<string, Net>();
    const old = new Map(this.byPin);
    this.byPin.clear();
    for (const k of parent.keys()) {
      const r = find(k);
      if (!byRoot.has(r)) byRoot.set(r, Object.assign(new Net(), { id: byRoot.size }));
      const n = byRoot.get(r)!;
      n.pins.push(k);
      this.byPin.set(k, n);
    }
    this.nets = [...byRoot.values()];
    // a switch closing or opening rebuilds the nets mid-run: each new net starts at the voltage its
    // pins had (or a board on a battery would see no supply for a step, and reset)
    if (old.size)
      for (const n of this.nets)
        for (const k of n.pins) {
          const was = old.get(k);
          if (was && was.v !== null) {
            n.v = was.v;
            n.pwm = was.pwm;
            break;
          }
        }
    this.dirty = false;
  }

  net(uid: string, pin: string) {
    return this.byPin.get(pinKey(uid, pin));
  }
  /** connected to anything at all (other than its own part)? */
  wired(uid: string, pin: string) {
    const n = this.net(uid, pin);
    return !!n && n.pins.some((k) => !k.startsWith(uid + '/'));
  }
  drive(uid: string, pin: string, d: Drive) {
    this.net(uid, pin)?.drives.push(d);
  }
  v(uid: string, pin: string): number | null {
    return this.net(uid, pin)?.v ?? null;
  }
  /** average voltage (PWM counted by its duty) */
  avg(uid: string, pin: string): number {
    const n = this.net(uid, pin);
    if (!n || n.v === null) return 0;
    return n.pwm ? n.v * n.pwm.duty : n.v;
  }
  /** logic level: 1, 0, or null when floating */
  level(uid: string, pin: string, threshold = 1.5): 0 | 1 | null {
    const n = this.net(uid, pin);
    if (!n || n.v === null) return null;
    if (n.pwm) return n.pwm.duty > 0.5 ? 1 : 0;
    return n.v >= threshold ? 1 : 0;
  }
  /** supply across two pins (0 when either isn't driven) */
  supply(uid: string, plus: string, minus: string): number {
    const a = this.v(uid, plus), b = this.v(uid, minus);
    return a === null || b === null ? 0 : a - b;
  }
  /** Send a message on the net of pin `pin` of part `uid` (to every other part on that net, next step). */
  send(uid: string, pin: string, proto: string, data: ArrayLike<number>, baud?: number) {
    const n = (this.sentNow.get(uid) ?? 0) + 1;
    this.sentNow.set(uid, n);
    if (n > PACKETS_PER_STEP) {
      this.warnOnce(`pkts:${uid}`, `${this.views.find((v) => v.inst.uid === uid)?.inst.name ?? uid} sends more than ${PACKETS_PER_STEP} messages in one step: the rest are dropped`);
      return;
    }
    if (data.length > PACKET_MAX) this.warnOnce(`pktlen:${uid}`, `${this.views.find((v) => v.inst.uid === uid)?.inst.name ?? uid} sent a ${data.length}-byte message: only the first ${PACKET_MAX} bytes go through`);
    const bytes = Array.from(data).slice(0, PACKET_MAX).map((x) => Number(x) & 255);
    this.outbox.push({ uid, pin, p: { proto: String(proto), data: bytes, baud, from: `${this.views.find((v) => v.inst.uid === uid)?.inst.name ?? uid} ${pin}` } });
  }
  private deliver() {
    this.sentNow.clear();
    if (!this.outbox.length) return;
    const box = this.outbox;
    this.outbox = [];
    const batches = new Map<Device, Packet[]>();
    for (const m of box) {
      const net = this.net(m.uid, m.pin);
      if (!net) continue;
      for (const d of this.devices) {
        if (!d.packets || d.view.inst.uid === m.uid) continue;
        const pre = d.view.inst.uid + '/';
        for (const k of net.pins)
          if (k.startsWith(pre)) {
            if (!batches.has(d)) batches.set(d, []);
            batches.get(d)!.push({ ...m.p, pin: k.slice(pre.length) });
          }
      }
    }
    for (const [d, list] of batches)
      try {
        d.packets!(list);
      } catch (e) {
        console.warn('[circuit] a part failed to take its messages:', e);
      }
  }

  /** the chips on the I2C bus that pin `sda` of part `uid` is on */
  i2cChips(uid: string, sda: string, scl: string): I2CChip[] {
    const nSda = this.net(uid, sda), nScl = this.net(uid, scl);
    if (!nSda || !nScl) return [];
    const out: I2CChip[] = [];
    for (const d of this.devices) {
      if (!d.i2c || d.view.inst.uid === uid) continue;
      if (this.net(d.view.inst.uid, d.i2c.sda) === nSda && this.net(d.view.inst.uid, d.i2c.scl) === nScl) out.push(...d.i2c.chips);
    }
    return out;
  }

  /** wires that snapped during this run (pulled too hard): they no longer join anything */
  broken = new Set<string>();
  snapWire(id: string) {
    if (this.broken.has(id)) return;
    this.broken.add(id);
    this.dirty = true;
  }

  /** Parts with an SPI chip on the same SCK and MOSI wires as these pins of `uid`. */
  spiDevices(uid: string, sck: string, mosi: string): Device[] {
    const nSck = this.net(uid, sck), nMosi = this.net(uid, mosi);
    if (!nSck || !nMosi) return [];
    return this.devices.filter((d) => d.spi && d.view.inst.uid !== uid && this.net(d.view.inst.uid, d.spi.sck) === nSck && this.net(d.view.inst.uid, d.spi.mosi) === nMosi);
  }

  step(dt: number) {
    if (this.dirty) this.build();
    this.time += dt;
    for (const n of this.nets) n.drives.length = 0;
    for (const d of this.devices) d.drive?.(this);
    for (const n of this.nets) {
      n.v = null;
      n.pwm = null;
      n.top = null;
      if (!n.drives.length) continue;
      const max = Math.max(...n.drives.map((x) => x.strength)) as Strength;
      const top = n.drives.filter((x) => x.strength === max);
      n.top = top[0];
      n.v = top[0].v;
      n.pwm = top[0].pwm ?? null;
      for (const other of top.slice(1))
        if (max > 0 && (Math.abs(other.v - n.v) > 0.4 || (!!other.pwm !== !!n.pwm))) {
          this.warnOnce(`short:${top[0].src}:${other.src}`,
            `Short circuit: ${top[0].src} (${top[0].v.toFixed(1)} V) and ${other.src} (${other.v.toFixed(1)} V) are wired together. In real life something gets hot.`, 'bad');
          n.v = Math.min(n.v, other.v);
        }
    }
    this.passEdges();
    this.deliver();
    for (const d of this.devices) d.sense?.(this, dt);
  }

  private listeners: Device[] | null = null;
  /** every pin change a part made this step goes, in order, to the listening parts on that net */
  private passEdges() {
    this.listeners ??= this.devices.filter((d) => d.edges);
    const batches = new Map<Device, [string, 0 | 1][]>();
    for (const d of this.devices) {
      const evs = d.pinEvents?.(); // (always taken, so a program's log never fills up)
      if (!evs?.length || !this.listeners.length) continue;
      const src = d.view.inst.uid;
      for (const [pin, v] of evs) {
        const net = this.net(src, pin);
        if (!net) continue;
        for (const l of this.listeners) {
          if (l === d) continue;
          const pre = l.view.inst.uid + '/';
          for (const k of net.pins)
            if (k.startsWith(pre)) {
              if (!batches.has(l)) batches.set(l, []);
              batches.get(l)!.push([k.slice(pre.length), v]);
            }
        }
      }
    }
    for (const [l, evs] of batches) l.edges!(evs);
  }

  dispose() {
    for (const d of this.devices) d.dispose?.();
  }
}
