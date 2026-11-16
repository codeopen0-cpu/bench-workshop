// Pins (small markers on parts) and wires (sagging cables between pins), drawn in 3D. Markers ride
// on their part's body, so they move with it; wires are redrawn whenever their ends move.
import * as THREE from 'three';
import type { PinDef, PinKind } from './parts/types';
import type { PinRef, Wire } from './project';
import type { PartView } from './views';

export const PIN_COLORS: Record<PinKind, number> = {
  gnd: 0x3a3d44, vin: 0xe04848, vout: 0xff7a45, io: 0x4f9cff, in: 0x7fd1ff, out: 0x7fe0a8, motor: 0xe8c547, i2c: 0xc77dff, port: 0xb0b6c2,
};
export const WIRE_COLORS = ['#e04848', '#2b2d33', '#e8c547', '#4f9cff', '#3fbf7f', '#ff9d3a', '#f2f2f2', '#b46bff'];

export function pinDef(v: PartView, pin: string): PinDef | undefined {
  return v.build.pins?.find((p) => p.id === pin);
}

export function pinWorld(views: Map<string, PartView>, ref: PinRef, out = new THREE.Vector3()): THREE.Vector3 | null {
  const v = views.get(ref.uid);
  const d = v && pinDef(v, ref.pin);
  if (!v || !d) return null;
  const body = v.bodies.get(d.body)!;
  body.updateWorldMatrix(true, false);
  return out.set(...d.pos).applyMatrix4(body.matrixWorld);
}

/** Pin markers on every part (one small sphere per pin), for picking pins while wiring. */
export function addPinMarkers(v: PartView, highlightKinds?: Set<PinKind>) {
  removePinMarkers(v);
  for (const d of v.build.pins ?? []) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 12, 8),
      new THREE.MeshBasicMaterial({ color: PIN_COLORS[d.kind], transparent: !!highlightKinds && !highlightKinds.has(d.kind), opacity: 0.35 }),
    );
    m.position.set(...d.pos);
    m.userData = { pinMarker: true, uid: v.inst.uid, pin: d.id, ghost: false };
    m.renderOrder = 10;
    v.bodies.get(d.body)!.add(m);
  }
}
export function removePinMarkers(v: PartView) {
  for (const b of v.bodies.values())
    for (const c of [...b.children])
      if (c.userData.pinMarker) {
        (c as THREE.Mesh).geometry.dispose();
        ((c as THREE.Mesh).material as THREE.Material).dispose();
        c.removeFromParent();
      }
}

/** The 3D cables. Call update() every frame; it only rebuilds a cable whose ends moved. */
export class WireLayer {
  group = new THREE.Group();
  private items = new Map<string, { mesh: THREE.Mesh; a: THREE.Vector3; b: THREE.Vector3; color: string; len: number }>();

  sync(wires: Wire[], views: Map<string, PartView>, selected: string | null) {
    const keep = new Set(wires.map((w) => w.id));
    for (const [id, it] of this.items)
      if (!keep.has(id)) {
        it.mesh.geometry.dispose();
        (it.mesh.material as THREE.Material).dispose();
        it.mesh.removeFromParent();
        this.items.delete(id);
      }
    const pa = new THREE.Vector3(), pb = new THREE.Vector3();
    for (const w of wires) {
      if (!pinWorld(views, w.a, pa) || !pinWorld(views, w.b, pb)) continue;
      let it = this.items.get(w.id);
      if (!it) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.5 }));
        mesh.userData = { wireId: w.id };
        mesh.castShadow = true;
        this.group.add(mesh);
        it = { mesh, a: new THREE.Vector3(Infinity, 0, 0), b: new THREE.Vector3(), color: w.color, len: -1 };
        this.items.set(w.id, it);
      }
      const mat = it.mesh.material as THREE.MeshStandardMaterial;
      if (it.color !== w.color) {
        mat.color.set(w.color);
        it.color = w.color;
      }
      mat.emissive.set(w.id === selected ? 0x4f9cff : 0x000000);
      mat.emissiveIntensity = w.id === selected ? 0.6 : 0;
      const len = w.length ?? 0;
      if (it.a.distanceToSquared(pa) < 1e-6 && it.b.distanceToSquared(pb) < 1e-6 && it.len === len) continue;
      it.a.copy(pa);
      it.b.copy(pb);
      it.len = len;
      it.mesh.geometry.dispose();
      it.mesh.geometry = cableGeometry(pa, pb, len);
    }
  }
}

/** A cable of the given length hanging between its pins: tight = straight, slack = it sags (a parabola
 *  whose arc length is about the cable's), never through the bench top. */
function cableGeometry(a: THREE.Vector3, b: THREE.Vector3, length: number) {
  const d = a.distanceTo(b);
  const L = Math.max(length || d * 1.15 + 1.5, d);
  const sag = d > 0.01 ? Math.min(L / 2, Math.sqrt((3 * d * (L - d)) / 8)) : L / 2;
  const lift = Math.min(0.5, L * 0.08); // straight up out of the pin first
  const up = new THREE.Vector3(0, lift, 0);
  const pts: THREE.Vector3[] = [a.clone()];
  if (L - d > 0.3) pts.push(a.clone().add(up));
  const n = 7;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t);
    p.y = Math.max(p.y, 0.07); // lies on the bench rather than through it
    pts.push(p);
  }
  if (L - d > 0.3) pts.push(b.clone().add(up));
  pts.push(b.clone());
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, Math.max(16, Math.min(160, Math.round(L * 2))), 0.06, 6, false);
}
