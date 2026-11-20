// Running the bench: physics with Rapier. Parts glued together become ONE rigid body (with all their
// shapes), so glue never wobbles; only real moving joints (servo shafts, motor hubs) are joints, each
// driven by a motor with the actuator's real torque limit and speed.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { kickAt, kickTwist } from './kicks';
import { Mechanics } from './mechanics';
import { drawThruster, stepThruster, type Thruster } from './thrusters';
import { placeTrackLinks, type TrackLook } from './parts/mechanics';
import * as THREE from 'three';
import { GRAVITY, KGCM, type ActuatorSpec, type JointDef, type Shape } from './parts/types';
import type { PartView } from './views';

type R = typeof RAPIER_NS;
export const STEP = 1 / 240; // physics step, s

export interface Member {
  view: PartView;
  body: string;
  obj: THREE.Object3D;
  offPos: THREE.Vector3; // body frame relative to its rigid group, at the start
  offRot: THREE.Quaternion;
  /** `${uid}/${body}` */
  key: string;
  /** its mass (g) and the middle of its shapes in its own frame (cm) */
  mass: number;
  com: THREE.Vector3;
}
/** Every joint between two rigid pieces (motors' and free ones), so one can be made again when glue
 *  breaks and a piece it holds becomes a rigid body of its own. */
export interface JointRec {
  view: PartView;
  def: JointDef;
  ga: Group;
  gb: Group;
  /** the member each side belongs to */
  aKey: string;
  bKey: string;
  joint: RAPIER_NS.ImpulseJoint;
  /** the anchor in each side's rigid-body frame; the axis in both (they share their frame's turn) */
  la: THREE.Vector3;
  lb: THREE.Vector3;
  axis: THREE.Vector3;
  slide: boolean;
  act: Actuator | null;
}
export interface Group {
  key: string;
  members: Member[];
  rb: RAPIER_NS.RigidBody;
  fixed: boolean;
}

export interface Actuator {
  id: string; // `${uid}/${joint}`
  view: PartView;
  def: JointDef;
  spec: ActuatorSpec;
  joint: RAPIER_NS.RevoluteImpulseJoint;
  ga: Group;
  gb: Group;
  axis: THREE.Vector3; // world axis at the start (= local axis of both groups)
  start: number; // the angle the joint started at (servo horn start angle), rad
  // commands
  target: number; // servo: wanted angle (rad); motor: power -1..1
  cmd: number; // servo: the target as it slews at the servo's speed
  volts: number;
  // readouts
  angle: number;
  speed: number;
  stalledFor: number;
  stallReported: boolean;
  /** driven by its wires (a device), not by the run panel's slider */
  electrical: boolean;
  limp: boolean; // no power / no signal / burnt: no torque at all
  /** the angle counted over any number of turns (steppers, free axles), rad */
  total: number;
  /** stepper: steps lost to overload, as an angle (its position is off by this much from what it was told) */
  slip: number;
  /** stepper: how fast its target moves (rad/s, smoothed): it follows without lagging behind */
  tvel: number;
  lastTarget: number;
  /** a slide joint: positions in cm along the axis */
  slide: boolean;
  la: THREE.Vector3; // the joint's anchor in each side's body frame (slide joints measure between them)
  lb: THREE.Vector3;
}

const keyOf = (uid: string, body: string) => `${uid}/${body}`;
const volumeOf = (s: Shape) =>
  s.kind === 'box' ? 8 * s.hx * s.hy * s.hz
  : s.kind === 'cylinder' ? Math.PI * s.radius ** 2 * 2 * s.halfHeight
  : s.kind === 'hull' ? Math.max(1e-4, s.volume)
  : (4 / 3) * Math.PI * s.radius ** 3;

export class Sim {
  world: RAPIER_NS.World;
  groups: Group[] = [];
  actuators: Actuator[] = [];
  time = 0;
  warnings: string[] = [];
  private byKey = new Map<string, Group>();
  private grab: {
    rb: RAPIER_NS.RigidBody; local: THREE.Vector3; target: THREE.Vector3;
    /** the member it took hold of (glue breaking can take that piece away from the rest) */
    key: string;
    /** which way it faces about the vertical (rad), turned by Q / E */
    yaw: number;
    /** too heavy to lift: said once */
    heavyTold: boolean;
    /** how hard it pulls: 1 = normal (the wheel changes it; no top limit) */
    strength: number;
  } | null = null;
  /** touch surfaces of library parts ("touch" in their shape): `${uid}/${tag}` -> colliders */
  private tagged = new Map<string, RAPIER_NS.Collider[]>();
  /** every body's colliders, by part uid / body name */
  private bodyColliders = new Map<string, RAPIER_NS.Collider[]>();
  /** which part each collider belongs to (by collider handle): what a thermal camera's ray hit */
  private colliderOwner = new Map<number, string>();
  /** gears, belts, tank tracks, roller wheels */
  mech!: Mechanics;
  private tracks: { data: TrackLook; act: Actuator }[] = [];
  /** brushless motors with propellers, by part uid */
  thrusters = new Map<string, Thruster>();
  /** From an ESC: how hard its motor goes (0..1), on how many volts, which way its phases turn it. */
  setThruster(uid: string, throttle: number, volts: number, phase: 1 | -1 = 1) {
    const t = this.thrusters.get(uid);
    if (!t) return null;
    t.throttle = Math.max(0, Math.min(1, throttle));
    t.volts = Math.max(0, volts);
    t.phase = phase;
    return t;
  }
  /** the pushing ball: follows the mouse while you hold Shift (it shoves things) */
  private hand: { rb: RAPIER_NS.RigidBody; col: RAPIER_NS.Collider; on: boolean } | null = null;
  /** what a hand can do: about 60 N (lifts 6 kg), and turn things with about 3 N*m */
  static HAND_FORCE = 60e5; // g*cm/s^2
  static HAND_TORQUE = 3e7; // g*cm^2/s^2

  constructor(
    private R: R,
    views: PartView[],
    runRoot: THREE.Group,
    private log: (msg: string, level?: 'info' | 'warn' | 'bad') => void,
    belts: { a: string; b: string }[] = [],
  ) {
    this.world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = STEP;
    // (the engine's tolerances are for metres unless told: here 1 unit = 1 cm. Without this, light
    //  feet carrying a heavy robot through a chain of joints slowly sank into the bench and it fell)
    this.world.integrationParameters.lengthUnit = 100;
    this.world.integrationParameters.numSolverIterations = 12;
    // ...but the contact look-ahead and the overlap it lets stand scale with it too (to 2 cm and
    // 5 mm): a line robot's sensors met a phantom wall above the next strip of tape and its caster
    // snagged where two strips meet. Those two keep their old sizes: 0.2 mm and 0.05 mm.
    this.world.integrationParameters.normalizedPredictionDistance = 0.0002;
    this.world.integrationParameters.normalizedAllowedLinearError = 0.00005;

    // the bench top: a big fixed slab with its top at y = 0
    const ground = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -5, 0));
    this.world.createCollider(R.ColliderDesc.cuboid(2000, 5, 2000).setFriction(0.8), ground);

    for (const v of views) v.root.updateWorldMatrix(true, true);

    // 1. rigid groups: union-find over "glued to"
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(k, r);
      return r;
    };
    const union = (a: string, b: string) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    parent.set('WORLD', 'WORLD');
    for (const v of views) for (const b of v.bodies.keys()) parent.set(keyOf(v.inst.uid, b), keyOf(v.inst.uid, b));
    for (const v of views) {
      const mount = keyOf(v.inst.uid, v.mountBody);
      if (v.inst.parent) union(mount, keyOf(v.inst.parent.uid, v.inst.parent.body));
      if (v.inst.pinned) union(mount, 'WORLD');
    }

    // 2. one Rapier body per group, all members' shapes on it. Bodies start world-aligned (rotation =
    //    identity), so a joint axis in world terms is the same axis in both bodies' frames.
    const membersByRoot = new Map<string, Member[]>();
    const tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();
    for (const v of views)
      for (const [name, obj] of v.bodies) {
        obj.matrixWorld.decompose(tmpP, tmpQ, tmpS);
        const root = find(keyOf(v.inst.uid, name));
        if (!membersByRoot.has(root)) membersByRoot.set(root, []);
        const def = v.build.bodies.find((b) => b.name === name)!;
        // (the middle of its shapes, by their volume: where its mass is)
        const com = new THREE.Vector3();
        let vol = 0;
        for (const c of def.colliders) {
          const cv = volumeOf(c.shape);
          com.addScaledVector(new THREE.Vector3(...(c.pos ?? [0, 0, 0])), cv);
          vol += cv;
        }
        if (vol > 0) com.multiplyScalar(1 / vol);
        const m: Member = { view: v, body: name, obj, offPos: tmpP.clone(), offRot: tmpQ.clone(), key: keyOf(v.inst.uid, name), mass: def.mass, com };
        membersByRoot.get(root)!.push(m);
        this.members.set(m.key, m);
      }
    for (const [root, members] of membersByRoot) {
      const fixed = find('WORLD') === root;
      const centre = new THREE.Vector3();
      let massSum = 0;
      for (const m of members) {
        centre.addScaledVector(m.offPos, m.mass);
        massSum += m.mass;
      }
      centre.multiplyScalar(1 / Math.max(massSum, 1e-6));
      const desc = (fixed ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic()).setTranslation(centre.x, centre.y, centre.z);
      // (never put to sleep: with the engine counting in cm, "at rest" became anything slower than
      //  40 cm/s, and a 1.5 cm/s linear actuator, a slow servo or a creeping robot stopped dead after
      //  a moment. The bench's scenes are small: staying awake costs little.)
      if (!fixed) desc.setCanSleep(false);
      const rb = this.world.createRigidBody(desc);
      // (a loose ball gets rolling resistance: the engine has none, and a ball nudged across a table
      //  would roll on forever; a real one stops within a metre or two. Wheels on axles are joints,
      //  not loose balls, so they aren't affected.)
      const looseBall = !fixed && members.length === 1 && members[0].view.inst.type === 'ball';
      if (!fixed) rb.setAngularDamping(looseBall ? 1.2 : 0.05);
      const g: Group = { key: root, members, rb, fixed };
      for (const m of members) {
        m.offPos.sub(centre); // now relative to the body's (world-aligned) origin
        this.makeColliders(m, rb);
        this.byKey.set(m.key, g);
      }
      this.groups.push(g);
    }

    // 3. joints, with motors where the part has an actuator there
    for (const v of views)
      for (const j of v.build.joints) {
        const ga = this.byKey.get(keyOf(v.inst.uid, j.a))!, gb = this.byKey.get(keyOf(v.inst.uid, j.b))!;
        if (ga === gb) {
          this.warn(`${v.inst.name}: its ${j.name} can't turn: the moving side is glued back to its own case (directly or through other parts)`);
          continue;
        }
        const anchor = new THREE.Vector3(...j.anchor).applyMatrix4(v.root.matrixWorld);
        const axis = new THREE.Vector3(...j.axis).transformDirection(v.root.matrixWorld).normalize();
        const pa = ga.rb.translation(), pb = gb.rb.translation();
        const rec: JointRec = {
          view: v, def: j, ga, gb, aKey: keyOf(v.inst.uid, j.a), bKey: keyOf(v.inst.uid, j.b), joint: null as any,
          la: new THREE.Vector3(anchor.x - pa.x, anchor.y - pa.y, anchor.z - pa.z),
          lb: new THREE.Vector3(anchor.x - pb.x, anchor.y - pb.y, anchor.z - pb.z),
          axis, slide: j.kind === 'prismatic', act: null,
        };
        if (j.actuator) {
          const spec = j.actuator;
          const start = spec.kind === 'servo' && !spec.byCode ? ((v.inst.params.start ?? 0) * Math.PI) / 180 : 0;
          rec.act = {
            id: `${v.inst.uid}/${j.name}`, view: v, def: j, spec, joint: null as any, ga, gb, axis, start,
            target: spec.kind === 'servo' ? start : 0, cmd: start, volts: spec.ratedVolts,
            angle: start, speed: 0, stalledFor: 0, stallReported: false, electrical: !!spec.byCode, limp: false,
            total: start, slip: 0, tvel: 0, lastTarget: 0, slide: rec.slide, la: rec.la, lb: rec.lb,
          };
          this.actuators.push(rec.act);
        }
        this.makeJoint(rec);
        this.joints.push(rec);
      }

    // 3b. mechanics: gears, pulleys and belts, tank tracks' wheels, roller wheels (mechanics.ts)
    this.mech = new Mechanics(this.world, log);
    for (const v of views)
      for (const d of v.build.mech ?? []) {
        const obj = v.bodies.get(d.body), g = this.byKey.get(keyOf(v.inst.uid, d.body));
        if (!obj || !g) continue;
        const c = new THREE.Vector3(...d.at).applyMatrix4(obj.matrixWorld);
        const n = new THREE.Vector3(...d.axis).transformDirection(obj.matrixWorld).normalize();
        const t = g.rb.translation();
        // (rigid bodies start world-aligned: their frame is the world's turned by nothing)
        this.mech.add({ def: d, view: v, rb: g.rb, local: c.sub(new THREE.Vector3(t.x, t.y, t.z)), axisL: n, colliders: this.bodyColliders.get(keyOf(v.inst.uid, d.body)) ?? [], grip: Number(v.inst.params.grip ?? 1) });
      }
    if (this.mech.items.length) this.mech.link(belts);

    // brushless motors with propellers (thrusters.ts): their ESC sets them going
    for (const v of views) {
      const d = v.build.thruster;
      const obj = d && v.bodies.get(d.body), g = d && this.byKey.get(keyOf(v.inst.uid, d.body));
      if (!d || !obj || !g) continue;
      const c = new THREE.Vector3(...d.at).applyMatrix4(obj.matrixWorld);
      const t = g.rb.translation();
      const blades: THREE.Object3D[] = [], discs: THREE.Object3D[] = [];
      obj.traverse((o) => { if (o.userData.prop) blades.push(o); if (o.userData.propDisc) discs.push(o); });
      this.thrusters.set(v.inst.uid, {
        view: v, def: d, rb: g.rb, local: c.sub(new THREE.Vector3(t.x, t.y, t.z)), axisL: new THREE.Vector3(...d.axis).transformDirection(obj.matrixWorld).normalize(),
        throttle: 0, volts: 0, phase: 1, omega: 0, angle: 0, blades, discs, thrust: 0, torque: 0, power: 0,
      });
      // (a flying thing meets the air: it doesn't keep speeding up or spinning forever)
      if (!g.fixed) {
        g.rb.setLinearDamping(Math.max(g.rb.linearDamping(), 0.25));
        g.rb.setAngularDamping(Math.max(g.rb.angularDamping(), 0.6));
      }
    }

    // tank tracks: their links go round as their sprocket turns (drawn in sync)
    for (const v of views)
      for (const b of v.bodies.values())
        b.traverse((o) => {
          if (!o.userData.track) return;
          const act = this.actuators.find((a) => a.view === v && a.def.name === 'sprocket');
          if (act) this.tracks.push({ data: o.userData.track, act });
        });

    // 4. drawing: every body moves to runRoot and follows its group from now on
    for (const g of this.groups) for (const m of g.members) runRoot.attach(m.obj);

    const loose = this.groups.filter((g) => !g.fixed).length;
    this.log(`running: ${this.groups.length} rigid pieces (${loose} free), ${this.actuators.length} motors`);
    for (const w of this.warnings) this.log(w, 'warn');
  }

  private warn(msg: string) {
    this.warnings.push(msg);
  }

  /** every member (a part's body) by `${uid}/${body}` */
  members = new Map<string, Member>();
  /** every joint between rigid pieces */
  joints: JointRec[] = [];
  /** which member each collider belongs to (by collider handle) */
  colliderMember = new Map<number, string>();

  /** A member's shapes on a rigid body (its offPos / offRot: where it sits in that body's frame). */
  private makeColliders(m: Member, rb: RAPIER_NS.RigidBody) {
    const R = this.R;
    const def = m.view.build.bodies.find((b) => b.name === m.body)!;
    const totalVol = def.colliders.reduce((s, c) => s + volumeOf(c.shape), 0) || 1;
    const list: RAPIER_NS.Collider[] = [];
    for (const c of def.colliders) {
      const lp = new THREE.Vector3(...(c.pos ?? [0, 0, 0])).applyQuaternion(m.offRot).add(m.offPos);
      const lq = m.offRot.clone().multiply(new THREE.Quaternion(...(c.rot ?? [0, 0, 0, 1])));
      const s = c.shape;
      const cd =
        s.kind === 'box' ? R.ColliderDesc.cuboid(s.hx, s.hy, s.hz)
        : s.kind === 'cylinder' ? R.ColliderDesc.cylinder(s.halfHeight, s.radius)
        : s.kind === 'hull'
          // (a piece of an imported model; if its points make no solid, a small ball stands in)
          ? R.ColliderDesc.convexHull(s.points) ?? R.ColliderDesc.ball(Math.max(0.05, Math.cbrt(s.volume) / 2))
        : R.ColliderDesc.ball(s.radius);
      const vol = volumeOf(s);
      cd.setTranslation(lp.x, lp.y, lp.z)
        .setRotation({ x: lq.x, y: lq.y, z: lq.z, w: lq.w })
        .setDensity((def.mass * (vol / totalVol)) / vol)
        .setFriction(c.friction ?? 0.7)
        .setRestitution(c.restitution ?? 0.1);
      if (c.frictionMin) cd.setFrictionCombineRule(R.CoefficientCombineRule.Min);
      const col = this.world.createCollider(cd, rb);
      list.push(col);
      this.colliderOwner.set(col.handle, m.view.inst.uid);
      this.colliderMember.set(col.handle, m.key);
      if (c.tag) {
        const k = `${m.view.inst.uid}/${c.tag}`;
        if (!this.tagged.has(k)) this.tagged.set(k, []);
        this.tagged.get(k)!.push(col);
      }
    }
    this.bodyColliders.set(m.key, list);
    return list;
  }
  /** a member's colliders */
  collidersOf(key: string) {
    return this.bodyColliders.get(key) ?? [];
  }
  /** the rigid piece a member is in */
  groupOf(key: string) {
    return this.byKey.get(key);
  }

  /** (Re)make a joint between its two rigid bodies, with its limits and motor. */
  private makeJoint(rec: JointRec) {
    const R = this.R;
    const { la, lb, axis } = rec;
    const data = rec.slide
      ? R.JointData.prismatic({ x: la.x, y: la.y, z: la.z }, { x: lb.x, y: lb.y, z: lb.z }, { x: axis.x, y: axis.y, z: axis.z })
      : R.JointData.revolute({ x: la.x, y: la.y, z: la.z }, { x: lb.x, y: lb.y, z: lb.z }, { x: axis.x, y: axis.y, z: axis.z });
    const joint = this.world.createImpulseJoint(data, rec.ga.rb, rec.gb.rb, true) as RAPIER_NS.RevoluteImpulseJoint;
    joint.setContactsEnabled(false);
    rec.joint = joint;
    const a = rec.act;
    if (!a) {
      if (rec.slide) joint.setLimits(-5, 5); // (a slide with no stated travel: a short one)
      return;
    }
    a.joint = joint;
    a.ga = rec.ga;
    a.gb = rec.gb;
    a.la = rec.la;
    a.lb = rec.lb;
    joint.configureMotorModel(R.MotorModel.ForceBased);
    if (a.spec.kind === 'servo' || (rec.slide && a.spec.minAngle !== undefined))
      joint.setLimits((a.spec.minAngle ?? -Math.PI) - a.start, (a.spec.maxAngle ?? Math.PI) - a.start);
    this.applyMotor(a);
  }

  /** wires inside one rigid piece at the start (no rope needed): if glue breaks between their ends,
   *  they become ropes then. Their ends in their members' own frames. */
  private latentWires: { id: string; aKey: string; bKey: string; aLocal: THREE.Vector3; bLocal: THREE.Vector3; length: number }[] = [];

  /** Glue gave way: the members in `keys` leave group `g` and become a rigid body of their own, moving
   *  as they were. Joints, wires, gears, propellers and the hand that held them follow. */
  splitOff(g: Group, keys: Set<string>): Group | null {
    const R = this.R;
    const leaving = g.members.filter((m) => keys.has(m.key));
    if (!leaving.length || leaving.length === g.members.length) return null;
    const t = g.rb.translation(), r = g.rb.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const tv = new THREE.Vector3(t.x, t.y, t.z);
    // the new body: at its members' middle (in the old body's frame), turned as the old one is now
    const c = new THREE.Vector3();
    let mass = 0;
    for (const m of leaving) {
      c.addScaledVector(m.offPos, m.mass);
      mass += m.mass;
    }
    c.multiplyScalar(1 / Math.max(mass, 1e-6));
    const cw = c.clone().applyQuaternion(q).add(tv);
    const lin = g.rb.linvel(), ang = g.rb.angvel(), com = g.rb.worldCom();
    const w = new THREE.Vector3(ang.x, ang.y, ang.z);
    const v = new THREE.Vector3(lin.x, lin.y, lin.z).add(w.clone().cross(cw.clone().sub(new THREE.Vector3(com.x, com.y, com.z))));
    const desc = R.RigidBodyDesc.dynamic().setTranslation(cw.x, cw.y, cw.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setCanSleep(false);
    const rb = this.world.createRigidBody(desc);
    rb.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    rb.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
    rb.setLinearDamping(g.fixed ? 0 : g.rb.linearDamping());
    rb.setAngularDamping(g.fixed ? 0.05 : Math.max(0.05, g.rb.angularDamping()));
    const ng: Group = { key: `${leaving[0].key}#split${this.groups.length}`, members: leaving, rb, fixed: false };
    // the members' shapes move over
    for (const m of leaving) {
      for (const col of this.bodyColliders.get(m.key) ?? []) {
        for (const [k, list] of this.tagged) {
          const i = list.indexOf(col);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) this.tagged.delete(k);
        }
        this.colliderOwner.delete(col.handle);
        this.colliderMember.delete(col.handle);
        this.world.removeCollider(col, false);
      }
      m.offPos.sub(c);
      this.makeColliders(m, rb);
      this.byKey.set(m.key, ng);
    }
    g.members = g.members.filter((m) => !keys.has(m.key));
    if (!g.fixed) g.rb.recomputeMassPropertiesFromColliders();
    this.groups.push(ng);
    // joints: a side that left is now on the new body (its anchor moved in that frame by c)
    for (const j of this.joints) {
      const aMoved = keys.has(j.aKey) && j.ga === g, bMoved = keys.has(j.bKey) && j.gb === g;
      if (!aMoved && !bMoved) continue;
      this.world.removeImpulseJoint(j.joint, true);
      if (aMoved) { j.ga = ng; j.la.sub(c); }
      if (bMoved) { j.gb = ng; j.lb.sub(c); }
      this.makeJoint(j);
    }
    // wires already ropes
    for (const wr of this.wireRopes) {
      if (wr.ga === g && keys.has(wr.aKey)) { wr.ga = ng; wr.la.sub(c); }
      if (wr.gb === g && keys.has(wr.bKey)) { wr.gb = ng; wr.lb.sub(c); }
    }
    // wires that were inside one piece and now span two: ropes from now on
    for (let i = this.latentWires.length - 1; i >= 0; i--) {
      const lw = this.latentWires[i];
      const ga = this.byKey.get(lw.aKey), gb = this.byKey.get(lw.bKey);
      if (!ga || !gb || ga === gb) continue;
      this.latentWires.splice(i, 1);
      const ma = this.members.get(lw.aKey)!, mb = this.members.get(lw.bKey)!;
      const la = lw.aLocal.clone().applyQuaternion(ma.offRot).add(ma.offPos);
      const lb = lw.bLocal.clone().applyQuaternion(mb.offRot).add(mb.offPos);
      this.wireRopes.push({ id: lw.id, ga, gb, aKey: lw.aKey, bKey: lw.bKey, la, lb, length: lw.length, peak: 0 });
      this.ropes++;
      console.info(`[glue] wire ${lw.id} now joins two pieces: it holds its length (${lw.length.toFixed(1)} cm) from now on`);
    }
    // gears, wheels and propellers on the pieces that left
    for (const it of this.mech.items)
      if (it.rb === g.rb && keys.has(keyOf(it.view.inst.uid, it.def.body))) {
        it.rb = rb;
        it.local.sub(c);
        it.colliders = this.bodyColliders.get(keyOf(it.view.inst.uid, it.def.body)) ?? [];
      }
    for (const th of this.thrusters.values())
      if (th.rb === g.rb && keys.has(keyOf(th.view.inst.uid, th.def.body))) {
        th.rb = rb;
        th.local.sub(c);
      }
    if (this.grab && this.grab.rb === g.rb && keys.has(this.grab.key)) {
      this.grab.rb = rb;
      this.grab.local.sub(c);
    }
    console.info(`[glue] ${leaving.map((m) => m.view.inst.name + (m.body === 'body' ? '' : ` (${m.body})`)).join(', ')} came off as a piece of its own: ${mass.toFixed(0)} g, moving ${v.length().toFixed(1)} cm/s`);
    return ng;
  }

  private applyMotor(a: Actuator) {
    // Force-based motors in real units (g*cm^2/s^2). (Acceleration-based ones ignore the load's
    // inertia: an MG996R sagged 24 deg under 6 % of its torque, 2026-11-14.)
    if (a.spec.kind === 'free') {
      // no motor: an axle or hinge with a little friction (its "torque" is that friction)
      const f = a.spec.maxTorque * KGCM;
      a.joint.configureMotorVelocity(0, f / Math.max(a.spec.speed, 1e-3));
      a.joint.setMotorMaxForce(f);
      return;
    }
    const v = a.limp ? 0 : a.volts / a.spec.ratedVolts;
    const torque = a.spec.maxTorque * KGCM * v;
    if (a.spec.kind === 'stepper') {
      // a stepper holds its position with its full torque; where it goes is set every step (step())
      const err = a.target - a.slip - a.total;
      const top = a.spec.speed * Math.min(1, v);
      const vel = Math.max(-top, Math.min(top, a.tvel + err * 60));
      a.joint.configureMotorVelocity(vel, torque / Math.max(a.spec.speed * 0.05, 1e-3));
      a.joint.setMotorMaxForce(torque);
      a.ga.rb.wakeUp();
      a.gb.rb.wakeUp();
      return;
    }
    if (a.spec.kind === 'servo') {
      if (a.limp) {
        // no signal (or no power): its gearbox still holds it back, a good part of its torque (a
        // hobby servo's gears are hard to turn by hand: a limp robot sags, it doesn't drop)
        const f = a.spec.maxTorque * KGCM * 0.2;
        a.joint.configureMotorVelocity(0, f / Math.max(a.spec.speed * 0.02, 1e-3));
        a.joint.setMotorMaxForce(f);
        a.ga.rb.wakeUp();
        a.gb.rb.wakeUp();
        return;
      }
      // a hobby servo's controller gives full torque within ~3 deg of error; damping 0.03 s of it
      // keeps light horns calm and heavy arms from bouncing. The speed limit comes from slewing `cmd`.
      const k = torque / 0.05;
      a.joint.configureMotorPosition(a.cmd - a.start, k, k * 0.03);
    } else {
      // a DC motor: torque falls linearly from stall (at 0 rpm) to 0 (at no-load speed)
      const noLoad = a.spec.speed * v;
      // a geared motor that isn't driven (no power, or its driver coasting) is held back by its
      // gearbox's friction: it stops within a turn or so instead of spinning on (about 8 % of stall)
      const friction = a.spec.maxTorque * KGCM * 0.08;
      if (Math.abs(a.target) * v < 0.02) {
        a.joint.configureMotorVelocity(0, friction / Math.max(a.spec.speed, 1e-3));
        a.joint.setMotorMaxForce(friction);
        a.ga.rb.wakeUp();
        a.gb.rb.wakeUp();
        return;
      }
      a.joint.configureMotorVelocity(noLoad * a.target, torque / Math.max(noLoad, 1e-3));
    }
    a.joint.setMotorMaxForce(torque);
    a.ga.rb.wakeUp();
    a.gb.rb.wakeUp();
  }

  actuatorOf(uid: string) {
    return this.actuators.find((a) => a.view.inst.uid === uid);
  }
  /** From a device: servo angle (rad) or motor direction (-1..1), the volts it gets, or limp. */
  driveActuator(a: Actuator, target: number, volts: number, limp: boolean) {
    const changed = a.limp !== limp || Math.abs(a.volts - volts) > 0.05 || (a.spec.kind === 'motor' && Math.abs(a.target - target) > 0.01);
    if (a.spec.kind === 'servo') {
      const t = Math.min(a.spec.maxAngle ?? Math.PI, Math.max(a.spec.minAngle ?? -Math.PI, target));
      if (Math.abs(t - a.target) > 1e-4) {
        a.target = t;
        a.stalledFor = 0;
        a.stallReported = false;
      }
    } else if (a.spec.kind === 'stepper') a.target = target;
    else if (a.spec.kind === 'motor') a.target = Math.max(-1, Math.min(1, target));
    a.volts = Math.max(0, volts);
    a.limp = limp;
    a.electrical = true;
    if (changed) this.applyMotor(a);
  }
  ropes = 0;
  /** wires between pieces that move apart: slack is free; pulled tight they pull back, and pulled too
   *  hard they snap (a jumper pulls off its pin) */
  private wireRopes: { id: string; ga: Group; gb: Group; aKey: string; bKey: string; la: THREE.Vector3; lb: THREE.Vector3; length: number; peak: number }[] = [];
  /** the pull (N) that snaps a wire: a jumper's pin comes off its header at about this */
  static WIRE_BREAK_N = 5;
  /** a wire snapped: its id, the pull that did it (N) */
  onWireSnap: ((id: string, newtons: number) => void) | null = null;
  /** A wire as a rope between two pins (world points at the start). Wires within one rigid piece need nothing. */
  addWire(id: string, aKey: { uid: string; body: string }, aWorld: THREE.Vector3, bKey: { uid: string; body: string }, bWorld: THREE.Vector3, length: number) {
    const ka = keyOf(aKey.uid, aKey.body), kb = keyOf(bKey.uid, bKey.body);
    const ga = this.byKey.get(ka), gb = this.byKey.get(kb);
    if (!ga || !gb) return false;
    if (ga === gb) {
      // (inside one rigid piece: nothing to do unless glue between its ends breaks)
      const ma = this.members.get(ka), mb = this.members.get(kb);
      if (ma && mb) {
        const t = ga.rb.translation(); // (bodies start world-aligned)
        const local = (m: Member, p: THREE.Vector3) => new THREE.Vector3(p.x - t.x, p.y - t.y, p.z - t.z).sub(m.offPos).applyQuaternion(m.offRot.clone().invert());
        this.latentWires.push({ id, aKey: ka, bKey: kb, aLocal: local(ma, aWorld), bLocal: local(mb, bWorld), length: Math.max(length, aWorld.distanceTo(bWorld)) });
      }
      return false;
    }
    const ta = ga.rb.translation(), tb = gb.rb.translation(); // (bodies start world-aligned)
    this.wireRopes.push({
      id, ga, gb, aKey: ka, bKey: kb,
      la: new THREE.Vector3(aWorld.x - ta.x, aWorld.y - ta.y, aWorld.z - ta.z),
      lb: new THREE.Vector3(bWorld.x - tb.x, bWorld.y - tb.y, bWorld.z - tb.z),
      length: Math.max(length, aWorld.distanceTo(bWorld)),
      peak: 0,
    });
    this.ropes++;
    return true;
  }
  /** each step: tight wires pull their ends together; too hard a pull snaps one */
  private pullWires() {
    const q = new THREE.Quaternion(), pa = new THREE.Vector3(), pb = new THREE.Vector3();
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), w = new THREE.Vector3();
    const at = (g: Group, local: THREE.Vector3, out: THREE.Vector3, vel: THREE.Vector3) => {
      const r = g.rb.rotation(), t = g.rb.translation(), lv = g.rb.linvel(), av = g.rb.angvel();
      q.set(r.x, r.y, r.z, r.w);
      const off = local.clone().applyQuaternion(q);
      out.set(t.x, t.y, t.z).add(off);
      vel.set(lv.x, lv.y, lv.z).add(w.set(av.x, av.y, av.z).cross(off));
    };
    for (let i = this.wireRopes.length - 1; i >= 0; i--) {
      const r = this.wireRopes[i];
      at(r.ga, r.la, pa, va);
      at(r.gb, r.lb, pb, vb);
      const d = pa.distanceTo(pb);
      const over = d - r.length;
      if (over <= 0) continue; // slack: no pull
      const dir = pb.clone().sub(pa).divideScalar(Math.max(d, 1e-6));
      const opening = vb.clone().sub(va).dot(dir); // cm/s apart
      // a stiff spring for the pieces it joins (their combined mass, fixed ones count as endless)
      const ma = r.ga.fixed ? Infinity : r.ga.rb.mass(), mb = r.gb.fixed ? Infinity : r.gb.rb.mass();
      const m = ma === Infinity ? mb : mb === Infinity ? ma : (ma * mb) / (ma + mb);
      const om = 60;
      const f = Math.max(0, m * (om * om * over + 2 * om * opening)); // g*cm/s^2
      const newtons = f / 1e5;
      r.peak = Math.max(r.peak, newtons);
      if (newtons > Sim.WIRE_BREAK_N || over > r.length * 0.5 + 2) {
        this.wireRopes.splice(i, 1);
        console.info(`[wire] ${r.id} snapped: pulled with ${newtons.toFixed(1)} N, ${over.toFixed(2)} cm past its length`);
        this.onWireSnap?.(r.id, newtons);
        continue;
      }
      const imp = dir.multiplyScalar(f * STEP);
      if (!r.ga.fixed) kickAt(r.ga.rb, { x: imp.x, y: imp.y, z: imp.z }, { x: pa.x, y: pa.y, z: pa.z });
      if (!r.gb.fixed) kickAt(r.gb.rb, { x: -imp.x, y: -imp.y, z: -imp.z }, { x: pb.x, y: pb.y, z: pb.z });
    }
  }

  /** The rigid body a part's body ended up in. */
  rigidOf(uid: string, body: string) {
    return this.byKey.get(keyOf(uid, body))?.rb;
  }
  /** Distance (cm) to the first thing along a ray, ignoring `exclude`; null = nothing within max. */
  /** like raycast, and which part it hit (its uid; null: the bench floor or nothing) */
  raycastHit(origin: THREE.Vector3, dir: THREE.Vector3, max: number, exclude?: RAPIER_NS.RigidBody, uid?: string): { d: number; uid: string | null } | null {
    const ray = new this.R.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const f = this.castFilter(exclude, uid);
    const hit = this.world.castRay(ray, max, true, undefined, undefined, undefined, f.rb, f.pred);
    return hit ? { d: hit.timeOfImpact, uid: this.colliderOwner.get(hit.collider.handle) ?? null } : null;
  }
  /** what a sensor's ray passes through: its own rigid body (it and what it's glued to). But everything
   *  pinned is one fixed body (with the walls and courses): a pinned sensor passes only its own part. */
  private castFilter(exclude?: RAPIER_NS.RigidBody, uid?: string) {
    if (exclude && uid && exclude.isFixed()) return { rb: undefined, pred: (col: RAPIER_NS.Collider) => this.colliderOwner.get(col.handle) !== uid };
    return { rb: exclude, pred: undefined };
  }
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, max: number, exclude?: RAPIER_NS.RigidBody, uid?: string) {
    const ray = new this.R.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const f = this.castFilter(exclude, uid);
    const hit = this.world.castRay(ray, max, true, undefined, undefined, undefined, f.rb, f.pred);
    return hit ? hit.timeOfImpact : null;
  }

  /** Servo: angle in degrees (-90..90). Motor: power in percent (-100..100). */
  command(id: string, value: number) {
    const a = this.actuators.find((x) => x.id === id);
    if (!a) return;
    if (a.spec.kind === 'free') return;
    if (a.spec.kind === 'stepper') a.target = (value * Math.PI) / 180;
    else if (a.spec.kind === 'servo') {
      const rad = (value * Math.PI) / 180;
      a.target = Math.min(a.spec.maxAngle ?? Math.PI, Math.max(a.spec.minAngle ?? -Math.PI, rad));
    } else {
      a.target = Math.max(-1, Math.min(1, value / 100));
      this.applyMotor(a);
    }
    a.stalledFor = 0;
    a.stallReported = false;
  }

  /** Relative angle of the joint's moving side about its axis, rad (servo: absolute horn angle). */
  private jointAngle(a: Actuator) {
    const qa = a.ga.rb.rotation(), qb = a.gb.rb.rotation();
    if (a.slide) {
      // how far the moving side's anchor has slid from the fixed side's, along the axis (cm)
      const ta = a.ga.rb.translation(), tb = a.gb.rb.translation();
      const qA = new THREE.Quaternion(qa.x, qa.y, qa.z, qa.w), qB = new THREE.Quaternion(qb.x, qb.y, qb.z, qb.w);
      const pa = a.la.clone().applyQuaternion(qA).add(new THREE.Vector3(ta.x, ta.y, ta.z));
      const pb = a.lb.clone().applyQuaternion(qB).add(new THREE.Vector3(tb.x, tb.y, tb.z));
      return pb.sub(pa).dot(a.axis.clone().applyQuaternion(qA)) + a.start;
    }
    const rel = new THREE.Quaternion(qa.x, qa.y, qa.z, qa.w).invert().multiply(new THREE.Quaternion(qb.x, qb.y, qb.z, qb.w));
    const s = rel.x * a.axis.x + rel.y * a.axis.y + rel.z * a.axis.z;
    let ang = 2 * Math.atan2(s, rel.w);
    if (ang > Math.PI) ang -= 2 * Math.PI;
    if (ang < -Math.PI) ang += 2 * Math.PI;
    return ang + a.start;
  }

  /** The hand takes hold of a part at a point (the whole rigid piece it is glued into). */
  grabStart(rbHandleOf: THREE.Object3D, worldPoint: THREE.Vector3) {
    const g = this.groups.find((x) => x.members.some((m) => m.obj === rbHandleOf));
    if (!g || g.fixed) return false;
    const held = g.members.find((m) => m.obj === rbHandleOf)!;
    const p = g.rb.translation(), q = g.rb.rotation();
    const rq = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    const local = worldPoint.clone().sub(new THREE.Vector3(p.x, p.y, p.z)).applyQuaternion(rq.clone().invert());
    this.grab = { rb: g.rb, key: held.key, local, target: worldPoint.clone(), yaw: 2 * Math.atan2(rq.y, rq.w), heavyTold: false, strength: this.grip };
    this.handPush(null); // (the palm closes round it: it doesn't also push)
    g.rb.wakeUp();
    const kg = g.rb.mass() / 1000;
    console.info(`[hand] holding ${g.members[0].view.inst.name}${g.members.length > 1 ? ` (+${g.members.length - 1} glued)` : ''}: ${kg.toFixed(3)} kg`);
    return true;
  }
  grabMove(worldTarget: THREE.Vector3) {
    if (this.grab) this.grab.target.copy(worldTarget);
  }
  /** where the hold is pulling what it holds to (null: holding nothing) */
  grabTarget(): THREE.Vector3 | null {
    return this.grab ? this.grab.target.clone() : null;
  }
  /** gravity now, cm/s^2 (Earth: 981) */
  g = GRAVITY;
  /** gravity as a share of Earth's (1 Earth, 0.165 the Moon...): it changes at once, even mid-run */
  setGravity(f: number) {
    this.g = GRAVITY * Math.max(0, Math.min(3, f));
    this.world.gravity = { x: 0, y: -this.g, z: 0 };
    for (const gr of this.groups) if (!gr.fixed) gr.rb.wakeUp();
    console.info(`[sim] gravity ${(this.g / 100).toFixed(2)} m/s2`);
  }
  /** How hard the grab pulls (kept for the next grab too): 1 normal, down to 0.05; no top limit. */
  grip = 1;
  setGrip(x: number) {
    this.grip = Math.max(0.05, Number.isFinite(x) ? x : this.grip);
    if (this.grab) {
      this.grab.strength = this.grip;
      this.grab.heavyTold = false;
      this.grab.rb.wakeUp();
    }
    console.info(`[hand] grip ${Math.round(this.grip * 100)} % (${Math.round((Sim.HAND_FORCE * this.grip) / 1e5)} N most)`);
    return this.grip;
  }
  /** Turn what the hand holds about the vertical (Q / E), degrees. */
  grabTurn(deg: number) {
    if (!this.grab) return;
    this.grab.yaw += (deg * Math.PI) / 180;
    this.grab.rb.wakeUp();
  }
  grabEnd() {
    if (this.grab) {
      const v = this.grab.rb.linvel();
      console.info(`[hand] let go at ${Math.hypot(v.x, v.y, v.z).toFixed(1)} cm/s`);
    }
    this.grab = null;
  }
  get holding() {
    return !!this.grab;
  }
  grabPoint(): THREE.Vector3 | null {
    if (!this.grab) return null;
    const p = this.grab.rb.translation(), q = this.grab.rb.rotation();
    return this.grab.local.clone().applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).add(new THREE.Vector3(p.x, p.y, p.z));
  }
  /** The solid hand (the palm, pushing things) at a point, or away (null). It moves there over the
   *  next step, so what it bumps gets the hand's speed. */
  handPush(at: THREE.Vector3 | null) {
    if (!at) {
      if (this.hand?.on) {
        this.hand.on = false;
        this.hand.col.setEnabled(false);
      }
      return;
    }
    if (!this.hand) {
      const rb = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y, at.z));
      // a ball 2.4 cm across; it also reports touching fixed (pinned) things
      const col = this.world.createCollider(
        this.R.ColliderDesc.ball(1.2).setFriction(0.9).setActiveCollisionTypes(this.R.ActiveCollisionTypes.ALL),
        rb,
      );
      this.hand = { rb, col, on: false };
      console.info('[hand] pushing ball made');
    }
    if (!this.hand.on) {
      this.hand.on = true;
      this.hand.col.setEnabled(true);
      this.hand.rb.setTranslation({ x: at.x, y: at.y, z: at.z }, true);
    }
    this.hand.rb.setNextKinematicTranslation({ x: at.x, y: at.y, z: at.z });
  }
  get pushing() {
    return !!this.hand?.on;
  }
  /** Is this collider the hand's palm? */
  private isHand(c: RAPIER_NS.Collider) {
    return !!this.hand && this.hand.col.handle === c.handle;
  }

  /** Where a part's body is and how it moves: position (cm) and orientation in the world, velocity
   *  (cm/s) and spin (rad/s, world axes). From the physics now, not the last drawn frame. */
  poseOf(uid: string, body = 'body') {
    const g = this.byKey.get(keyOf(uid, body));
    if (!g) return null;
    const m = g.members.find((x) => x.view.inst.uid === uid && x.body === body)!;
    const t = g.rb.translation(), r = g.rb.rotation(), lv = g.rb.linvel(), av = g.rb.angvel();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const off = m.offPos.clone().applyQuaternion(q);
    const w = new THREE.Vector3(av.x, av.y, av.z);
    return {
      pos: off.clone().add(new THREE.Vector3(t.x, t.y, t.z)),
      quat: q.clone().multiply(m.offRot),
      vel: new THREE.Vector3(lv.x, lv.y, lv.z).add(w.clone().cross(off)),
      spin: w,
      fixed: g.fixed,
    };
  }

  /** What presses on a part's touch surface now: force in newtons, whether anything touches it, and
   *  whether the hand does. Things glued into the same rigid piece don't count (they are one thing). */
  touch(uid: string, tag: string) {
    const cols = this.tagged.get(`${uid}/${tag}`);
    let impulse = 0, touching = false, hand = false;
    if (!cols) return { force: 0, touching, hand };
    for (const c of cols)
      this.world.contactPairsWith(c, (other) => {
        this.world.contactPair(c, other, (man) => {
          let any = false;
          for (let i = 0; i < man.numContacts(); i++) {
            if (man.contactDist(i) <= 0.05) any = true;
            impulse += man.contactImpulse(i);
          }
          if (any) {
            touching = true;
            if (this.isHand(other)) hand = true;
          }
        });
      });
    // an impulse in g*cm/s over one step: force in g*cm/s^2, and 1 N = 1e5 g*cm/s^2
    return { force: impulse / STEP / 1e5, touching, hand };
  }

  step() {
    // servos slew toward their target at their rated speed (no-load); steppers head for theirs
    for (const a of this.actuators) {
      if (a.spec.kind === 'stepper') {
        const raw = (a.target - a.lastTarget) / STEP;
        a.lastTarget = a.target;
        a.tvel += (raw - a.tvel) * 0.25;
        this.applyMotor(a);
        continue;
      }
      if (a.spec.kind === 'servo') {
        const maxStep = a.spec.speed * (a.volts / a.spec.ratedVolts) * STEP;
        const d = a.target - a.cmd;
        if (Math.abs(d) > 1e-6) {
          a.cmd += Math.max(-maxStep, Math.min(maxStep, d));
          this.applyMotor(a);
        }
      }
    }
    if (this.grab) {
      // the hand: a firm spring from the held point to the mouse, plus holding the weight up, all
      // within what a hand can do (heavy things sag and drag; a robot's whole weight hangs from it)
      const rb = this.grab.rb;
      const p = this.grabPoint()!;
      const c = rb.translation(), v = rb.linvel(), w = rb.angvel();
      const r = p.clone().sub(new THREE.Vector3(c.x, c.y, c.z));
      const vp = new THREE.Vector3(v.x, v.y, v.z).add(new THREE.Vector3(w.x, w.y, w.z).cross(r));
      const str = this.grab.strength;
      // firmer: it follows the mouse more tightly, up to the stiffest spring a 1/240 s step can hold
      // steady (beyond that only its force grows: there is no top limit to that)
      const k = Math.min(120, 14 * Math.sqrt(str));
      const maxF = Sim.HAND_FORCE * str;
      const mass = rb.mass();
      const f = this.grab.target.clone().sub(p).multiplyScalar(k * k).sub(vp.multiplyScalar(2 * k)).add(new THREE.Vector3(0, this.g, 0)).multiplyScalar(mass);
      if (f.length() > maxF) {
        f.setLength(maxF);
        if (!this.grab.heavyTold && mass * this.g > maxF * 0.9) {
          this.grab.heavyTold = true;
          this.log(`too heavy to lift at this grip (${(mass / 1000).toFixed(1)} kg): scroll up for a firmer grip, or drag it`, 'warn');
        }
      }
      // pulled at the point you took it by: lift a board by its edge and it tips, hang a robot by its
      // top and it dangles (as with a real hand)
      kickAt(rb, { x: f.x * STEP, y: f.y * STEP, z: f.z * STEP }, { x: p.x, y: p.y, z: p.z });
      // turning about the vertical stays where Q / E put it (so it doesn't spin round on its grab
      // point); the other ways it swings freely, calmed a little as a hand would
      const q = rb.rotation();
      const yawNow = 2 * Math.atan2(q.y, q.w);
      let err = this.grab.yaw - yawNow;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      const pi = rb.principalInertia();
      const inertia = (pi.x + pi.y + pi.z) / 3;
      const kr = Math.min(80, 10 * Math.sqrt(str));
      const tq = new THREE.Vector3(-w.x * 3, err * kr * kr - w.y * 2 * kr, -w.z * 3).multiplyScalar(inertia);
      if (tq.length() > Sim.HAND_TORQUE * str) tq.setLength(Sim.HAND_TORQUE * str);
      kickTwist(rb, { x: tq.x * STEP, y: tq.y * STEP, z: tq.z * STEP }, p);
    }
    if (this.wireRopes.length) this.pullWires();
    if (this.mech.items.length) this.mech.before(STEP);
    for (const t of this.thrusters.values()) stepThruster(t, STEP);
    this.world.step();
    if (this.mech.items.length) this.mech.after(STEP);
    this.time += STEP;
    this.stepActuators();
    // glue: what each glued joint carried this step (and whether it held)
    this.glue?.afterStep();
  }

  /** the glue check (glue.ts), set by the app once the bench runs */
  glue: { afterStep(): void; dispose(): void } | null = null;

  private stepActuators() {
    for (const a of this.actuators) {
      const prev = a.angle;
      a.angle = this.jointAngle(a);
      let d = a.angle - prev;
      if (!a.slide) {
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
      }
      a.speed = d / STEP;
      a.total += d;
      if (a.spec.kind === 'stepper' && a.spec.feedback) {
        // a multi-turn servo: it measures where it is, so it never slips; it can stall (and says so)
        const err = a.target - a.total;
        // (stuck: short of its goal and not turning, for a while)
        a.stalledFor = Math.abs(err) > 0.15 && Math.abs(a.speed) < 0.05 && !a.limp ? a.stalledFor + STEP : 0;
        if (a.stalledFor > 0.6 && !a.stallReported) {
          a.stallReported = true;
          this.log(`${a.view.inst.name} can't reach ${Math.round((a.target * 180) / Math.PI)} deg: stuck at ${Math.round((a.total * 180) / Math.PI)} deg. Something is in the way, or the load is more than its ${a.spec.maxTorque} kg*cm.`, 'warn');
        }
        if (a.stalledFor === 0 && a.stallReported && Math.abs(err) < 0.05) a.stallReported = false;
      } else if (a.spec.kind === 'stepper' && !a.limp) {
        // overloaded (or told to go faster than it can): a real stepper loses the steps it can't make,
        // and from then on it is off by that much; it doesn't catch up
        const err = a.target - a.slip - a.total;
        // (a library's commands can arrive a few steps late when the PC runs several steps per frame:
        //  allow for that much lag at the speed it's going; a real overload keeps falling behind)
        if (Math.abs(err) > 0.35 + Math.abs(a.tvel) * 0.2) {
          a.slip += err;
          if (!a.stallReported) {
            a.stallReported = true;
            this.log(`${a.view.inst.name} skipped steps: the load is too much for its ${a.spec.maxTorque} kg*cm, or it was told to step faster than it can. It is now off from where the program thinks it is.`, 'warn');
          }
        }
      }
      if (a.spec.kind === 'servo') {
        const lag = Math.abs(a.cmd - a.angle);
        const settled = Math.abs(a.target - a.cmd) < 1e-6;
        a.stalledFor = settled && lag > 0.12 && !a.limp ? a.stalledFor + STEP : 0;
        if (a.stalledFor > 0.6 && !a.stallReported) {
          a.stallReported = true;
          const u = (x: number) => (a.slide ? `${x.toFixed(1)} cm` : `${Math.round((x * 180) / Math.PI)} deg`);
          this.log(
            `${a.view.inst.name} can't reach ${u(a.target)}: stuck at ${u(a.angle)}. ` +
              `Either something is in the way, or the load needs more than its ${a.spec.maxTorque} kg*cm (a stronger servo, a shorter arm, or less weight).`,
            'warn',
          );
        }
      }
    }
  }

  /** Move every body's drawing to where its rigid group is now. */
  sync() {
    for (const t of this.tracks) placeTrackLinks(t.data, t.act.total);
    for (const t of this.thrusters.values()) drawThruster(t);
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    for (const g of this.groups) {
      const t = g.rb.translation(), r = g.rb.rotation();
      p.set(t.x, t.y, t.z);
      q.set(r.x, r.y, r.z, r.w);
      for (const m of g.members) {
        m.obj.position.copy(m.offPos).applyQuaternion(q).add(p);
        m.obj.quaternion.copy(q).multiply(m.offRot);
      }
    }
  }

  dispose() {
    this.glue?.dispose();
    this.glue = null;
    this.world.free();
  }
}
