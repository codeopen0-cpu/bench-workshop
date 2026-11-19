// Brushless motors with propellers, in the simulation. The rotor isn't a physics body (25 000 rpm is
// far too fast for 240 steps a second): its speed is a number that follows the ESC's throttle with
// the time a real one takes to spin up, and its thrust and twist come from the propeller formulas
//   thrust T = Ct * rho * n^2 * D^4      twist Q = Cq * rho * n^2 * D^5
// (n: turns a second, D: diameter in metres, rho: air). A 5 inch prop on a 2300 KV motor at 14.8 V:
// about 27 000 rpm loaded and 650 g of thrust, as on a real thrust stand.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { ThrusterDef } from './parts/types';
import type { PartView } from './views';

const RHO = 1.225; // kg/m^3
export interface Thruster {
  view: PartView;
  def: ThrusterDef;
  rb: RAPIER_NS.RigidBody;
  local: THREE.Vector3; // the propeller's centre, in the rigid body's frame
  axisL: THREE.Vector3;
  /** from its ESC: 0..1, the battery's volts, and which way the phases turn it (1 / -1) */
  throttle: number;
  volts: number;
  phase: 1 | -1;
  /** rotor speed, rad/s (signed: + the way its propeller is made for), and its drawing */
  omega: number;
  angle: number;
  blades: THREE.Object3D[];
  discs: THREE.Object3D[];
  /** last step: thrust (N), twist (N*m), power (W) */
  thrust: number;
  torque: number;
  power: number;
}

/** the coefficients of a propeller of this diameter and pitch (inches) */
function coeffs(propIn: number, pitchIn: number) {
  const ratio = pitchIn / Math.max(0.5, propIn);
  const ct = Math.max(0.04, 0.09 + 0.04 * (ratio - 0.86));
  return { ct, cq: ct * (0.06 + 0.04 * ratio) };
}

export function stepThruster(t: Thruster, dt: number) {
  const { ct, cq } = coeffs(t.def.propIn, t.def.pitchIn);
  const D = t.def.propIn * 0.0254;
  // under load a motor turns at about 80 % of KV x volts; a 5 inch prop spins up in about 60 ms
  // (the phases' order sets which way the motor turns: 1 = clockwise seen from above; it pushes
  //  well only if that's the way its propeller is made for)
  const target = t.throttle * t.def.kv * t.volts * 0.8 * ((2 * Math.PI) / 60) * t.phase * t.def.dir;
  const tau = 0.03 + 0.012 * t.def.propIn;
  t.omega += (target - t.omega) * Math.min(1, dt / tau);
  const n = t.omega / (2 * Math.PI);
  // (omega counts the way its propeller is made to turn; backwards, its phases swapped, it pushes
  //  the other way and less well)
  t.thrust = ct * RHO * n * n * D ** 4 * (n >= 0 ? 1 : -0.6);
  // the twist on the frame: against the way it really spins (clockwise seen from above = 1)
  const spin = t.def.dir * Math.sign(n);
  t.torque = cq * RHO * n * n * D ** 5 * spin;
  t.power = Math.abs(t.torque * t.omega);
  const r = t.rb.rotation(), p = t.rb.translation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const axis = t.axisL.clone().applyQuaternion(q).normalize();
  const at = t.local.clone().applyQuaternion(q).add(new THREE.Vector3(p.x, p.y, p.z));
  if (t.rb.isDynamic()) {
    // newtons -> g*cm/s^2 (x 1e5); newton-metres -> g*cm^2/s^2 (x 1e7)
    const f = axis.clone().multiplyScalar(t.thrust * 1e5 * dt);
    t.rb.applyImpulseAtPoint({ x: f.x, y: f.y, z: f.z }, { x: at.x, y: at.y, z: at.z }, true);
    // the air holds the propeller back, so the motor's case (the frame) turns against its spin: a
    // clockwise propeller (seen from above) turns the frame anticlockwise, about +axis
    const tq = axis.clone().multiplyScalar(t.torque * 1e7 * dt);
    t.rb.applyTorqueImpulse({ x: tq.x, y: tq.y, z: tq.z }, true);
  }
  t.angle += -t.def.dir * t.omega * dt; // (clockwise seen from above: about -Y)
}

/** Draw the propeller: its blades turning, or a faint disc once it's a blur. */
export function drawThruster(t: Thruster) {
  const fast = Math.abs(t.omega) > 60;
  for (const b of t.blades) {
    b.visible = !fast;
    b.rotation.y = t.angle;
  }
  for (const d of t.discs) d.visible = fast;
}
