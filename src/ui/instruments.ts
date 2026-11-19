// Measuring tools: a ruler (click two points: the distance between them) and a multimeter (click a pin:
// its voltage; a second pin: the voltage between them, live while running, with PWM and the current a
// part draws when its supply pins are probed).
import * as THREE from 'three';
import type { Circuit } from '../elec/circuit';
import type { PinRef } from '../project';
import type { Stage } from '../stage';

export interface InstrumentHost {
  stage: Stage;
  pinAt(ev: PointerEvent): PinRef | null;
  pinWorld(ref: PinRef, out: THREE.Vector3): boolean;
  circuit(): Circuit | null;
  pinLabel(ref: PinRef): string;
  hint(text: string): void;
  /** the parts (and the bench) a point can be picked on */
  pickRoots(): THREE.Object3D[];
}

const mark = (color: number) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.renderOrder = 20;
  m.visible = false;
  return m;
};

export class Instruments {
  mode: 'ruler' | 'meter' | null = null;
  private group = new THREE.Group();
  private a = mark(0x3fa9ff);
  private b = mark(0x3fa9ff);
  private line: THREE.Line;
  private label: HTMLDivElement;
  private pa: THREE.Vector3 | null = null;
  private pb: THREE.Vector3 | null = null;
  /** multimeter probes: red and black, on pins */
  private red: PinRef | null = null;
  private black: PinRef | null = null;
  onChange: () => void = () => {};

  constructor(private host: InstrumentHost) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0x3fa9ff, dashSize: 0.4, gapSize: 0.25, depthTest: false }));
    this.line.renderOrder = 20;
    this.line.visible = false;
    this.group.add(this.a, this.b, this.line);
    host.stage.overlay.add(this.group);
    this.label = document.createElement('div');
    this.label.className = 'instrument-label';
    this.label.hidden = true;
    document.body.append(this.label);
  }

  setMode(m: Instruments['mode']) {
    this.mode = this.mode === m ? null : m;
    this.clear();
    console.info(`[instruments] ${this.mode ?? 'off'}`);
    this.onChange();
    this.hintNow();
  }
  private clear() {
    this.pa = this.pb = null;
    this.red = this.black = null;
    this.a.visible = this.b.visible = this.line.visible = false;
    this.label.hidden = true;
  }
  hintNow() {
    if (this.mode === 'ruler') this.host.hint(this.pa && !this.pb ? 'Ruler: click the second point  ·  M or Esc: put it away' : 'Ruler: click a point on a part or the bench, then another  ·  M or Esc: put it away');
    else if (this.mode === 'meter') this.host.hint(this.red && !this.black ? 'Multimeter: the red probe is on; click another pin for the black one (or read it against ground)  ·  V or Esc: put it away' : 'Multimeter: click a pin for the red probe (its volts to ground), then another for the black one  ·  V or Esc: put it away');
  }

  /** a click while a tool is out: true if it took it */
  click(ev: PointerEvent): boolean {
    if (!this.mode) return false;
    if (this.mode === 'ruler') {
      const hit = this.host.stage.pick(ev, this.host.pickRoots(), true);
      if (!hit) return true;
      const p = hit.point.clone();
      if (!this.pa || this.pb) { this.pa = p; this.pb = null; }
      else this.pb = p;
    } else {
      const pin = this.host.pinAt(ev);
      if (!pin) return true;
      if (!this.red || this.black) { this.red = pin; this.black = null; }
      else this.black = pin;
    }
    this.hintNow();
    this.update();
    return true;
  }

  /** each frame: the markers, the line and the reading where they are now */
  update() {
    if (!this.mode) return;
    const tmp = new THREE.Vector3();
    let p1: THREE.Vector3 | null = null, p2: THREE.Vector3 | null = null;
    let text = '';
    if (this.mode === 'ruler') {
      p1 = this.pa; p2 = this.pb;
      if (p1 && p2) {
        const d = p2.clone().sub(p1);
        text = `${d.length().toFixed(2)} cm\nacross ${Math.abs(d.x).toFixed(2)}  up ${Math.abs(d.y).toFixed(2)}  deep ${Math.abs(d.z).toFixed(2)}`;
      } else if (p1) text = 'click the second point';
    } else {
      if (this.red && this.host.pinWorld(this.red, tmp)) p1 = tmp.clone();
      if (this.black && this.host.pinWorld(this.black, tmp)) p2 = tmp.clone();
      text = this.reading();
    }
    this.a.visible = !!p1;
    this.b.visible = !!p2;
    (this.a.material as THREE.MeshBasicMaterial).color.set(this.mode === 'meter' ? 0xff3b30 : 0x3fa9ff);
    (this.b.material as THREE.MeshBasicMaterial).color.set(this.mode === 'meter' ? 0x222222 : 0x3fa9ff);
    if (p1) this.a.position.copy(p1);
    if (p2) this.b.position.copy(p2);
    this.line.visible = !!(p1 && p2);
    if (p1 && p2) {
      this.line.geometry.setFromPoints([p1, p2]);
      this.line.computeLineDistances();
    }
    // the reading, next to the middle of what's measured
    const at = p1 && p2 ? p1.clone().add(p2).multiplyScalar(0.5) : p1;
    if (!at || !text) { this.label.hidden = true; return; }
    const v = at.clone().project(this.host.stage.camera);
    const r = this.host.stage.renderer.domElement.getBoundingClientRect();
    this.label.hidden = v.z > 1;
    this.label.style.left = `${r.left + ((v.x + 1) / 2) * r.width + 14}px`;
    this.label.style.top = `${r.top + ((1 - v.y) / 2) * r.height - 10}px`;
    this.label.textContent = text;
  }

  /** the multimeter's reading now */
  private reading() {
    const c = this.host.circuit();
    if (!this.red) return '';
    const name = (p: PinRef) => this.host.pinLabel(p);
    if (!c) return `${name(this.red)}${this.black ? ` to ${name(this.black)}` : ''}\n(press Run to measure)`;
    const vr = c.avg(this.red.uid, this.red.pin);
    const vb = this.black ? c.avg(this.black.uid, this.black.pin) : 0;
    const lines: string[] = [];
    if (vr === null || (this.black && vb === null)) lines.push('nothing there (floating)');
    else lines.push(`${((vr ?? 0) - (vb ?? 0)).toFixed(3)} V`);
    const pwm = c.net(this.red.uid, this.red.pin)?.pwm;
    if (pwm) lines.push(`PWM ${Math.round(pwm.hz)} Hz, ${(pwm.duty * 100).toFixed(1)} % on`);
    // the current a part draws, when both probes are on its own pins (its supply)
    if (this.black && this.black.uid === this.red.uid) {
      const d = c.devices.find((x) => x.view.inst.uid === this.red!.uid);
      if (d?.current) lines.push(`it draws ${(d.current() * 1000).toFixed(1)} mA`);
    }
    return `${name(this.red)}${this.black ? ` to ${name(this.black)}` : ' to ground'}\n${lines.join('\n')}`;
  }

  dispose() {
    this.label.remove();
    this.group.removeFromParent();
  }
}
