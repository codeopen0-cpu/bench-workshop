// The circuit check's window: what's broken, what to look at, and what got fixed since last time.
import type { Issue } from '../elec/check';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'string') e.setAttribute('style', v);
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
};

export class CheckWindow {
  private last = new Map<string, Issue>(); // the previous check's findings
  private back: HTMLElement | null = null;

  constructor(private run: () => Issue[], private select: (uids: string[]) => void) {}

  /** check now; returns what was found and what was fixed since the last check */
  check() {
    const now = this.run();
    const keys = new Set(now.map((i) => i.key));
    const fixed = [...this.last.values()].filter((i) => !keys.has(i.key));
    this.last = new Map(now.map((i) => [i.key, i]));
    console.info(`[check] ${now.filter((i) => i.level === 'fault').length} broken, ${now.filter((i) => i.level === 'warn').length} to look at, ${fixed.length} fixed`);
    return { now, fixed };
  }

  opened = false; // (the tutorial asks)
  open() {
    this.opened = true;
    const { now, fixed } = this.check();
    this.back?.remove();
    const back = (this.back = el('div', { className: 'modal-back', onclick: (e: MouseEvent) => e.target === back && close() }));
    const close = () => {
      back.remove();
      this.back = null;
      document.removeEventListener('keydown', esc);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', esc);
    const row = (i: Issue, kind: 'fault' | 'warn' | 'fixed') =>
      el('div', { className: `ck-row ck-${kind}`, title: 'Click to select the parts', onclick: () => { close(); this.select(i.parts); } },
        el('span', { className: 'ck-tag', textContent: kind === 'fault' ? 'Broken' : kind === 'warn' ? 'Check' : 'Fixed' }),
        el('span', { textContent: i.what }));
    const faults = now.filter((i) => i.level === 'fault'), warns = now.filter((i) => i.level === 'warn');
    const body = el('div', { className: 'pm-body' });
    if (!now.length) body.append(el('div', { className: 'ck-ok', textContent: 'Nothing wrong found in the wiring.' }));
    if (faults.length) body.append(el('div', { className: 'pm-sub', textContent: `Broken (${faults.length}): this would fail or damage something on a real bench.` }), ...faults.map((i) => row(i, 'fault')));
    if (warns.length) body.append(el('div', { className: 'pm-sub', textContent: `Check these (${warns.length}): they look wrong, but may be what you meant.` }), ...warns.map((i) => row(i, 'warn')));
    if (fixed.length) body.append(el('div', { className: 'pm-sub', textContent: `Fixed since the last check (${fixed.length}):` }), ...fixed.map((i) => row(i, 'fixed')));
    body.append(el('div', { className: 'pm-note', textContent: 'The check reads the wiring without running it: shorts, supplies wired backwards or together, too many volts, motors on GPIO pins, SDA/SCL mix-ups, parts with no power or ground, floating inputs, and problems inside imported KiCad boards. Running finds the rest (a program driving pins against each other, a stalled motor).' }));
    back.append(el('div', { className: 'modal pm-window' },
      el('div', { className: 'modal-head' },
        el('div', { className: 'modal-title', textContent: 'Circuit check' }),
        el('div', { className: 'modal-sub', textContent: faults.length ? `${faults.length} broken, ${warns.length} to look at` : warns.length ? `Nothing broken; ${warns.length} to look at` : 'All good' }),
        el('button', { className: 'modal-x', textContent: '×', onclick: close })),
      body,
      el('div', { className: 'lib-foot' }, el('span', { style: 'flex:1' }), el('button', { className: 'primary', textContent: 'Check again', onclick: () => this.open() }))));
    document.body.append(back);
  }
}
