// Mechanics that the physics engine has no part for, done each step by the simulation (sim.ts):
// - gears that mesh: whenever two gears' teeth reach each other (axles parallel, pitch circles
//   touching, side by side), they turn together, opposite ways, by their tooth counts;
// - belts between pulleys: the same way, by their sizes (so does the chain of a tank track's wheels);
// - mecanum and omni wheels: their rollers grip only one way and slide freely the other.
// Couplings are velocity constraints solved with impulses before and after each step; after it, the
// two are also turned (each about its own axle) back to exactly the ratio, since friction and motors
// inside the engine's step act on each alone (a 1:3 gear train stays exactly 1:3 over minutes).
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { kickAt, kickTwist } from './kicks';
import type { MechDef } from './parts/types';
import type { PartView } from './views';

type RB = RAPIER_NS.RigidBody;
export interface MechItem {
  def: MechDef;
  view: PartView;
  rb: RB;
  /** centre and axle in the rigid body's frame */
  local: THREE.Vector3;
  axisL: THREE.Vector3;
  colliders: RAPIER_NS.Collider[];
  /** grip of a roller wheel (its rollers' rubber) */
  grip: number;
  /** (wheels with their own grip) the share of the whole machine's mass each of its gripping wheels
   *  pushes: a light wheel on a heavy robot moves the robot, through its axle */
  share?: number;
  /** what its axle is held by (a motor's case, a track's frame): the grip pushes that */
  carrier?: RB;
  /** how far it has turned about its axle since the start (rad), and its rotation last step */
  theta?: number;
  qPrev?: THREE.Quaternion;
}
interface Coupling {
  a: MechItem;
  b: MechItem;
  kind: 'gear' | 'belt' | 'chain';
  /** where the two were (rA * thetaA + s * rB * thetaB) when they started turning together: kept so */
  err: number;
  on: boolean;
  told: boolean;
}

const tmpQ = new THREE.Quaternion();
const v3 = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);

/** n . I^-1 . n for a body's inertia, in world terms (0 for a body that can't turn). */
function invInertia(rb: RB, n: THREE.Vector3) {
  if (!rb.isDynamic()) return 0;
  const r = rb.rotation(), f = rb.principalInertiaLocalFrame(), pi = rb.principalInertia();
  tmpQ.set(r.x, r.y, r.z, r.w).multiply(new THREE.Quaternion(f.x, f.y, f.z, f.w)).invert();
  const l = n.clone().applyQuaternion(tmpQ);
  return (pi.x > 0 ? (l.x * l.x) / pi.x : 0) + (pi.y > 0 ? (l.y * l.y) / pi.y : 0) + (pi.z > 0 ? (l.z * l.z) / pi.z : 0);
}

export class Mechanics {
  /** how much of a slip the grip takes out in one step (1 = all of it; less is steadier, as the
   *  machine's other wheels push at the same time) */
  static gripGain = 0.15; // (tuned 2026-11-16: a tank spins on the spot, ~100 deg/s, and drives straight)
  items: MechItem[] = [];
  private couplings: Coupling[] = [];
  /** for the run panel / tests: what meshes with what now */
  meshes: string[] = [];

  constructor(private world: RAPIER_NS.World, private log: (msg: string, level?: 'info' | 'warn' | 'bad') => void) {}

  add(item: MechItem) {
    this.items.push(item);
  }
  /** After all items are in: gear pairs (checked each step), chains, and the project's belts. */
  link(belts: { a: string; b: string }[]) {
    const gears = this.items.filter((m) => m.def.kind === 'gear');
    for (let i = 0; i < gears.length; i++)
      for (let j = i + 1; j < gears.length; j++)
        if (gears[i].rb !== gears[j].rb && (gears[i].rb.isDynamic() || gears[j].rb.isDynamic()))
          this.couplings.push({ a: gears[i], b: gears[j], kind: 'gear', err: 0, on: false, told: false });
    // a part's chain: every wheel turns with the first
    const chains = new Map<string, MechItem[]>();
    for (const m of this.items) if (m.def.kind === 'chain') {
      const k = `${m.view.inst.uid}/${m.def.group ?? 0}`;
      if (!chains.has(k)) chains.set(k, []);
      chains.get(k)!.push(m);
    }
    for (const list of chains.values()) for (const m of list.slice(1)) if (m.rb !== list[0].rb) this.couplings.push({ a: list[0], b: m, kind: 'chain', err: 0, on: true, told: true });
    for (const bt of belts) {
      const pa = this.items.find((m) => m.view.inst.uid === bt.a && (m.def.kind === 'pulley' || m.def.kind === 'gear'));
      const pb = this.items.find((m) => m.view.inst.uid === bt.b && (m.def.kind === 'pulley' || m.def.kind === 'gear'));
      if (!pa || !pb) continue;
      if (pa.rb === pb.rb) {
        this.log(`a belt joins ${pa.view.inst.name} and ${pb.view.inst.name}, which are glued together: it does nothing`, 'warn');
        continue;
      }
      this.couplings.push({ a: pa, b: pb, kind: 'belt', err: 0, on: true, told: false });
    }
    // gripping wheels: the machine each is part of (bodies joined by axles and hinges), its mass
    // shared among its gripping wheels
    const grippers = this.items.filter((m) => m.def.kind === 'mecanum' || m.def.kind === 'omni' || m.def.kind === 'chain');
    const islandOf = (rb: RB) => {
      const seen = new Set<number>([rb.handle]);
      const todo = [rb];
      while (todo.length) {
        const b = todo.pop()!;
        this.world.impulseJoints.forEachJointHandleAttachedToRigidBody(b.handle, (h) => {
          const j = this.world.impulseJoints.get(h);
          if (!j) return;
          for (const o of [j.body1(), j.body2()]) if (o.isDynamic() && !seen.has(o.handle)) { seen.add(o.handle); todo.push(o); }
        });
      }
      return seen;
    };
    for (const m of grippers) {
      const island = islandOf(m.rb);
      let mass = 0;
      for (const h of island) mass += this.world.getRigidBody(h)?.mass() ?? 0;
      const wheels = grippers.filter((o) => island.has(o.rb.handle)).length || 1;
      m.share = mass / wheels;
      this.world.impulseJoints.forEachJointHandleAttachedToRigidBody(m.rb.handle, (h) => {
        const j = this.world.impulseJoints.get(h);
        if (!j || m.carrier) return;
        const o = j.body1().handle === m.rb.handle ? j.body2() : j.body1();
        if (o.isDynamic()) m.carrier = o;
      });
    }
    const n = this.couplings.filter((c) => c.kind !== 'gear').length;
    console.info(`[mech] ${this.items.length} mechanical parts: ${gears.length} gears (${this.couplings.filter((c) => c.kind === 'gear').length} pairs watched), ${n} belts and chain links, ${this.items.filter((m) => m.def.kind === 'mecanum' || m.def.kind === 'omni').length} roller wheels`);
  }

  /** where an item's centre and axle are now */
  private pose(m: MechItem) {
    const t = m.rb.translation(), r = m.rb.rotation();
    tmpQ.set(r.x, r.y, r.z, r.w);
    return { c: m.local.clone().applyQuaternion(tmpQ).add(v3(t)), n: m.axisL.clone().applyQuaternion(tmpQ).normalize() };
  }

  /** Two gears mesh when their axles are parallel, they're side by side, and their pitch circles touch
   *  (within about a tooth's depth). */
  private meshNow(c: Coupling, pa: { c: THREE.Vector3; n: THREE.Vector3 }, pb: { c: THREE.Vector3; n: THREE.Vector3 }) {
    if (Math.abs(pa.n.dot(pb.n)) < 0.97) return false;
    const d = pb.c.clone().sub(pa.c);
    const along = d.dot(pa.n);
    const perp = d.addScaledVector(pa.n, -along).length();
    const ra = c.a.def.radius, rb = c.b.def.radius;
    const mod = Math.max((2 * ra) / (c.a.def.teeth ?? 20), (2 * rb) / (c.b.def.teeth ?? 20));
    const tol = Math.max(0.15, 1.25 * mod);
    const side = ((c.a.def.width ?? 0.5) + (c.b.def.width ?? 0.5)) / 2 + 0.1;
    return Math.abs(perp - (ra + rb)) <= tol && Math.abs(along) <= side;
  }

  /** the surface speed mismatch of a coupling (cm/s), and its parts */
  private terms(c: Coupling) {
    const pa = this.pose(c.a), pb = this.pose(c.b);
    // (axles lined up the same way; a belt between crossed axles just uses each its own)
    const nb = pa.n.dot(pb.n) < 0 ? pb.n.clone().negate() : pb.n.clone();
    const s = c.kind === 'gear' ? 1 : -1; // gears: opposite ways; belts and chains: the same way
    const wa = v3(c.a.rb.angvel()), wb = v3(c.b.rb.angvel());
    const ra = c.a.def.radius, rb = c.b.def.radius;
    const cdot = ra * wa.dot(pa.n) + s * rb * wb.dot(nb);
    return { pa, pb, nb, s, ra, rb, cdot };
  }

  /** Before the step: couplings hold their ratio; roller wheels grip their one way. */
  before(dt: number) {
    for (const c of this.couplings) {
      if (c.kind === 'gear') {
        const was = c.on;
        c.on = this.meshNow(c, this.pose(c.a), this.pose(c.b));
        if (c.on && !was) c.err = this.where(c);
        if (c.on && !was && !c.told) {
          c.told = true;
          const ta = c.a.def.teeth ?? 0, tb = c.b.def.teeth ?? 0;
          this.log(`${c.a.view.inst.name} meshes with ${c.b.view.inst.name} (${ta}:${tb} teeth: ${c.b.view.inst.name} turns ${(ta / tb).toFixed(2)}x as fast, the other way)`);
        }
      }
      if (c.on) this.matchSpeeds(c);
    }
    for (const m of this.items) if (m.def.kind === 'mecanum' || m.def.kind === 'omni' || m.def.kind === 'chain') this.rollers(m);
    this.meshes = this.couplings.filter((c) => c.on && c.kind === 'gear').map((c) => `${c.a.view.inst.name} + ${c.b.view.inst.name}`);
  }
  /** Turning speeds back to the ratio (impulses on both, by their inertia). */
  private matchSpeeds(c: Coupling) {
    for (let it = 0; it < 2; it++) {
      const t = this.terms(c);
      const k = t.ra * t.ra * invInertia(c.a.rb, t.pa.n) + t.rb * t.rb * invInertia(c.b.rb, t.nb);
      if (k <= 0) return;
      const lambda = -t.cdot / k;
      const ia = t.pa.n.clone().multiplyScalar(lambda * t.ra), ib = t.nb.clone().multiplyScalar(lambda * t.s * t.rb);
      if (c.a.rb.isDynamic()) kickTwist(c.a.rb, { x: ia.x, y: ia.y, z: ia.z }, this.pose(c.a).c);
      if (c.b.rb.isDynamic()) kickTwist(c.b.rb, { x: ib.x, y: ib.y, z: ib.z }, this.pose(c.b).c);
    }
  }
  /** rA * thetaA + s * rB * thetaB: the surface distance the pair has turned through (constant when
   *  they turn exactly together) */
  private where(c: Coupling) {
    const pa = this.pose(c.a), pb = this.pose(c.b);
    const flip = pa.n.dot(pb.n) < 0 ? -1 : 1;
    const s = c.kind === 'gear' ? 1 : -1;
    return c.a.def.radius * (c.a.theta ?? 0) + s * flip * c.b.def.radius * (c.b.theta ?? 0);
  }
  /** Each item's angle about its axle: what it turned this step, added up. */
  private measure(m: MechItem) {
    const r = m.rb.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    if (!m.qPrev) {
      m.qPrev = q;
      m.theta = 0;
      return;
    }
    const dq = q.clone().multiply(m.qPrev.clone().invert());
    const n = this.pose(m).n;
    const sinHalf = new THREE.Vector3(dq.x, dq.y, dq.z).dot(n);
    m.theta = (m.theta ?? 0) + 2 * Math.atan2(sinHalf, dq.w);
    m.qPrev = q;
  }
  /** Turn a body about its own axle (through `c`, along `n`) by `a` rad: its joint doesn't mind. */
  private turn(m: MechItem, c: THREE.Vector3, n: THREE.Vector3, a: number) {
    if (!m.rb.isDynamic() || Math.abs(a) < 1e-9) return;
    const rq = new THREE.Quaternion().setFromAxisAngle(n, a);
    const r = m.rb.rotation(), t = m.rb.translation();
    const q = rq.clone().multiply(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const p = v3(t).sub(c).applyQuaternion(rq).add(c);
    m.rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    m.rb.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    m.theta = (m.theta ?? 0) + a;
    m.qPrev = q;
  }
  /** After the step: speeds back to the ratio, and the pair turned back to exactly where the ratio
   *  says (shared by their inertia: the light one gives way). */
  after(_dt: number) {
    for (const m of this.items) if (m.def.kind !== 'mecanum' && m.def.kind !== 'omni') this.measure(m);
    for (const c of this.couplings) {
      if (!c.on) continue;
      this.matchSpeeds(c);
      const e = this.where(c) - c.err;
      if (Math.abs(e) < 1e-6) continue;
      const pa = this.pose(c.a), pb = this.pose(c.b);
      const flip = pa.n.dot(pb.n) < 0 ? -1 : 1;
      const s = (c.kind === 'gear' ? 1 : -1) * flip;
      const ia = invInertia(c.a.rb, pa.n), ib = invInertia(c.b.rb, pb.n);
      const ra = c.a.def.radius, rb = c.b.def.radius;
      const k = ra * ra * ia + rb * rb * ib;
      if (k <= 0) continue;
      this.turn(c.a, pa.c, pa.n, (-e * ra * ia) / k);
      this.turn(c.b, pb.c, pb.n, (-e * s * rb * ib) / k);
    }
  }

  /** Wheels with their own kind of grip: rollers (friction only along their axis: mecanum 45 degrees
   *  across, omni the way it rolls; the other way they slide), and a track's wheels (along the track,
   *  and less sideways). */
  private rollers(m: MechItem) {
    const { c: centre, n: axle } = this.pose(m);
    const rb = m.rb;
    const com = v3(rb.worldCom());
    for (const col of m.colliders) {
      this.world.contactPairsWith(col, (other) => {
        this.world.contactPair(col, other, (man, flipped) => {
          let normalImpulse = 0;
          for (let i = 0; i < man.numContacts(); i++) normalImpulse += man.contactImpulse(i);
          if (normalImpulse <= 0) return;
          const nm = man.normal();
          // the way from the wheel to what it touches
          const out = v3(nm).multiplyScalar(flipped ? -1 : 1).normalize();
          const p = centre.clone().addScaledVector(out.clone().addScaledVector(axle, -out.dot(axle)).normalize(), m.def.radius);
          const roll = axle.clone().cross(out).normalize(); // the way it rolls
          if (roll.lengthSq() < 0.5) return;
          const axleFlat = axle.clone().addScaledVector(out, -axle.dot(out)).normalize();
          // the ways it grips, and how hard: rollers one way only; a track along itself, and a bit
          // less sideways (rubber track pads scrub sideways on a hard floor: that's how a tank turns)
          const dirs: { d: THREE.Vector3; mu: number }[] =
            m.def.kind === 'omni' ? [{ d: roll, mu: m.grip }]
            : m.def.kind === 'mecanum' ? [{ d: roll.clone().addScaledVector(axleFlat, m.def.group ?? 1).normalize(), mu: m.grip }]
            : [{ d: roll, mu: m.grip }, { d: axleFlat, mu: m.grip * 0.55 }];
          const ob = other.parent();
          const otherVel = (at: THREE.Vector3) => (ob && ob.isDynamic() ? v3(ob.linvel()).add(v3(ob.angvel()).cross(at.clone().sub(v3(ob.worldCom())))) : new THREE.Vector3());
          const carrier = m.carrier;
          if (carrier) {
            // A wheel on an axle (a motor's, a track's frame): the "conveyor" way. Where it touches, the
            // ground slides past at the machine's speed plus the wheel's rim speed; the grip pushes the
            // machine (its axle's holder) there, sized for its share of the machine's mass, and the
            // same grip turns back against the wheel (the load its motor feels).
            const cc = v3(carrier.worldCom());
            const spin = v3(rb.angvel()).sub(v3(carrier.angvel())).dot(axle);
            const vp = v3(carrier.linvel()).add(v3(carrier.angvel()).cross(p.clone().sub(cc))).addScaledVector(roll, spin * m.def.radius).sub(otherVel(p));
            const meff = Mechanics.gripGain * (m.share ?? carrier.mass() / 4);
            const js = dirs.map(({ d, mu }) => ({ d, j: -vp.dot(d) * meff, max: mu * normalImpulse }));
            const over = Math.sqrt(js.reduce((t, x) => t + (x.max > 0 ? (x.j / x.max) ** 2 : 0), 0));
            const k = over > 1 ? 1 / over : 1;
            const J = new THREE.Vector3();
            for (const { d, j } of js) J.addScaledVector(d, j * k);
            kickAt(carrier, { x: J.x, y: J.y, z: J.z }, { x: p.x, y: p.y, z: p.z });
            if (ob && ob.isDynamic()) kickAt(ob, { x: -J.x, y: -J.y, z: -J.z }, { x: p.x, y: p.y, z: p.z });
            // (the wheel takes the grip's twist about its axle; its holder the opposite)
            const tw = out.clone().multiplyScalar(m.def.radius).cross(J).dot(axle);
            kickTwist(rb, { x: axle.x * tw, y: axle.y * tw, z: axle.z * tw }, centre);
            kickTwist(carrier, { x: -axle.x * tw, y: -axle.y * tw, z: -axle.z * tw }, centre);
            return;
          }
          // a loose wheel (nothing holds its axle): it's pushed itself
          const r = p.clone().sub(com);
          const vp = v3(rb.linvel()).add(v3(rb.angvel()).cross(r)).sub(otherVel(p));
          const js = dirs.map(({ d, mu }) => {
            const w = r.clone().cross(d);
            const wl = w.length();
            const meff = 1 / (1 / rb.mass() + (wl > 1e-9 ? wl * wl * invInertia(rb, w.clone().divideScalar(wl)) : 0));
            return { d, j: -vp.dot(d) * meff, max: mu * normalImpulse };
          });
          // (together within its friction: an ellipse when it grips two ways)
          const over = Math.sqrt(js.reduce((t, x) => t + (x.max > 0 ? (x.j / x.max) ** 2 : 0), 0));
          const k = over > 1 ? 1 / over : 1;
          for (const { d, j } of js) {
            const jj = j * k;
            kickAt(rb, { x: d.x * jj, y: d.y * jj, z: d.z * jj }, { x: p.x, y: p.y, z: p.z });
            if (ob && ob.isDynamic()) kickAt(ob, { x: -d.x * jj, y: -d.y * jj, z: -d.z * jj }, { x: p.x, y: p.y, z: p.z });
          }
        });
      });
    }
  }
}
