// The pin graph (a logic analyzer): pick pins, run, and see their voltage over time, as a scope or
// logic analyzer shows it. It samples every simulation step (240 a second): a change faster than
// that (a clock line during shiftOut) shows as a busy block; PWM shows as a band with its duty and
// frequency. A floating panel over the bench; it keeps recording while it is open.
import type { Circuit } from '../elec/circuit';
import type { PartView } from '../views';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'string') e.setAttribute('style', v);
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
};

const COLORS = ['#ffd25a', '#5ad1ff', '#ff7a7a', '#8cff8a', '#d59bff', '#ffa85a', '#5affc8', '#ff8ad8'];
const KEEP = 240 * 30; // 30 s of samples per pin
const MAX_PINS = 8;

interface Channel {
  uid: string;
  pin: string;
  label: string;
  t: Float64Array; // simulation time, s
  v: Float32Array; // volts (NaN: nothing drives it)
  duty: Float32Array; // PWM duty 0..1, -1 = none
  hz: Float32Array;
  n: number; // samples written (ring index = n % KEEP)
  vmax: number;
}

export class PinGraph {
  private box: HTMLElement | null = null;
  private canvas!: HTMLCanvasElement;
  private list!: HTMLElement;
  private pick!: HTMLSelectElement;
  private span = 2; // seconds shown
  private chans: Channel[] = [];
  private drawPending = false;
  private paused = false;

  constructor(private host: HTMLElement, private views: () => Map<string, PartView>) {}

  get open() {
    return !!this.box;
  }

  toggle() {
    if (this.box) this.close();
    else this.show();
  }

  close() {
    this.box?.remove();
    this.box = null;
  }

  /** the run started again: old samples go */
  restart() {
    for (const c of this.chans) { c.n = 0; c.vmax = 1; }
    this.redraw();
  }

  private show() {
    this.canvas = el('canvas', { className: 'pg-canvas', width: 560, height: 240 });
    this.list = el('div', { className: 'pg-list' });
    this.pick = el('select', { title: 'Add a pin to the graph' }) as HTMLSelectElement;
    this.pick.onfocus = () => this.fillPick();
    this.pick.onmousedown = () => this.fillPick();
    this.pick.onchange = () => {
      const [uid, pin] = this.pick.value.split('|');
      if (uid && pin) this.add(uid, pin);
      this.pick.value = '';
    };
    this.fillPick();
    const spanSel = el('select', { title: 'How much time the graph shows' },
      ...[0.05, 0.2, 0.5, 2, 5, 10, 30].map((s) => el('option', { value: String(s), textContent: s < 1 ? `${s * 1000} ms` : `${s} s`, selected: s === this.span }))) as HTMLSelectElement;
    spanSel.onchange = () => { this.span = Number(spanSel.value); this.redraw(); };
    const hold = el('button', { textContent: 'Hold', title: 'Stop the graph moving (it keeps recording)' }) as HTMLButtonElement;
    hold.onclick = () => { this.paused = !this.paused; hold.classList.toggle('active', this.paused); hold.textContent = this.paused ? 'Holding' : 'Hold'; this.redraw(); };
    const head = el('div', { className: 'pg-head' },
      el('span', { className: 'pg-title', textContent: 'Pin graph' }), this.pick, spanSel, hold,
      el('button', { className: 'modal-x', textContent: '×', title: 'Close (the pins stay picked)', onclick: () => this.close() }));
    this.box = el('div', { className: 'pingraph' }, head, this.canvas, this.list,
      el('div', { className: 'pg-note', textContent: 'Voltage of each pin, sampled 240 times a second while running. Faster changes (a clock line) show as a filled block; PWM as a band with its duty and frequency.' }));
    // drag it by its title bar
    head.onpointerdown = (e) => {
      if ((e.target as HTMLElement).tagName !== 'DIV' && (e.target as HTMLElement).tagName !== 'SPAN') return;
      const b = this.box!, r = b.getBoundingClientRect(), hr = this.host.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      head.onpointermove = (m) => {
        b.style.left = `${Math.max(0, m.clientX - hr.left - dx)}px`;
        b.style.top = `${Math.max(0, m.clientY - hr.top - dy)}px`;
        b.style.bottom = 'auto';
      };
      head.onpointerup = () => { head.onpointermove = null; };
    };
    this.host.append(this.box);
    this.renderList();
    this.redraw();
  }

  private fillPick() {
    const keep = this.pick.value;
    this.pick.replaceChildren(el('option', { value: '', textContent: this.chans.length >= MAX_PINS ? `(${MAX_PINS} pins at most)` : 'Add a pin...' }));
    if (this.chans.length >= MAX_PINS) return;
    for (const v of this.views().values()) {
      const pins = v.build.pins ?? [];
      if (!pins.length) continue;
      const g = el('optgroup', { label: v.inst.name });
      for (const p of pins) {
        if (this.chans.some((c) => c.uid === v.inst.uid && c.pin === p.id)) continue;
        g.append(el('option', { value: `${v.inst.uid}|${p.id}`, textContent: p.label ? `${p.id} (${p.label})` : p.id }));
      }
      this.pick.append(g);
    }
    this.pick.value = keep;
  }

  add(uid: string, pin: string) {
    if (this.chans.length >= MAX_PINS || this.chans.some((c) => c.uid === uid && c.pin === pin)) return;
    const v = this.views().get(uid);
    this.chans.push({
      uid, pin, label: `${v?.inst.name ?? uid} ${pin}`,
      t: new Float64Array(KEEP), v: new Float32Array(KEEP), duty: new Float32Array(KEEP), hz: new Float32Array(KEEP), n: 0, vmax: 1,
    });
    console.info(`[pingraph] watching ${v?.inst.name ?? uid} ${pin}`);
    this.renderList();
    this.redraw();
  }

  private renderList() {
    if (!this.box) return;
    this.list.replaceChildren(...this.chans.map((c, i) =>
      el('span', { className: 'pg-chip', style: `border-color:${COLORS[i % COLORS.length]}` },
        el('span', { style: `color:${COLORS[i % COLORS.length]}`, textContent: '■ ' }), c.label,
        el('button', { textContent: '×', title: 'Take it off the graph', onclick: () => { this.chans.splice(i, 1); this.renderList(); this.redraw(); } }))));
    if (!this.chans.length) this.list.append(el('span', { className: 'pg-empty', textContent: 'Pick pins above, then run.' }));
  }

  /** after each simulation step */
  sample(c: Circuit) {
    if (!this.chans.length) return;
    for (const ch of this.chans) {
      const i = ch.n % KEEP;
      const net = c.net(ch.uid, ch.pin);
      const volts = c.v(ch.uid, ch.pin);
      ch.t[i] = c.time;
      ch.v[i] = volts === null ? NaN : volts;
      ch.duty[i] = net?.pwm ? net.pwm.duty : -1;
      ch.hz[i] = net?.pwm ? net.pwm.hz : 0;
      if (volts !== null && volts > ch.vmax) ch.vmax = Math.ceil(volts);
      ch.n++;
    }
    if (this.box && !this.paused && !this.drawPending) {
      this.drawPending = true;
      requestAnimationFrame(() => { this.drawPending = false; this.redraw(); });
    }
  }

  /** what the graph shows (for tests): per pin, its last value and how many samples */
  readout() {
    return this.chans.map((c) => ({ label: c.label, samples: c.n, last: c.n ? c.v[(c.n - 1) % KEEP] : null }));
  }

  private redraw() {
    if (!this.box) return;
    const cv = this.canvas, g = cv.getContext('2d')!;
    const w = cv.width, h = cv.height;
    g.fillStyle = '#12151a';
    g.fillRect(0, 0, w, h);
    const left = 4, right = w - 4;
    const n = this.chans.length;
    if (!n) {
      g.fillStyle = '#6b7280';
      g.font = '13px sans-serif';
      g.fillText('No pins picked yet', 12, 24);
      return;
    }
    const lane = (h - 18) / n;
    let tEnd = 0;
    for (const c of this.chans) if (c.n) tEnd = Math.max(tEnd, c.t[(c.n - 1) % KEEP]);
    const tStart = tEnd - this.span;
    const xOf = (t: number) => left + ((t - tStart) / this.span) * (right - left);
    // time grid
    g.strokeStyle = '#232833';
    g.fillStyle = '#6b7280';
    g.font = '10px sans-serif';
    g.lineWidth = 1;
    const step = this.span / 5;
    for (let k = 0; k <= 5; k++) {
      const x = left + (k / 5) * (right - left);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h - 14); g.stroke();
      const t = tStart + k * step;
      g.fillText(t >= 0 ? (this.span < 1 ? `${(t * 1000).toFixed(0)} ms` : `${t.toFixed(this.span < 5 ? 1 : 0)} s`) : '', Math.min(x + 2, w - 40), h - 3);
    }
    this.chans.forEach((c, ci) => {
      const top = ci * lane + 4, bot = (ci + 1) * lane - 4;
      const yOf = (v: number) => bot - (Math.max(0, Math.min(c.vmax, v)) / c.vmax) * (bot - top);
      const col = COLORS[ci % COLORS.length];
      g.strokeStyle = '#2b313c';
      g.beginPath(); g.moveTo(left, bot + 2); g.lineTo(right, bot + 2); g.stroke();
      g.fillStyle = col;
      g.font = '11px sans-serif';
      const count = Math.min(c.n, KEEP);
      const first = c.n - count;
      let lastPwm = '';
      // one column per pixel: the lowest and highest voltage in it (fast changes fill a block)
      let px = -1, lo = Infinity, hi = -Infinity, floating = false, pwmAt = -1;
      g.strokeStyle = col;
      g.lineWidth = 1.5;
      g.beginPath();
      let moved = false;
      const flush = () => {
        if (px < 0) return;
        if (lo === Infinity) {
          floating = true;
          moved = false;
          return;
        }
        if (!moved) { g.moveTo(px, yOf(lo)); moved = true; }
        g.lineTo(px, yOf(lo));
        if (hi !== lo) g.lineTo(px, yOf(hi));
      };
      for (let k = first; k < c.n; k++) {
        const i = k % KEEP;
        const t = c.t[i];
        if (t < tStart) continue;
        const x = Math.round(xOf(t));
        if (x !== px) { flush(); px = x; lo = Infinity; hi = -Infinity; }
        const v = c.v[i];
        if (c.duty[i] >= 0 && c.duty[i] < 1) {
          // PWM: between 0 and its high level, filled; labelled where it starts or changes
          lo = 0; hi = Math.max(hi, v / Math.max(0.01, c.duty[i]));
          const lbl = `PWM ${Math.round(c.duty[i] * 100)}% ${c.hz[i] >= 1000 ? `${(c.hz[i] / 1000).toFixed(1)} kHz` : `${Math.round(c.hz[i])} Hz`}`;
          if (lbl !== lastPwm) { lastPwm = lbl; pwmAt = x; g.save(); g.fillStyle = col; g.fillText(lbl, Math.min(x + 3, right - 90), top + 10); g.restore(); }
          continue;
        }
        if (Number.isNaN(v)) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      flush();
      g.stroke();
      void pwmAt;
      // its name and value now
      const lastV = c.n ? c.v[(c.n - 1) % KEEP] : NaN;
      g.fillStyle = col;
      g.fillText(`${c.label}: ${Number.isNaN(lastV) ? 'floating' : `${lastV.toFixed(2)} V`}${floating ? ' (floating at times)' : ''}`, left + 4, top + (lastPwm ? 22 : 10));
      g.fillStyle = '#6b7280';
      g.fillText(`${c.vmax} V`, right - 26, top + 10);
    });
  }
}
