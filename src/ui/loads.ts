// The load check: while the bench runs, how hard each thing works against what it can take, so a
// part that's too weak shows up before it's bought. Glue joints (glue.ts), servos and motors (their
// torque against their rating at the volts they get), motor drivers (current against their rating),
// batteries and supplies (current against what they can give, and how far their voltage sags), and
// flying machines (the thrust they need to hover against what their propellers can give).
import type { Circuit } from '../elec/circuit';
import type { GlueCheck } from '../glue';
import { KGCM } from '../parts/types';
import type { Group, Sim } from '../sim';
import { fullThrust } from '../thrusters';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (e as any)[k] = v;
  e.append(...kids);
  return e;
};

export interface LoadRow {
  kind: 'glue' | 'motor' | 'driver' | 'power' | 'flight';
  key: string;
  name: string;
  /** share of what it can take: now and the most so far (1 = all of it) */
  now: number;
  peak: number;
  /** the numbers behind it */
  detail: string;
  /** the parts to select when it's clicked */
  uids: string[];
  /** it gave way (glue that broke) */
  broken?: boolean;
}

/** what each driver can give, A (both its channels together) */
const DRIVER_A: Record<string, number> = { drv8833: 2.4, l298n: 4, 'motor-drivers/tb6612': 2.4, 'motor-drivers/l9110s': 1.6, 'motor-drivers/drv8871': 3.6, 'motor-drivers/bts7960': 43 };

const KIND_TITLE: Record<LoadRow['kind'], string> = {
  glue: 'Glue joints',
  motor: 'Servos and motors (torque)',
  driver: 'Motor drivers (current)',
  power: 'Batteries and supplies (current)',
  flight: 'Flying (thrust needed to hover)',
};

export interface LoadsHost {
  viewport: HTMLElement;
  sim(): Sim | null;
  circuit(): Circuit | null;
  glue(): GlueCheck | null;
  select(uid: string): void;
  log(msg: string, level?: 'info' | 'warn' | 'bad'): void;
}

/** Reads every load now (call a few times a second while running). */
export class LoadWatch {
  private peaks = new Map<string, number>();
  private told = new Set<string>();
  rows: LoadRow[] = [];

  reset() {
    this.peaks.clear();
    this.told.clear();
    this.rows = [];
  }

  sample(host: LoadsHost) {
    const sim = host.sim(), c = host.circuit(), glue = host.glue();
    const rows: LoadRow[] = [];
    const peak = (key: string, now: number, early = false) => {
      const p = Math.max(this.peaks.get(key) ?? 0, early ? 0 : now);
      this.peaks.set(key, p);
      return p;
    };
    const settled = (sim?.time ?? 0) > 0.3;
    // glue
    for (const b of glue?.bonds ?? []) {
      const uid = b.child.slice(0, b.child.lastIndexOf('/'));
      const p = b.parts;
      rows.push({
        kind: 'glue', key: `glue:${b.child}`, name: b.name, now: b.alive ? b.use : 0, peak: b.peak, broken: !b.alive,
        detail: `${b.area.toFixed(2)} cm2: pull ${p.pull.toFixed(1)} N, sideways ${p.shear.toFixed(1)} N, bend ${p.bend.toFixed(1)} N*cm, twist ${p.twist.toFixed(1)} N*cm`,
        uids: [uid],
      });
    }
    // servos and motors
    if (sim && glue)
      for (const a of sim.actuators) {
        if (a.spec.kind === 'free') continue;
        const ml = glue.motorLoad.get(a);
        if (!ml) continue;
        const scale = a.limp ? 0.2 : Math.max(0.05, a.volts / a.spec.ratedVolts);
        const cap = a.spec.maxTorque * KGCM * Math.min(1.5, scale);
        const now = cap > 0 ? ml.now / cap : 0;
        const kgcm = ml.now / KGCM;
        const unit = a.slide ? 'kg' : 'kg*cm';
        rows.push({
          kind: 'motor', key: `motor:${a.id}`, name: a.view.inst.name + (a.def.name === 'horn' || a.def.name === 'hub' || a.def.name === 'shaft' ? '' : ` (${a.def.name})`),
          now, peak: peak(`motor:${a.id}`, now, !settled),
          detail: `${kgcm.toFixed(2)} of ${(a.spec.maxTorque * Math.min(1.5, scale)).toFixed(1)} ${unit}${a.limp ? (a.spec.kind === 'servo' ? ' (no signal: its gears hold it)' : ' (not driven: its gearbox holds it)') : ` at ${a.volts.toFixed(1)} V`}${ml.known ? '' : ' (estimate: its joint is in a loop)'}`,
          uids: [a.view.inst.uid],
        });
      }
    if (c) {
      // motor drivers
      for (const d of c.devices) {
        const cap = DRIVER_A[d.view.inst.type];
        if (!cap || !d.current) continue;
        const amps = d.current();
        const now = amps / cap;
        rows.push({ kind: 'driver', key: `drv:${d.view.inst.uid}`, name: d.view.inst.name, now, peak: peak(`drv:${d.view.inst.uid}`, now, !settled), detail: `${amps.toFixed(2)} A of ${cap} A`, uids: [d.view.inst.uid] });
      }
      // batteries and supplies
      for (const d of c.devices) {
        if (!d.power) continue;
        const p = d.power();
        const sag = p.open > 0 ? Math.max(0, p.open - p.volts) : 0;
        const now = p.maxA ? p.amps / p.maxA : 0;
        rows.push({
          kind: 'power', key: `pow:${d.view.inst.uid}`, name: d.view.inst.name, now, peak: peak(`pow:${d.view.inst.uid}`, now, !settled),
          detail: `${p.amps.toFixed(2)} A${p.maxA ? ` of ${p.maxA} A` : ''}, ${p.volts.toFixed(2)} V${sag > 0.05 ? ` (sags ${sag.toFixed(2)} V from ${p.open.toFixed(2)})` : ''}`,
          uids: [d.view.inst.uid],
        });
      }
    }
    // flying: each machine with propellers, the thrust it needs to hover of what they can give
    if (sim && sim.thrusters.size) {
      const byMachine = new Map<Group, { thrust: number; names: string[]; uids: string[] }>();
      const machineOf = (g: Group) => {
        // (the pieces joined to it by joints: one machine)
        const seen = new Set<Group>([g]);
        const todo = [g];
        while (todo.length) {
          const x = todo.pop()!;
          for (const j of sim.joints) {
            const o = j.ga === x ? j.gb : j.gb === x ? j.ga : null;
            if (o && !o.fixed && !seen.has(o)) { seen.add(o); todo.push(o); }
          }
        }
        return seen;
      };
      const groupOfRb = new Map(sim.groups.map((g) => [g.rb.handle, g]));
      const machines: { set: Set<Group>; root: Group }[] = [];
      for (const t of sim.thrusters.values()) {
        const g = groupOfRb.get(t.rb.handle);
        if (!g || g.fixed) continue;
        let m = machines.find((x) => x.set.has(g));
        if (!m) { m = { set: machineOf(g), root: g }; machines.push(m); }
        const e = byMachine.get(m.root) ?? { thrust: 0, names: [], uids: [] };
        e.thrust += fullThrust(t);
        e.names.push(t.view.inst.name);
        e.uids.push(t.view.inst.uid);
        byMachine.set(m.root, e);
      }
      for (const m of machines) {
        const e = byMachine.get(m.root)!;
        let mass = 0;
        for (const g of m.set) mass += g.rb.mass();
        const weightN = (mass * sim.g) / 1e5;
        const now = e.thrust > 0.01 ? weightN / e.thrust : 0;
        const key = `fly:${m.root.members[0].key}`;
        // (named after the part everything else is glued onto: its frame)
        const all = [...m.set].flatMap((g) => g.members);
        const base = all.find((x) => !x.view.inst.parent) ?? all.reduce((a, b) => (b.mass > a.mass ? b : a));
        const name = base.view.inst.name;
        rows.push({
          kind: 'flight', key, name: `${name} (${e.names.length} propellers)`, now, peak: peak(key, now, !settled),
          detail: e.thrust > 0.01 ? `${(mass / 1000).toFixed(3)} kg (${weightN.toFixed(2)} N) on ${e.thrust.toFixed(2)} N of thrust at full throttle: ${(e.thrust / weightN).toFixed(1)} to 1 (real drones want 2 to 1 or more)` : 'no power on its ESCs yet',
          uids: e.uids,
        });
      }
    }
    this.rows = rows;
    // say it once when something works near or past what it can take
    for (const r of rows) {
      if (r.kind === 'glue' || !settled) continue;
      const level = r.now >= 1 ? 'over' : r.now >= 0.9 ? 'near' : '';
      if (!level || this.told.has(`${r.key}:${level}`)) continue;
      this.told.add(`${r.key}:${level}`);
      const what =
        r.kind === 'motor' ? `${r.name} is working at ${Math.round(r.now * 100)} % of its torque (${r.detail}): ${r.now >= 1 ? 'more than it can give: it stalls' : 'close to its limit'}. A stronger one, a shorter arm or less weight.`
        : r.kind === 'driver' ? `${r.name} carries ${r.detail} (${Math.round(r.now * 100)} %): ${r.now >= 1 ? 'a real one overheats and shuts down' : 'near its limit: it runs hot'}. A bigger driver, or motors that draw less.`
        : r.kind === 'power' ? `${r.name} gives ${r.detail}: ${r.now >= 1 ? 'more than it can' : 'near what it can'}. Its voltage sags and boards may reset: a bigger battery (or supply).`
        : `${r.name} needs ${Math.round(r.now * 100)} % of its thrust just to hover: ${r.now >= 1 ? "it can't take off" : 'it barely flies and has nothing left to steer with'}. Lighter, bigger propellers, or more volts.`;
      host.log(what, r.now >= 1 ? 'bad' : 'warn');
      console.info(`[loads] ${r.key}: ${Math.round(r.now * 100)} % (${r.detail})`);
    }
  }
}

/** The Loads window: every load as a bar, live while running. */
export class LoadsPanel {
  private box: HTMLDivElement | null = null;
  private body!: HTMLDivElement;
  private timer = 0;
  constructor(private host: LoadsHost, private watch: LoadWatch) {}

  get open() {
    return !!this.box;
  }
  toggle() {
    if (this.box) this.close();
    else this.show();
  }
  close() {
    clearInterval(this.timer);
    this.box?.remove();
    this.box = null;
  }
  private show() {
    this.body = el('div', { className: 'ld-body' });
    const head = el('div', { className: 'pg-head' },
      el('span', { className: 'pg-title', textContent: 'Loads' }),
      el('span', { className: 'ld-sub', textContent: 'how hard each thing works, of what it can take' }),
      el('button', { className: 'modal-x', textContent: '×', title: 'Close', onclick: () => this.close() }));
    this.box = el('div', { className: 'pingraph loads' }, head, this.body,
      el('div', { className: 'pg-note', textContent: 'Bars: now. The tick: the most so far this run. Yellow from 70 %, red at 100 % (it stalls, overheats, sags or lets go). Click a row to select the part.' })) as HTMLDivElement;
    head.onpointerdown = (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      const b = this.box!, r = b.getBoundingClientRect(), hr = this.host.viewport.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      head.onpointermove = (m) => {
        b.style.left = `${Math.max(0, m.clientX - hr.left - dx)}px`;
        b.style.top = `${Math.max(0, m.clientY - hr.top - dy)}px`;
        b.style.right = 'auto';
      };
      head.onpointerup = () => { head.onpointermove = null; };
    };
    this.host.viewport.append(this.box);
    this.draw();
    this.timer = window.setInterval(() => this.draw(), 250);
  }
  /** (also called by the app after a run ends: the last numbers stay) */
  draw() {
    if (!this.box) return;
    const running = !!this.host.sim();
    if (running) this.watch.sample(this.host);
    const rows = this.watch.rows;
    if (!rows.length) {
      this.body.replaceChildren(el('div', { className: 'pg-empty', textContent: running ? 'Nothing here carries a load the bench can measure (glue, motors, drivers, batteries, propellers).' : 'Press Run: the loads are measured while the bench runs.' }));
      return;
    }
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    const out: Node[] = [];
    for (const kind of Object.keys(KIND_TITLE) as LoadRow['kind'][]) {
      const list = rows.filter((r) => r.kind === kind).sort((a, b) => b.peak - a.peak);
      if (!list.length) continue;
      out.push(el('div', { className: 'ld-kind', textContent: KIND_TITLE[kind] }));
      // (the ones that hardly work, folded into one line: the list is for what's near its limit)
      const shown = list.filter((r, i) => i < 4 || r.peak >= 0.05 || r.broken).slice(0, 24);
      for (const r of shown) {
        const cls = r.broken ? 'bad' : r.now >= 1 ? 'bad' : r.now >= 0.7 ? 'warn' : 'ok';
        const bar = el('div', { className: 'ld-bar' },
          el('div', { className: `ld-fill ${cls}`, style: `width:${Math.min(100, r.now * 100)}%` }),
          el('div', { className: 'ld-peak', style: `left:${Math.min(100, r.peak * 100)}%` }));
        out.push(el('div', { className: 'ld-row', title: r.detail, onclick: () => this.host.select(r.uids[0]) },
          el('span', { className: 'ld-name', textContent: r.name }), bar,
          el('span', { className: `ld-num ${cls}`, textContent: r.broken ? 'broke' : pct(r.now) }),
          el('span', { className: 'ld-most', textContent: `most ${pct(r.peak)}` })));
      }
      const hidden = list.filter((r) => !shown.includes(r));
      if (hidden.length) out.push(el('div', { className: 'pg-empty', textContent: `and ${hidden.length} more, each at most ${Math.max(1, Math.ceil(Math.max(...hidden.map((r) => r.peak)) * 100))} %` }));
    }
    this.body.replaceChildren(...out);
  }
}
