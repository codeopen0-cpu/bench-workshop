// Glue that can give way. Parts glued together run as one rigid body (sim.ts: glue never wobbles), so
// what each glued joint carries has to be worked out: every step, for the parts on one side of each
// joint, what it takes to move them as they moved (their mass times their acceleration) less what
// else pushes on them (gravity, contacts, the hand, propellers, wires, gears, the motor joints they
// carry): the rest went through the glue. That force and twist, spread over the glued area, against
// the glue's strength: past it, the joint lets go and that side becomes a piece of its own.
//
// A motor joint's own force isn't something the physics engine says, so it's worked out the same way
// from the pieces at the far end of each chain of joints (a servo horn and the arm on it: what it
// takes to move them, less what else pushes on them, is what the joint gave them), inwards.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { kicks } from './kicks';
import type { Group, JointRec, Member, Sim } from './sim';
import { STEP } from './sim';
import type { PartView } from './views';

/** How strong the glue is: MPa (N per mm2) over the glued area. */
export const GLUES: Record<string, { name: string; mpa: number; note: string }> = {
  hot: { name: 'Hot glue', mpa: 1, note: 'lets go under a hard knock or a strong servo' },
  super: { name: 'Superglue', mpa: 5, note: 'strong when pulled, but a hard knock can still break it' },
  strong: { name: 'Epoxy / screwed', mpa: 15, note: 'takes a lot (the default)' },
  none: { name: 'Unbreakable', mpa: Infinity, note: 'never lets go (the old way)' },
};
export const DEFAULT_GLUE = 'strong';

export interface Bond {
  /** the part glued on (its mount body) and what it is glued to */
  child: string;
  parent: string;
  name: string;
  /** the glue's middle and its outward normal, in the child's mount body frame */
  pLocal: THREE.Vector3;
  nLocal: THREE.Vector3;
  /** glued area (cm2) and its side (cm, as a square) */
  area: number;
  side: number;
  alive: boolean;
  /** how much of the glue's strength it uses: now (smoothed over a few steps) and the most so far */
  use: number;
  peak: number;
  /** the last few steps' (a knock of one step's length is real; one step's solver jitter isn't) */
  hist: number[];
  /** what loads it most now: pull, shear, bend or twist (N, N*cm) */
  parts: { pull: number; shear: number; bend: number; twist: number };
}

const v3 = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.y, v.z);
// N = 1e5 g*cm/s^2
const NEWTON = 1e5;

/** Corners of a body's shapes in the world (as built, before running). */
function shapeCorners(v: PartView, body: string): THREE.Vector3[] {
  const def = v.build.bodies.find((b) => b.name === body);
  const obj = v.bodies.get(body);
  if (!def || !obj) return [];
  obj.updateWorldMatrix(true, false);
  const out: THREE.Vector3[] = [];
  for (const c of def.colliders) {
    const s = c.shape;
    const local = new THREE.Matrix4().compose(new THREE.Vector3(...(c.pos ?? [0, 0, 0])), new THREE.Quaternion(...(c.rot ?? [0, 0, 0, 1])), new THREE.Vector3(1, 1, 1));
    const m = obj.matrixWorld.clone().multiply(local);
    if (s.kind === 'hull') {
      for (let i = 0; i + 2 < s.points.length; i += 3) out.push(new THREE.Vector3(s.points[i], s.points[i + 1], s.points[i + 2]).applyMatrix4(m));
      continue;
    }
    const [hx, hy, hz] = s.kind === 'box' ? [s.hx, s.hy, s.hz] : s.kind === 'cylinder' ? [s.radius, s.halfHeight, s.radius] : [s.radius, s.radius, s.radius];
    for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [-hz, hz]) out.push(new THREE.Vector3(x, y, z).applyMatrix4(m));
  }
  return out;
}

/** The glued joints of a bench, found before it runs (where each part sits on what it's glued to). */
export function findBonds(views: PartView[]): Bond[] {
  const byUid = new Map(views.map((v) => [v.inst.uid, v]));
  const bonds: Bond[] = [];
  for (const v of views) {
    const par = v.inst.parent;
    if (!par) continue;
    const pv = byUid.get(par.uid);
    if (!pv) continue;
    const mountObj = v.bodies.get(v.mountBody);
    if (!mountObj) continue;
    v.root.updateWorldMatrix(true, true);
    // the glue: where the part sits (its origin) facing out along its up (it was put on that face)
    const P = new THREE.Vector3().setFromMatrixPosition(v.root.matrixWorld);
    const n = new THREE.Vector3(0, 1, 0).transformDirection(v.root.matrixWorld).normalize();
    const inv = mountObj.matrixWorld.clone().invert();
    const pLocal = P.clone().applyMatrix4(inv);
    const nLocal = n.clone().transformDirection(inv).normalize();
    // the glued area: where the part's footprint (across its up) overlaps what it sits on
    const rootInv = v.root.matrixWorld.clone().invert();
    const range = (pts: THREE.Vector3[]) => {
      const r = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
      for (const p of pts) {
        const q = p.clone().applyMatrix4(rootInv);
        r.x0 = Math.min(r.x0, q.x); r.x1 = Math.max(r.x1, q.x);
        r.z0 = Math.min(r.z0, q.z); r.z1 = Math.max(r.z1, q.z);
      }
      return r;
    };
    const a = range(shapeCorners(v, v.mountBody)), b = range(shapeCorners(pv, par.body));
    const ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const oz = Math.max(0, Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0));
    // (at least a dab: 0.1 cm2; round things touch over less than their box: about 80 %)
    const area = Math.max(0.1, (isFinite(ox * oz) ? ox * oz : 1) * 0.8);
    bonds.push({
      child: `${v.inst.uid}/${v.mountBody}`, parent: `${par.uid}/${par.body}`,
      name: `${v.inst.name} on ${pv.inst.name}`,
      pLocal, nLocal, area, side: Math.sqrt(area), alive: true, use: 0, peak: 0, hist: [], parts: { pull: 0, shear: 0, bend: 0, twist: 0 },
    });
  }
  return bonds;
}

interface Tree {
  g: Group;
  root: string; // a member key, or 'WORLD'
  /** members, parents first; each with the bond to its parent (null: an unbreakable link or the root) */
  order: { key: string; parent: string | null; bond: Bond | null }[];
}

interface Wrench { f: THREE.Vector3; m: THREE.Vector3 } // a force and a twist about some point

export class GlueCheck {
  /** g*cm/s^2 per cm2 the glue holds */
  strength: number;
  private trees: Tree[] = [];
  private dirty = true;
  private prev = new Map<number, { v: THREE.Vector3; w: THREE.Vector3 }>();
  /** the joints' forces on each side's member, last step: about the joint's anchor */
  private jointForce = new Map<JointRec, { a: Wrench; b: Wrench; anchor: THREE.Vector3; known: boolean }>();
  private told = new Set<string>();
  /** how well the sums add up, for the debug log: pieces with no joints should come out at nothing */
  private errSum = 0;
  private errN = 0;
  private weightSum = 0;
  private stepN = 0;
  broken: Bond[] = [];
  /** each motor's twist (g*cm^2/s^2; a slide's push in g*cm/s^2) about its axis: now (smoothed) and
   *  the most so far; known: false when its joint is in a loop and couldn't be told apart */
  motorLoad = new Map<import('./sim').Actuator, { now: number; peak: number; known: boolean }>();

  constructor(private sim: Sim, public bonds: Bond[], glue: string, private log: (msg: string, level?: 'info' | 'warn' | 'bad') => void) {
    this.strength = (GLUES[glue] ?? GLUES[DEFAULT_GLUE]).mpa * 100 * NEWTON;
    kicks.on = true;
    kicks.list.length = 0;
    const g = GLUES[glue] ?? GLUES[DEFAULT_GLUE];
    console.info(`[glue] ${bonds.length} glued joints, ${g.name} (${g.mpa} MPa): ${bonds.map((b) => `${b.name} ${b.area.toFixed(2)} cm2`).join(', ') || 'none'}`);
  }

  setGlue(glue: string) {
    this.strength = (GLUES[glue] ?? GLUES[DEFAULT_GLUE]).mpa * 100 * NEWTON;
    console.info(`[glue] now ${(GLUES[glue] ?? GLUES[DEFAULT_GLUE]).name}`);
  }

  dispose() {
    kicks.on = false;
    kicks.list.length = 0;
  }

  /** Each piece's glue joints as a tree from its heaviest member (or the bench, for pinned pieces). */
  private buildTrees() {
    this.trees = [];
    const sim = this.sim;
    for (const g of sim.groups) {
      const keys = new Set(g.members.map((m) => m.key));
      const bonds = this.bonds.filter((b) => b.alive && keys.has(b.child) && (keys.has(b.parent)));
      if (!bonds.length) continue;
      const adj = new Map<string, { to: string; bond: Bond | null }[]>();
      const link = (a: string, b: string, bond: Bond | null) => {
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a)!.push({ to: b, bond });
        adj.get(b)!.push({ to: a, bond });
      };
      for (const b of bonds) link(b.child, b.parent, b);
      // a part's own bodies stay together; pinned parts hold to the bench
      const byPart = new Map<string, Member[]>();
      for (const m of g.members) {
        const uid = m.view.inst.uid;
        if (!byPart.has(uid)) byPart.set(uid, []);
        byPart.get(uid)!.push(m);
        if (g.fixed && m.view.inst.pinned && m.body === m.view.mountBody) link(m.key, 'WORLD', null);
      }
      for (const list of byPart.values()) for (const m of list.slice(1)) link(list[0].key, m.key, null);
      let root = 'WORLD';
      if (!g.fixed) root = g.members.reduce((a, b) => (b.mass > a.mass ? b : a)).key;
      const order: Tree['order'] = [{ key: root, parent: null, bond: null }];
      const seen = new Set([root]);
      for (let i = 0; i < order.length; i++)
        for (const e of adj.get(order[i].key) ?? [])
          if (!seen.has(e.to)) {
            seen.add(e.to);
            order.push({ key: e.to, parent: order[i].key, bond: e.bond });
          }
      // members joined to nothing glued (can't happen in one piece, but be safe): their own roots
      for (const m of g.members) if (!seen.has(m.key)) order.push({ key: m.key, parent: null, bond: null });
      this.trees.push({ g, root, order });
    }
    this.dirty = false;
    console.info(`[glue] watching ${this.trees.reduce((s, t) => s + t.order.filter((o) => o.bond).length, 0)} glued joints in ${this.trees.length} pieces`);
  }

  /** Where a member's middle is now (world), and its mass. */
  private memberAt(g: Group, m: Member, q: THREE.Quaternion, t: THREE.Vector3) {
    return m.com.clone().applyQuaternion(m.offRot).add(m.offPos).applyQuaternion(q).add(t);
  }

  /** The contacts on one collider this step: how hard they press (g*cm/s^2), where, and which way
   *  (into this collider). The engine says nothing of its friction (it reads 0): that is worked out
   *  from what's left over (afterStep). */
  private contactsOn(col: RAPIER_NS.Collider, add: (f: THREE.Vector3, p: THREE.Vector3, n: THREE.Vector3, lambda: number) => void) {
    const world = this.sim.world;
    world.contactPairsWith(col, (other) => {
      world.contactPair(col, other, (man, flipped) => {
        // (the engine pushes the first collider along -normal)
        const d = v3(man.normal()).negate();
        if (flipped) d.negate();
        const c1 = flipped ? other : col;
        const r = c1.rotation(), tr = c1.translation();
        const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
        for (let i = 0; i < man.numContacts(); i++) {
          const ni = man.contactImpulse(i);
          if (!ni) continue;
          const lp = man.localContactPoint1(i);
          if (!lp) continue;
          const p = v3(lp).applyQuaternion(q).add(v3(tr));
          add(d.clone().multiplyScalar(ni / STEP), p, d.clone(), ni);
        }
      });
    });
  }

  /** After each physics step: the joints' forces, then every glue joint's load; break what can't hold. */
  afterStep() {
    const sim = this.sim;
    if (this.dirty) this.buildTrees();
    this.stepN++;
    const grav = new THREE.Vector3(0, -sim.g, 0);
    // every piece's motion this step
    const motion = new Map<Group, { q: THREE.Quaternion; t: THREE.Vector3; com: THREE.Vector3; v: THREE.Vector3; w: THREE.Vector3; a: THREE.Vector3; al: THREE.Vector3 }>();
    const motionOf = (g: Group) => {
      let mo = motion.get(g);
      if (mo) return mo;
      const r = g.rb.rotation(), t = g.rb.translation();
      const v = v3(g.rb.linvel()), w = v3(g.rb.angvel());
      const pr = this.prev.get(g.rb.handle);
      const a = g.fixed || !pr ? new THREE.Vector3() : v.clone().sub(pr.v).divideScalar(STEP);
      const al = g.fixed || !pr ? new THREE.Vector3() : w.clone().sub(pr.w).divideScalar(STEP);
      mo = { q: new THREE.Quaternion(r.x, r.y, r.z, r.w), t: v3(t), com: v3(g.rb.worldCom()), v, w, a, al };
      motion.set(g, mo);
      return mo;
    };
    // the hand's, propellers', wires' and gears' pushes this step, by rigid body
    const kicksBy = new Map<number, typeof kicks.list>();
    for (const k of kicks.list) {
      if (!kicksBy.has(k.h)) kicksBy.set(k.h, []);
      kicksBy.get(k.h)!.push(k);
    }
    kicks.list.length = 0;

    // every piece's contacts this step (by member), and the friction worked out for each
    type Touch = { key: string; f: THREE.Vector3; p: THREE.Vector3; n: THREE.Vector3; lambda: number; fr: THREE.Vector3 };
    const touches = new Map<Group, Touch[]>();
    const touchesOf = (g: Group) => {
      let list = touches.get(g);
      if (list) return list;
      list = [];
      for (const mb of g.members)
        for (const col of sim.collidersOf(mb.key))
          this.contactsOn(col, (f, p, n, lambda) => list!.push({ key: mb.key, f, p, n, lambda, fr: new THREE.Vector3() }));
      touches.set(g, list);
      return list;
    };

    // 1. the joints' forces: from the outermost pieces in
    const groupJoints = new Map<Group, JointRec[]>();
    for (const j of sim.joints) {
      for (const g of [j.ga, j.gb]) {
        if (!groupJoints.has(g)) groupJoints.set(g, []);
        groupJoints.get(g)!.push(j);
      }
    }
    this.jointForce.clear();
    const residual = new Map<Group, Wrench>(); // about the piece's centre of mass
    const residualOf = (g: Group): Wrench => {
      let r = residual.get(g);
      if (r) return r;
      const mo = motionOf(g);
      const mass = g.rb.mass();
      // what moving it as it moved took
      const f = mo.a.clone().multiplyScalar(mass);
      const fr = g.rb.principalInertiaLocalFrame();
      const Rq = mo.q.clone().multiply(new THREE.Quaternion(fr.x, fr.y, fr.z, fr.w));
      const ip = v3(g.rb.principalInertia());
      const inertia = (x: THREE.Vector3) => {
        const l = x.clone().applyQuaternion(Rq.clone().invert());
        return new THREE.Vector3(l.x * ip.x, l.y * ip.y, l.z * ip.z).applyQuaternion(Rq);
      };
      const m = inertia(mo.al);
      // less what pushed it: gravity, its damping, contacts, kicks
      f.addScaledVector(grav, -mass);
      const ld = g.rb.linearDamping(), ad = g.rb.angularDamping();
      if (ld) f.addScaledVector(mo.v, (mass * ld) / (1 + STEP * ld));
      if (ad) m.add(inertia(mo.w).multiplyScalar(ad / (1 + STEP * ad)));
      for (const c of touchesOf(g)) {
        f.sub(c.f);
        m.sub(c.p.clone().sub(mo.com).cross(c.f));
      }
      for (const k of kicksBy.get(g.rb.handle) ?? []) {
        if (k.f) {
          const kf = k.f.clone().divideScalar(STEP);
          f.sub(kf);
          m.sub(k.p.clone().sub(mo.com).cross(kf));
        }
        if (k.t) m.sub(k.t.clone().divideScalar(STEP));
      }
      r = { f, m };
      residual.set(g, r);
      return r;
    };
    const unknown = new Set(sim.joints);
    for (let pass = 0; pass < 32 && unknown.size; pass++) {
      let progress = false;
      for (const [g, list] of groupJoints) {
        if (g.fixed) continue;
        const open = list.filter((j) => unknown.has(j));
        if (open.length !== 1) continue;
        const j = open[0];
        const res = residualOf(g);
        const mo = motionOf(g);
        const anchorOf = (jr: JointRec) => {
          const side = jr.ga;
          const m2 = motionOf(side);
          return jr.la.clone().applyQuaternion(m2.q).add(m2.t);
        };
        // the joint gave this piece what's left over once the other joints' shares are taken off
        const f = res.f.clone(), mCom = res.m.clone();
        for (const o of list) {
          if (o === j) continue;
          const jf = this.jointForce.get(o)!;
          const w = o.ga === g ? jf.a : jf.b;
          f.sub(w.f);
          mCom.sub(w.m.clone().add(jf.anchor.clone().sub(mo.com).cross(w.f)));
        }
        const anchor = anchorOf(j);
        // (about the anchor: m_anchor = m_com - (anchor - com) x f)
        const mA = mCom.clone().sub(anchor.clone().sub(mo.com).cross(f));
        const mine: Wrench = { f, m: mA }, theirs: Wrench = { f: f.clone().negate(), m: mA.clone().negate() };
        this.jointForce.set(j, j.ga === g ? { a: mine, b: theirs, anchor, known: true } : { a: theirs, b: mine, anchor, known: true });
        unknown.delete(j);
        progress = true;
      }
      if (!progress) break;
    }
    // each motor's twist about its own axis (what it works against), smoothed over about 0.1 s
    for (const j of sim.joints) {
      if (!j.act) continue;
      const jf = this.jointForce.get(j);
      let t = 0;
      if (jf) {
        const mo = motionOf(j.ga);
        const axisW = j.axis.clone().applyQuaternion(mo.q).normalize();
        t = j.slide ? Math.abs(jf.b.f.dot(axisW)) : Math.abs(jf.b.m.dot(axisW));
      }
      const prevT = this.motorLoad.get(j.act) ?? { now: 0, peak: 0, known: !!jf };
      prevT.now += (t - prevT.now) * Math.min(1, STEP / 0.1);
      prevT.known = !!jf;
      // (the first moments of a run are things settling: peaks count after 0.3 s)
      if (sim.time > 0.3) prevT.peak = Math.max(prevT.peak, prevT.now);
      this.motorLoad.set(j.act, prevT);
    }
    if (unknown.size && !this.told.has('loops')) {
      this.told.add('loops');
      console.info(`[glue] ${unknown.size} joints are in loops (their forces can't be told apart): glue near them counts them as nothing`);
    }

    // what's left over on a piece once its joints are counted is its friction (the only push not
    // known yet): shared out over its contacts by how hard each presses, across each one's face.
    // (A piece at the end of a chain of joints has nothing left over: its joint took it all.)
    // (only pieces with glue or joints need it; every 24th step all of them, for the debug check)
    const needFriction = new Set<Group>(this.stepN % 24 === 0 ? sim.groups : []);
    for (const t of this.trees) needFriction.add(t.g);
    for (const j of sim.joints) { needFriction.add(j.ga); needFriction.add(j.gb); }
    let leftErr = 0;
    for (const g of needFriction) {
      if (g.fixed) continue;
      const list = touchesOf(g);
      if (!list.length) continue;
      const mo = motionOf(g);
      const left = residualOf(g).f.clone();
      for (const j of groupJoints.get(g) ?? []) {
        const jf = this.jointForce.get(j);
        if (jf) left.sub(j.ga === g ? jf.a.f : jf.b.f);
      }
      const total = list.reduce((s2, c) => s2 + c.lambda, 0);
      if (total <= 0) continue;
      const given = new THREE.Vector3();
      for (const c of list) {
        const share = left.clone().multiplyScalar(c.lambda / total);
        c.fr.copy(share.addScaledVector(c.n, -share.dot(c.n)));
        given.add(c.fr);
      }
      if (!groupJoints.has(g)) leftErr += left.sub(given).length();
      void mo;
    }

    // (the debug check: a piece with no joints should come out at nothing left over, once its
    //  friction is counted)
    if (this.stepN % 24 === 0)
      for (const g of sim.groups) {
        if (g.fixed || groupJoints.has(g)) continue;
        const r = residualOf(g).f.clone();
        for (const c of touchesOf(g)) r.sub(c.fr);
        this.errSum += r.length() / NEWTON;
        this.weightSum += (g.rb.mass() * sim.g) / NEWTON;
        this.errN++;
      }
    void leftErr;
    if (this.stepN === 240 * 3 && this.errN) {
      console.info(`[glue] how well the forces add up (pieces with no joints, should be about 0): off by ${(this.errSum / this.errN).toFixed(3)} N on average, against weights of ${(this.weightSum / this.errN).toFixed(3)} N`);
    }

    // 2. the glue joints
    let breakNow: { tree: Tree; bond: Bond; why: string } | null = null;
    for (const tree of this.trees) {
      const g = tree.g;
      const mo = motionOf(g);
      // each member's own forces (about the piece's centre of mass) and what moving it took
      const own = new Map<string, Wrench>();
      const need = new Map<string, Wrench>();
      const pos = new Map<string, THREE.Vector3>();
      for (const mb of g.members) {
        const r = this.memberAt(g, mb, mo.q, mo.t);
        pos.set(mb.key, r);
        const rc = r.clone().sub(mo.com);
        const acc = mo.a.clone().add(mo.al.clone().cross(rc)).add(mo.w.clone().cross(mo.w.clone().cross(rc)));
        const fn = acc.multiplyScalar(mb.mass);
        need.set(mb.key, { f: fn, m: rc.clone().cross(fn) });
        const f = grav.clone().multiplyScalar(mb.mass);
        const ld = g.rb.linearDamping();
        if (ld) f.addScaledVector(mo.v.clone().add(mo.w.clone().cross(rc)), (-mb.mass * ld) / (1 + STEP * ld));
        const m = rc.clone().cross(f);
        own.set(mb.key, { f, m });
      }
      // contacts (pressing, and their friction)
      for (const c of g.fixed ? [] : touchesOf(g)) {
        const w = own.get(c.key);
        if (!w) continue;
        const cf = c.f.clone().add(c.fr);
        w.f.add(cf);
        w.m.add(c.p.clone().sub(mo.com).cross(cf));
      }
      // kicks: on the member nearest where they pushed
      for (const k of kicksBy.get(g.rb.handle) ?? []) {
        let best = '', bd = Infinity;
        for (const [key, p] of pos) {
          const d = p.distanceToSquared(k.p);
          if (d < bd) { bd = d; best = key; }
        }
        const w = own.get(best);
        if (!w) continue;
        if (k.f) {
          const kf = k.f.clone().divideScalar(STEP);
          w.f.add(kf);
          w.m.add(k.p.clone().sub(mo.com).cross(kf));
        }
        if (k.t) w.m.add(k.t.clone().divideScalar(STEP));
      }
      // joints: on the member each side belongs to
      for (const j of groupJoints.get(g) ?? []) {
        const jf = this.jointForce.get(j);
        if (!jf) continue;
        for (const [side, key, wr] of [[j.ga, j.aKey, jf.a], [j.gb, j.bKey, jf.b]] as const) {
          if (side !== g) continue;
          const w = own.get(key);
          if (!w) continue;
          w.f.add(wr.f);
          w.m.add(wr.m.clone().add(jf.anchor.clone().sub(mo.com).cross(wr.f)));
        }
      }
      // add up from the outermost members in: each bond carries what its side needs less what pushes it
      const sumNeed = new Map<string, Wrench>(), sumOwn = new Map<string, Wrench>();
      for (let i = tree.order.length - 1; i >= 0; i--) {
        const o = tree.order[i];
        if (o.key === 'WORLD') continue;
        const n0 = need.get(o.key), w0 = own.get(o.key);
        const sn = sumNeed.get(o.key) ?? { f: new THREE.Vector3(), m: new THREE.Vector3() };
        const so = sumOwn.get(o.key) ?? { f: new THREE.Vector3(), m: new THREE.Vector3() };
        if (n0) { sn.f.add(n0.f); sn.m.add(n0.m); }
        if (w0) { so.f.add(w0.f); so.m.add(w0.m); }
        sumNeed.set(o.key, sn);
        sumOwn.set(o.key, so);
        if (o.parent && o.parent !== 'WORLD') {
          const pn = sumNeed.get(o.parent) ?? { f: new THREE.Vector3(), m: new THREE.Vector3() };
          const po = sumOwn.get(o.parent) ?? { f: new THREE.Vector3(), m: new THREE.Vector3() };
          pn.f.add(sn.f); pn.m.add(sn.m); po.f.add(so.f); po.m.add(so.m);
          sumNeed.set(o.parent, pn);
          sumOwn.set(o.parent, po);
        }
        const b = o.bond;
        if (!b) continue;
        // what the other side gives this side (about the centre of mass), then about the glue
        const f = sn.f.clone().sub(so.f), mCom = sn.m.clone().sub(so.m);
        const cm = sim.members.get(b.child)!;
        const P = this.memberAt(g, { ...cm, com: b.pLocal } as Member, mo.q, mo.t);
        const nW = b.nLocal.clone().applyQuaternion(cm.offRot).applyQuaternion(mo.q).normalize();
        const mP = mCom.sub(P.clone().sub(mo.com).cross(f));
        // (the force on the glued-on part: if this side is the other one, the opposite)
        const sign = o.key === b.child ? 1 : -1;
        f.multiplyScalar(sign);
        mP.multiplyScalar(sign);
        const pull = Math.max(0, -f.dot(nW)); // pulled off its face
        const shear = f.clone().addScaledVector(nW, -f.dot(nW)).length();
        const twist = Math.abs(mP.dot(nW));
        const bend = mP.clone().addScaledVector(nW, -mP.dot(nW)).length();
        const A = b.area, L = b.side;
        const sigma = -f.dot(nW) / A + bend / ((A * L) / 6); // at the edge that peels
        const tau = shear / A + twist / (0.208 * L * L * L);
        const u = Math.hypot(Math.max(0, sigma), tau) / this.strength;
        b.hist.push(isFinite(u) ? u : 0);
        if (b.hist.length > 3) b.hist.shift();
        b.use = b.hist.reduce((s, x) => s + x, 0) / b.hist.length;
        b.peak = Math.max(b.peak, b.use);
        b.parts = { pull: pull / NEWTON, shear: shear / NEWTON, bend: bend / NEWTON, twist: twist / NEWTON };
        if (b.use > 1 && b.hist.length >= 3 && (!breakNow || b.use > breakNow.bond.use)) {
          const most = Object.entries({ pulled: pull / A, 'pushed sideways': shear / A, bent: (bend * 6) / (A * L), twisted: twist / (0.208 * L * L * L) }).sort((x, y) => y[1] - x[1])[0][0];
          breakNow = { tree, bond: b, why: most };
        }
      }
    }
    // remember this step's motion for the next one's accelerations
    for (const g of sim.groups) {
      const mo = motionOf(g);
      this.prev.set(g.rb.handle, { v: mo.v, w: mo.w });
    }
    if (breakNow) this.breakBond(breakNow.tree, breakNow.bond, breakNow.why);
  }

  private breakBond(tree: Tree, b: Bond, why: string) {
    b.alive = false;
    this.broken.push(b);
    const p = b.parts;
    this.log(`glue gave way: ${b.name} came off (${why}: pulled ${p.pull.toFixed(1)} N, sideways ${p.shear.toFixed(1)} N, bent ${(p.bend).toFixed(1)} N*cm, twisted ${(p.twist).toFixed(1)} N*cm on ${b.area.toFixed(2)} cm2 of glue)`, 'warn');
    console.info(`[glue] broke: ${b.name} at ${(b.use * 100).toFixed(0)} % of its strength (${why})`);
    // what's still joined to the rest without it
    const g = tree.g;
    const keys = new Set(g.members.map((m) => m.key));
    const adj = new Map<string, string[]>();
    const link = (x: string, y: string) => {
      if (!adj.has(x)) adj.set(x, []);
      if (!adj.has(y)) adj.set(y, []);
      adj.get(x)!.push(y);
      adj.get(y)!.push(x);
    };
    for (const o of this.bonds) if (o.alive && keys.has(o.child) && keys.has(o.parent)) link(o.child, o.parent);
    const byPart = new Map<string, string>();
    for (const m of g.members) {
      const uid = m.view.inst.uid;
      if (byPart.has(uid)) link(byPart.get(uid)!, m.key);
      else byPart.set(uid, m.key);
      if (g.fixed && m.view.inst.pinned && m.body === m.view.mountBody) link(m.key, 'WORLD');
    }
    const reach = new Set([tree.root]);
    const stack = [tree.root];
    while (stack.length) for (const n of adj.get(stack.pop()!) ?? []) if (!reach.has(n)) { reach.add(n); stack.push(n); }
    const off = new Set([...keys].filter((k) => !reach.has(k)));
    if (off.size) {
      const ng = this.sim.splitOff(g, off);
      if (ng) {
        // (no jump in its acceleration: it starts from how it moves now)
        this.prev.set(ng.rb.handle, { v: v3(ng.rb.linvel()), w: v3(ng.rb.angvel()) });
      }
    } else console.info(`[glue] ${b.name}: still held on by other glue`);
    this.dirty = true;
  }
}
