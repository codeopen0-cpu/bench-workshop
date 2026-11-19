// A real game pad (or the keyboard) playing the PS2 controller library's pad while it runs: each frame
// its buttons press the receiver's run-panel buttons, and its sticks move the stick sliders.
// Keyboard: arrows = D-pad, 1 2 3 4 = triangle circle cross square, Q / E = L1 / R1, Z / C = L2 / R2,
// Enter = Start, Backspace = Select, I J K L = the left stick.
import type { Device } from '../elec/circuit';

/** a standard-mapping game pad's buttons, as the PS2 pad's */
const PAD: Record<number, string> = { 0: 'Cross', 1: 'Circle', 2: 'Square', 3: 'Triangle', 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2', 8: 'Select', 9: 'Start', 10: 'L3', 11: 'R3', 12: 'Up', 13: 'Down', 14: 'Left', 15: 'Right' };
const KEYS: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '1': 'Triangle', '2': 'Circle', '3': 'Cross', '4': 'Square', q: 'L1', e: 'R1', z: 'L2', c: 'R2', Enter: 'Start', Backspace: 'Select' };

export class PadInput {
  private held = new Set<string>();
  /** what each receiver's buttons were last frame (so a press is sent once) */
  private last = new WeakMap<Device, Map<string, boolean>>();
  private told = false;
  private keyStickWas = false;
  /** the keyboard drives a pad only while one is running (the app says so) */
  active = false;
  /** a key the pad takes while one runs (the app's own shortcuts leave it alone then) */
  claims(key: string) { const k = key.length === 1 ? key.toLowerCase() : key; return this.active && (!!KEYS[k] || 'ijkl'.includes(k)); }

  constructor() {
    const typing = () => { const t = document.activeElement?.tagName; return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT'; };
    window.addEventListener('keydown', (e) => {
      if (!this.active || typing()) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (KEYS[k] || 'ijkl'.includes(k)) { this.held.add(k); if (k.startsWith('Arrow') || k === 'Backspace') e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
    window.addEventListener('blur', () => this.held.clear());
  }

  /** Each frame while running: the receivers' controls from the pad and the keyboard. */
  update(devices: Device[]) {
    const receivers = devices.filter((d) => d.view.inst.type.endsWith('/ps2-receiver') && d.controls);
    this.active = receivers.length > 0;
    if (!receivers.length) return;
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) as Gamepad[] : [];
    const pad = pads[0];
    if (pad && !this.told) { this.told = true; console.info(`[pad] game pad found: ${pad.id} (${pad.mapping || 'no standard mapping'}): it plays the PS2 controller`); }
    const down = new Set<string>();
    if (pad) pad.buttons.forEach((b, i) => { if (b.pressed && PAD[i]) down.add(PAD[i]); });
    for (const k of this.held) if (KEYS[k]) down.add(KEYS[k]);
    // sticks: the pad's (0..255, 128 in the middle; up is 0), else I J K L for the left one
    const ax = (i: number) => (pad && pad.axes.length > i && Math.abs(pad.axes[i]) > 0.06 ? pad.axes[i] : 0);
    const kb = (neg: string, pos: string) => (this.held.has(pos) ? 1 : 0) - (this.held.has(neg) ? 1 : 0);
    const stick = { lx: ax(0) || kb('j', 'l'), ly: ax(1) || kb('i', 'k'), rx: ax(2), ry: ax(3) };
    const keyStick = [...this.held].some((k) => 'ijkl'.includes(k));
    // (the sticks follow the pad, or I J K L; let go of those and they spring back to the middle once)
    const usingSticks = !!pad || keyStick || this.keyStickWas;
    this.keyStickWas = keyStick;
    for (const d of receivers) {
      const prev = this.last.get(d) ?? new Map<string, boolean>();
      this.last.set(d, prev);
      for (const c of d.controls!()) {
        const label = (c as any).label as string;
        if ((c as any).press && label in { Up: 1, Down: 1, Left: 1, Right: 1, Triangle: 1, Circle: 1, Cross: 1, Square: 1, L1: 1, R1: 1, L2: 1, R2: 1, Start: 1, Select: 1, L3: 1, R3: 1 }) {
          const now = down.has(label);
          if ((prev.get(label) ?? false) !== now) { (c as any).press(now); prev.set(label, now); }
        } else if ((c as any).set && usingSticks) {
          const axis = /Left stick left/.test(label) ? stick.lx : /Left stick up/.test(label) ? stick.ly : /Right stick left/.test(label) ? stick.rx : /Right stick up/.test(label) ? stick.ry : null;
          if (axis !== null) (c as any).set(Math.round(128 + axis * 127));
        }
      }
    }
  }
}
