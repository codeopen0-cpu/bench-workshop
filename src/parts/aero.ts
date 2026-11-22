// Things that fly (or blow): a brushless motor with its propeller, and the ESC that drives it.
// The thrust is the simulation's (sim.ts, thrusters), from the real propeller formulas; the ESC's
// behaviour (arming, the throttle signal, which way the phases turn it) is in elec/aero.ts.
import * as THREE from 'three';
import { boxMesh, cylMesh, group, mesh } from './geo';
import type { PartType, PinDef } from './types';

/** A propeller: two blades, and a faint disc shown instead of them once it spins fast. */
function propeller(diameterCm: number, color: string) {
  const r = diameterCm / 2;
  const blades = new THREE.Group();
  for (const s of [1, -1]) {
    const blade = mesh(new THREE.BoxGeometry(r * 0.92, 0.08, Math.max(0.5, r * 0.18)), color, (s * r * 0.92) / 2 + s * 0.2, 0, 0, { roughness: 0.5 });
    blade.rotation.x = s * 0.25; // (pitched)
    blades.add(blade);
  }
  blades.add(cylMesh(0.35, 0.5, '#2a2c31', 0, 0, 0, 16));
  blades.userData.prop = true;
  const disc = mesh(new THREE.CylinderGeometry(r, r, 0.02, 40), color, 0, 0, 0, { transparent: true, opacity: 0.18, depthWrite: false });
  disc.userData.propDisc = true;
  disc.visible = false;
  return group(blades, disc);
}

export const brushlessMotor: PartType = {
  id: 'brushless-prop',
  name: 'Brushless motor + propeller',
  category: 'Motion',
  description: 'A drone motor with its propeller: it blows air out of its bottom and pulls along its shaft (away from the face you put it on). Wire its three phase wires (A, B, C) to an ESC, and give the ESC a servo signal: low to arm it, then more for more thrust. A 2300 KV motor with a 5 inch prop on 4S (14.8 V) pulls about 650 g. Wired A-A, B-B, C-C it turns clockwise (seen from above); swap any two wires and it turns counter-clockwise: its propeller must be made for the way it turns. Its spin twists the frame the other way, so a quadcopter has two of each (CW props on straight-wired motors, CCW props on swapped ones).',
  swatch: '#d64545',
  params: [
    { key: 'kv', label: 'Motor KV (rpm per volt)', kind: 'number', min: 300, max: 6000, step: 50 },
    { key: 'prop', label: 'Propeller diameter', kind: 'number', min: 1.5, max: 15, step: 0.5, unit: 'inch' },
    { key: 'pitch', label: 'Propeller pitch', kind: 'number', min: 1, max: 10, step: 0.1, unit: 'inch' },
    { key: 'spin', label: 'Propeller made for', kind: 'select', options: [{ value: 'cw', label: 'clockwise (seen from above)' }, { value: 'ccw', label: 'counter-clockwise' }] },
    { key: 'color', label: 'Propeller colour', kind: 'color' },
  ],
  defaults: { kv: 2300, prop: 5, pitch: 4.3, spin: 'cw', color: '#d64545' },
  build: (p) => {
    const D = p.prop * 2.54; // cm
    // a motor sized for its propeller (a 5 inch prop: a 2306 motor, about 32 g)
    // (real ones grow slower than their props: 3 inch = 21 mm, 5 = 29 mm, 10 = 43 mm across)
    const size = Math.max(0.5, Math.min(2.2, (D / 12.7) ** 0.6));
    const r = 1.43 * size, h = 1.88 * size;
    const pins: PinDef[] = ['A', 'B', 'C'].map((id, i) => ({ id, label: `Phase ${id}`, body: 'case', pos: [-r * 0.6 + i * r * 0.6, 0.25, r + 0.25] as [number, number, number], kind: 'motor' as const }));
    const prop = propeller(D, p.color);
    prop.position.y = h + 0.5;
    return {
      pins,
      bodies: [{
        name: 'case', pos: [0, 0, 0], mass: 32 * size ** 2 + 0.25 * D,
        colliders: [{ shape: { kind: 'cylinder', halfHeight: h / 2, radius: r }, pos: [0, h / 2, 0] }],
        visual: group(
          cylMesh(r, h * 0.35, '#2a2c31', 0, h * 0.175, 0, 24), // the base
          mesh(new THREE.CylinderGeometry(r * 0.96, r * 0.96, h * 0.65, 24), '#b9bec7', 0, h * 0.675, 0, { metalness: 0.75, roughness: 0.3 }), // the bell
          cylMesh(0.16, 0.6, '#c7c9cc', 0, h + 0.3, 0, 12), // the shaft
          ...['#2a62c8', '#d0d0d0', '#d6453d'].map((c, i) => boxMesh(0.12, 0.12, 0.5, c, -r * 0.6 + i * r * 0.6, 0.15, r)), // phase wires
          prop,
        ),
      }],
      joints: [],
      thruster: { body: 'case', at: [0, h + 0.5, 0], axis: [0, 1, 0], kv: p.kv, propIn: p.prop, pitchIn: p.pitch, dir: p.spin === 'ccw' ? -1 : 1 },
    };
  },
};

export const esc: PartType = {
  id: 'esc',
  name: 'ESC (brushless speed controller)',
  category: 'Electronics',
  description: 'Drives a brushless motor from a battery (2S-6S, 7-26 V on BAT+ / BAT-), by the servo signal on SIG (Servo.writeMicroseconds: 1000 = stop, 2000 = full). On power-up it waits for a low signal (1000 us) to arm; with no signal for half a second it stops (failsafe). Its 5V pin powers a board (the BEC, 5 V up to 2 A). Wire A, B, C to the motor\'s A, B, C (two swapped = it turns the other way).',
  swatch: '#2a2c31',
  params: [{ key: 'amps', label: 'Rated current', kind: 'select', options: [{ value: '20', label: '20 A' }, { value: '30', label: '30 A' }, { value: '45', label: '45 A' }] }],
  defaults: { amps: '30' },
  build: () => {
    const w = 2.4, d = 4.2;
    const kinds: Record<string, PinDef['kind']> = { 'BAT+': 'vin', 'BAT-': 'gnd', GND: 'gnd', '5V': 'vout', SIG: 'in', A: 'motor', B: 'motor', C: 'motor' };
    const at: Record<string, [number, number, number]> = {
      'BAT+': [-0.4, 0.9, -d / 2 - 0.3], 'BAT-': [0.4, 0.9, -d / 2 - 0.3],
      SIG: [-0.6, 0.9, -d / 2 + 0.5], '5V': [0, 0.9, -d / 2 + 0.5], GND: [0.6, 0.9, -d / 2 + 0.5],
      A: [-0.7, 0.9, d / 2 + 0.3], B: [0, 0.9, d / 2 + 0.3], C: [0.7, 0.9, d / 2 + 0.3],
    };
    const extra: Record<string, Partial<PinDef>> = { 'BAT+': { label: 'BAT+ (7-26 V)', vmin: 6, vmax: 26 }, SIG: { label: 'SIG (servo pulses)' }, '5V': { label: '5V out (BEC)' } };
    return {
      pins: Object.entries(at).map(([id, pos]) => ({ id, body: 'body', pos, kind: kinds[id], ...(extra[id] ?? {}) })),
      bodies: [{
        name: 'body', pos: [0, 0.35, 0], mass: 25,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.35, hz: d / 2 } }],
        visual: group(
          boxMesh(w, 0.7, d, '#2a2c31'),
          boxMesh(w * 0.9, 0.05, d * 0.6, '#3b6fd6', 0, 0.37, 0), // the shrink wrap's label
          boxMesh(0.2, 0.2, 0.7, '#d6453d', -0.4, 0.2, -d / 2 - 0.3), boxMesh(0.2, 0.2, 0.7, '#202226', 0.4, 0.2, -d / 2 - 0.3),
          ...[-0.7, 0, 0.7].map((x) => boxMesh(0.18, 0.18, 0.7, '#202226', x, 0.2, d / 2 + 0.3)),
        ),
      }],
      joints: [],
    };
  },
};

export const AERO: PartType[] = [brushlessMotor, esc];
