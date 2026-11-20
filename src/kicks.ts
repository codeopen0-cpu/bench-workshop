// Every push the simulation's own code gives a rigid body outside the physics engine (the hand,
// propellers, wires pulled tight, gears and roller wheels), applied through here so the glue check
// (glue.ts) knows each one: where it pushed and how hard. The engine's own contacts and joints it
// works out itself.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

type RB = RAPIER_NS.RigidBody;
type V = { x: number; y: number; z: number };

export interface Kick {
  /** the rigid body's handle */
  h: number;
  /** an impulse (g*cm/s) at p, or a twist (g*cm^2/s) about the body (p: where it comes from) */
  f: THREE.Vector3 | null;
  t: THREE.Vector3 | null;
  p: THREE.Vector3;
}

/** while on, each kick is listed (glue.ts empties the list every step) */
export const kicks = { on: false, list: [] as Kick[] };

export function kickAt(rb: RB, imp: V, p: V) {
  rb.applyImpulseAtPoint(imp, p, true);
  if (kicks.on) kicks.list.push({ h: rb.handle, f: new THREE.Vector3(imp.x, imp.y, imp.z), t: null, p: new THREE.Vector3(p.x, p.y, p.z) });
}

export function kickTwist(rb: RB, timp: V, p?: V) {
  rb.applyTorqueImpulse(timp, true);
  if (kicks.on) {
    const at = p ?? rb.worldCom();
    kicks.list.push({ h: rb.handle, f: null, t: new THREE.Vector3(timp.x, timp.y, timp.z), p: new THREE.Vector3(at.x, at.y, at.z) });
  }
}
