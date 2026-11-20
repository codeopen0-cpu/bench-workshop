// Weight and balance: for each build on the bench (a part and everything glued onto it, with what its
// motors carry), its weight, where its centre of mass is (a marker, and a line down to the bench),
// what it stands on (the outline of its feet on the bench) and how far it can tilt before it tips
// over (the edge it would tip over is drawn red). Live while running: a walking robot's balance moves
// as it walks.
import * as THREE from 'three';
import type { Shape } from '../parts/types';
import type { Stage } from '../stage';
import type { PartView } from '../views';

export interface BalanceHost {
  stage: Stage;
  views(): Map<string, PartView>;
  hint(text: string): void;
}

export interface BalanceInfo {
  name: string;
  uids: string[];
  /** grams */
  mass: number;
  com: THREE.Vector3;
  /** its lowest point (cm above the bench) and whether it stands on the bench */
  bottom: number;
  standing: boolean;
  /** how far it can lean before it tips (degrees; 0 or less: it tips now), and over which edge */
  tipDeg: number | null;
  edge: [THREE.Vector3, THREE.Vector3] | null;
  feet: THREE.Vector3[];
}

/** Points on a shape's surface, in its body's frame: where it could touch the bench. */
function shapePoints(s: Shape, pos: THREE.Vector3, rot: THREE.Quaternion): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const add = (x: number, y: number, z: number) => out.push(new THREE.Vector3(x, y, z).applyQuaternion(rot).add(pos));
  if (s.kind === 'box') {
    for (const x of [-s.hx, s.hx]) for (const y of [-s.hy, s.hy]) for (const z of [-s.hz, s.hz]) add(x, y, z);
  } else if (s.kind === 'cylinder') {
    // (round: points round both rims, so a wheel touches at its bottom, not its box's corner)
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      add(Math.cos(a) * s.radius, -s.halfHeight, Math.sin(a) * s.radius);
      add(Math.cos(a) * s.radius, s.halfHeight, Math.sin(a) * s.radius);
    }
  } else if (s.kind === 'ball') {
    for (let i = 0; i < 12; i++)
      for (let j = 0; j <= 6; j++) {
        const a = (i / 12) * Math.PI * 2, b = (j / 6) * Math.PI;
        add(Math.cos(a) * Math.sin(b) * s.radius, Math.cos(b) * s.radius, Math.sin(a) * Math.sin(b) * s.radius);
      }
  } else {
    for (let i = 0; i + 2 < s.points.length; i += 3) add(s.points[i], s.points[i + 1], s.points[i + 2]);
  }
  return out;
}

/** 2D convex hull (x, z) of points, anticlockwise seen from above */
function hull2(pts: THREE.Vector3[]): THREE.Vector3[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cross = (o: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: THREE.Vector3[] = [], upper: THREE.Vector3[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Every build on the bench and its balance, as the parts are now (building or running). */
export function balanceOf(views: Map<string, PartView>): BalanceInfo[] {
  // builds: a part with nothing under it, and everything glued onto it (all the way up)
  const kids = new Map<string, string[]>();
  for (const v of views.values()) {
    const par = v.inst.parent?.uid;
    if (par && views.has(par)) {
      if (!kids.has(par)) kids.set(par, []);
      kids.get(par)!.push(v.inst.uid);
    }
  }
  const out: BalanceInfo[] = [];
  for (const v of views.values()) {
    if (v.inst.parent && views.has(v.inst.parent.uid)) continue;
    if (v.inst.pinned) continue; // (fixed to the bench: it can't tip)
    const uids: string[] = [];
    const todo = [v.inst.uid];
    while (todo.length) {
      const u = todo.pop()!;
      uids.push(u);
      todo.push(...(kids.get(u) ?? []));
    }
    if (uids.some((u) => views.get(u)!.inst.pinned)) continue;
    if (uids.length < 2) continue; // (a lone part: a ball, a block; nothing to balance)
    let mass = 0;
    const com = new THREE.Vector3();
    const pts: THREE.Vector3[] = [];
    const tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();
    for (const u of uids) {
      const pv = views.get(u)!;
      for (const b of pv.build.bodies) {
        const obj = pv.bodies.get(b.name);
        if (!obj) continue;
        obj.updateWorldMatrix(true, false);
        obj.matrixWorld.decompose(tmpP, tmpQ, tmpS);
        // its mass at the middle of its shapes
        const c = new THREE.Vector3();
        let vol = 0;
        for (const col of b.colliders) {
          const s = col.shape;
          const cv = s.kind === 'box' ? 8 * s.hx * s.hy * s.hz : s.kind === 'cylinder' ? Math.PI * s.radius ** 2 * 2 * s.halfHeight : s.kind === 'hull' ? Math.max(1e-4, s.volume) : (4 / 3) * Math.PI * s.radius ** 3;
          c.addScaledVector(new THREE.Vector3(...(col.pos ?? [0, 0, 0])), cv);
          vol += cv;
          for (const p of shapePoints(s, new THREE.Vector3(...(col.pos ?? [0, 0, 0])), new THREE.Quaternion(...(col.rot ?? [0, 0, 0, 1])))) pts.push(p.applyMatrix4(obj.matrixWorld));
        }
        if (vol > 0) c.multiplyScalar(1 / vol);
        com.addScaledVector(c.applyMatrix4(obj.matrixWorld), b.mass);
        mass += b.mass;
      }
    }
    if (mass <= 0 || !pts.length) continue;
    com.multiplyScalar(1 / mass);
    const bottom = Math.min(...pts.map((p) => p.y));
    // what it stands on: its points within 3 mm of its lowest, if that's on the bench
    const standing = bottom < 0.6;
    const feet = standing ? hull2(pts.filter((p) => p.y < bottom + 0.3)) : [];
    let tipDeg: number | null = null, edge: BalanceInfo['edge'] = null;
    if (feet.length >= 3) {
      const h = Math.max(0.01, com.y - bottom);
      let best = Infinity;
      for (let i = 0; i < feet.length; i++) {
        const a = feet[i], b = feet[(i + 1) % feet.length];
        const ex = b.x - a.x, ez = b.z - a.z;
        const len = Math.hypot(ex, ez) || 1;
        // (inside is to the left of each edge, the hull going anticlockwise)
        const d = (ex * (com.z - a.z) - ez * (com.x - a.x)) / len;
        const deg = (Math.atan2(d, h) * 180) / Math.PI;
        if (deg < best) { best = deg; edge = [a, b]; }
      }
      tipDeg = best;
    } else if (feet.length) tipDeg = 0; // (on a line or a point: it can't stand on its own)
    out.push({ name: v.inst.name, uids, mass, com, bottom, standing, tipDeg, edge, feet });
  }
  return out;
}

/** Draws each build's balance on the bench while it's switched on. */
export class BalanceView {
  on = false;
  private group = new THREE.Group();
  private labels: HTMLDivElement[] = [];
  private last = 0;
  private told = new Map<string, number>();

  constructor(private host: BalanceHost) {
    this.group.renderOrder = 25;
    host.stage.overlay.add(this.group);
  }

  toggle() {
    this.on = !this.on;
    if (!this.on) this.clear();
    console.info(`[balance] ${this.on ? 'on' : 'off'}`);
    if (this.on) this.host.hint('Balance: the dot is each build\'s centre of mass, the outline what it stands on; the red edge is the one it would tip over first');
    return this.on;
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as any).geometry?.dispose?.();
    }
    for (const l of this.labels) l.remove();
    this.labels = [];
  }

  /** each frame (it redraws about 10 times a second) */
  update() {
    if (!this.on) return;
    const now = performance.now();
    if (now - this.last < 100) { this.place(); return; }
    this.last = now;
    this.clear();
    const list = balanceOf(this.host.views());
    const mat = (color: number) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
    for (const b of list) {
      // the centre of mass: a black and yellow ball, and a line down to the bench
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), new THREE.MeshBasicMaterial({ color: 0xf2c94c, depthTest: false }));
      ball.position.copy(b.com);
      ball.renderOrder = 26;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 6, 24), new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false }));
      ring.position.copy(b.com);
      ring.lookAt(this.host.stage.camera.position);
      ring.renderOrder = 27;
      const ground = b.standing ? b.bottom + 0.03 : 0.03;
      const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([b.com, new THREE.Vector3(b.com.x, ground, b.com.z)]), new THREE.LineDashedMaterial({ color: 0xf2c94c, dashSize: 0.3, gapSize: 0.2, depthTest: false }));
      drop.computeLineDistances();
      drop.renderOrder = 25;
      this.group.add(ball, ring, drop);
      if (b.feet.length >= 2) {
        const loop = [...b.feet, b.feet[0]].map((p) => new THREE.Vector3(p.x, b.bottom + 0.03, p.z));
        const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop), mat(0x3fb27f));
        outline.renderOrder = 25;
        this.group.add(outline);
      }
      if (b.edge) {
        const [p, q] = b.edge;
        const e = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x, b.bottom + 0.05, p.z), new THREE.Vector3(q.x, b.bottom + 0.05, q.z)]), mat(0xe5534b));
        e.renderOrder = 26;
        this.group.add(e);
      }
      const label = document.createElement('div');
      label.className = 'instrument-label balance-label';
      const kg = b.mass >= 1000 ? `${(b.mass / 1000).toFixed(2)} kg` : `${b.mass.toFixed(0)} g`;
      const tip = !b.standing ? 'off the bench' : b.tipDeg === null ? '' : b.tipDeg <= 0.5 ? 'tips over: its middle is past its feet' : `tips past ${b.tipDeg.toFixed(0)}° of lean`;
      label.textContent = `${b.name}: ${kg}${b.uids.length > 1 ? ` (${b.uids.length} parts)` : ''}\nmiddle ${(b.com.y - (b.standing ? b.bottom : 0)).toFixed(1)} cm up${tip ? `\n${tip}` : ''}`;
      (label as any).at = b.com.clone();
      document.body.append(label);
      this.labels.push(label);
      // (the log hears when a build's balance gets risky; once a second at most)
      const key = b.uids[0];
      if (b.standing && b.tipDeg !== null && b.tipDeg < 8 && b.uids.length > 1 && now - (this.told.get(key) ?? 0) > 5000) {
        this.told.set(key, now);
        console.info(`[balance] ${b.name}: ${kg}, middle ${(b.com.y - b.bottom).toFixed(1)} cm up, tips at ${b.tipDeg.toFixed(1)} deg`);
      }
    }
    this.place();
  }

  /** the labels next to their centres of mass on screen */
  private place() {
    const cam = this.host.stage.camera, r = this.host.stage.renderer.domElement.getBoundingClientRect();
    for (const l of this.labels) {
      const v = ((l as any).at as THREE.Vector3).clone().project(cam);
      l.hidden = v.z > 1;
      l.style.left = `${r.left + ((v.x + 1) / 2) * r.width + 14}px`;
      l.style.top = `${r.top + ((1 - v.y) / 2) * r.height - 10}px`;
    }
  }
}
