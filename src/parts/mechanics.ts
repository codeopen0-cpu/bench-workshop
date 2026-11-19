// Mechanical parts: gears, pulleys (with belts), a free axle, a tank track with its own motor, and
// mecanum and omni wheels. What makes them work together is in mechanics.ts (the simulation side).
import * as THREE from 'three';
import { boxMesh, cylMesh, group, mesh } from './geo';
import type { PartType, Q4 } from './types';

const ROT_Y_TO_X: Q4 = [0, 0, -Math.SQRT1_2, Math.SQRT1_2]; // -90 deg about Z: a body's Y axis becomes X
const PLASTIC = 1.2; // g/cm^3

/** A spur gear's outline: `teeth` teeth of module `m` (cm), with a bore; extruded `t` thick along Y. */
function gearGeometry(teeth: number, m: number, t: number) {
  const r = (m * teeth) / 2, ra = r + m, rf = Math.max(0.05, r - 1.25 * m);
  const s = new THREE.Shape();
  const pitch = (2 * Math.PI) / teeth;
  for (let k = 0; k < teeth; k++) {
    const a = k * pitch;
    const root = pitch * 0.27, tip = pitch * 0.15; // (half-widths: wide at the root, narrow at the tip)
    const pts: [number, number][] = [[rf, a - root], [ra, a - tip], [ra, a + tip], [rf, a + root], [rf, a + pitch / 2]];
    pts.forEach(([rr, ang], i) => {
      const x = rr * Math.cos(ang), y = rr * Math.sin(ang);
      if (k === 0 && i === 0) s.moveTo(x, y);
      else s.lineTo(x, y);
    });
  }
  s.closePath();
  const bore = new THREE.Path();
  bore.absarc(0, 0, Math.min(0.25, rf * 0.4), 0, Math.PI * 2, true);
  s.holes.push(bore);
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 12 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -t / 2, 0);
  g.computeVertexNormals();
  return g;
}

export const gear: PartType = {
  id: 'gear',
  name: 'Gear',
  category: 'Motion',
  description: 'A spur gear. Put it on a motor hub, a servo horn or an axle (its axle lines up with the face you put it on). Two gears mesh when their teeth reach each other: same module, axles side by side, as far apart as their pitch radii added up (radius = module x teeth / 2). They then turn opposite ways: 10 teeth driving 30 turns it 3x slower and 3x stronger.',
  swatch: '#d9d9d9',
  params: [
    { key: 'teeth', label: 'Teeth', kind: 'number', min: 6, max: 150, step: 1 },
    { key: 'module', label: 'Module (tooth size)', kind: 'number', min: 0.03, max: 0.6, step: 0.01, unit: 'cm' },
    { key: 'thickness', label: 'Thickness', kind: 'number', min: 0.1, max: 5, step: 0.05, unit: 'cm' },
    { key: 'color', label: 'Colour', kind: 'color' },
  ],
  defaults: { teeth: 20, module: 0.1, thickness: 0.5, color: '#d9d9d9' },
  build: (p) => {
    const teeth = Math.round(p.teeth), m = p.module, t = p.thickness;
    const r = (m * teeth) / 2;
    return {
      bodies: [{
        name: 'body', pos: [0, t / 2, 0], mass: Math.max(0.3, Math.PI * r * r * t * PLASTIC * 0.85),
        // (solid inside its teeth only: two meshing gears don't push each other apart; the teeth's
        //  work is done by the mesh, in mechanics.ts)
        colliders: [{ shape: { kind: 'cylinder', halfHeight: t / 2, radius: Math.max(0.05, r - 1.25 * m) } }],
        visual: group(mesh(gearGeometry(teeth, m, t), p.color, 0, 0, 0, { roughness: 0.45, metalness: 0.1 })),
      }],
      joints: [],
      mech: [{ kind: 'gear', body: 'body', at: [0, 0, 0], axis: [0, 1, 0], radius: r, teeth, width: t }],
    };
  },
};

export const pulley: PartType = {
  id: 'pulley',
  name: 'Pulley',
  category: 'Motion',
  description: 'A belt pulley. Put it on a motor hub, a servo horn or an axle, then select it and press "Belt to..." and click another pulley: the belt makes them turn together, the same way, by their sizes (a 1 cm pulley driving a 3 cm one turns it 3x slower).',
  swatch: '#9aa3ad',
  params: [
    { key: 'r', label: 'Radius (to the belt)', kind: 'number', min: 0.3, max: 15, step: 0.05, unit: 'cm' },
    { key: 'width', label: 'Width', kind: 'number', min: 0.2, max: 5, step: 0.05, unit: 'cm' },
    { key: 'color', label: 'Colour', kind: 'color' },
  ],
  defaults: { r: 1.5, width: 0.8, color: '#9aa3ad' },
  build: (p) => {
    const r = p.r, w = p.width, f = Math.min(0.25, r * 0.15);
    return {
      bodies: [{
        name: 'body', pos: [0, w / 2, 0], mass: Math.max(0.3, Math.PI * r * r * w * PLASTIC * 0.5),
        colliders: [{ shape: { kind: 'cylinder', halfHeight: w / 2, radius: r + f } }],
        visual: group(
          cylMesh(r, w * 0.8, p.color, 0, 0, 0, 40),
          cylMesh(r + f, 0.08, p.color, 0, w / 2 - 0.04, 0, 40),
          cylMesh(r + f, 0.08, p.color, 0, -w / 2 + 0.04, 0, 40),
          cylMesh(Math.min(0.35, r * 0.4), w * 1.02, '#4a4f57', 0, 0, 0, 16),
        ),
      }],
      joints: [],
      mech: [{ kind: 'pulley', body: 'body', at: [0, 0, 0], axis: [0, 1, 0], radius: r }],
    };
  },
};

export const axle: PartType = {
  id: 'axle',
  name: 'Axle (free)',
  category: 'Motion',
  description: 'A shaft turning freely in a bearing block: for the gears, pulleys and wheels that aren\'t on a motor. Put the block on something; the shaft sticks out of it (away from the face), and gears and pulleys go on its end.',
  swatch: '#b9bec7',
  params: [
    { key: 'length', label: 'Shaft length', kind: 'number', min: 0.5, max: 30, step: 0.1, unit: 'cm' },
    { key: 'friction', label: 'Bearing friction (kg*cm)', kind: 'number', min: 0, max: 2, step: 0.0005 },
  ],
  defaults: { length: 2.5, friction: 0.0005 }, // (a small ball bearing: light gears spin on)
  mountBody: 'base',
  build: (p) => {
    const hb = 1.0, L = p.length;
    return {
      bodies: [
        { name: 'base', pos: [0, 0, 0], mass: 6, colliders: [{ shape: { kind: 'box', hx: 0.8, hy: hb / 2, hz: 0.8 }, pos: [0, hb / 2, 0] }],
          visual: group(boxMesh(1.6, hb, 1.6, '#4a4f57', 0, hb / 2, 0), cylMesh(0.45, 0.1, '#b9bec7', 0, hb + 0.03, 0, 24)) },
        { name: 'shaft', pos: [0, hb + L / 2, 0], mass: Math.max(0.5, Math.PI * 0.09 * L * 7.8 * 0.4),
          colliders: [{ shape: { kind: 'cylinder', halfHeight: L / 2, radius: 0.3 } }],
          visual: group(mesh(new THREE.CylinderGeometry(0.3, 0.3, L, 20), '#c7c9cc', 0, 0, 0, { metalness: 0.7, roughness: 0.3 })) },
      ],
      joints: [{ kind: 'revolute', name: 'bearing', a: 'base', b: 'shaft', anchor: [0, hb, 0], axis: [0, 1, 0], actuator: { kind: 'free', maxTorque: p.friction, speed: 0, ratedVolts: 1 } }],
    };
  },
};

// ------------------------------------------------------------------------------------------ tank track
export interface TrackLook { links: THREE.Mesh[]; zr: number; zf: number; yc: number; rc: number; len: number }
/** A tank track's links: spaced round its loop (along the bottom to the front, over the top, round
 *  the back), moved on as far as the sprocket has turned (`turned`, rad). */
export function placeTrackLinks(d: TrackLook, turned: number) {
  const n = d.links.length, straight = d.zf - d.zr, arc = Math.PI * d.rc;
  // (the sprocket turning forward: its bottom links go back along the frame, staying still on the
  //  ground, and the top ones go forward; checked 2026-11-16)
  const off = (((-turned * d.rc) % d.len) + d.len) % d.len;
  for (let i = 0; i < n; i++) {
    let s = ((i * d.len) / n + off) % d.len;
    let z: number, y: number, dz: number, dy: number;
    if (s < straight) { z = d.zr + s; y = d.yc - d.rc; dz = 1; dy = 0; }
    else if ((s -= straight) < arc) { const a = -Math.PI / 2 + s / d.rc; z = d.zf + d.rc * Math.cos(a); y = d.yc + d.rc * Math.sin(a); dz = -Math.sin(a); dy = Math.cos(a); }
    else if ((s -= arc) < straight) { z = d.zf - s; y = d.yc + d.rc; dz = -1; dy = 0; }
    else { s -= straight; const a = Math.PI / 2 + s / d.rc; z = d.zr + d.rc * Math.cos(a); y = d.yc + d.rc * Math.sin(a); dz = -Math.sin(a); dy = Math.cos(a); }
    const link = d.links[i];
    link.position.set(0, y, z);
    link.rotation.set(Math.atan2(-dy, dz), 0, 0);
  }
}
/** where a tank track's wheels go: radius, the rear (sprocket) and front centres, the road wheels */
export function trackLayout(L: number, R: number) {
  const zr = -L / 2 + R, zf = L / 2 - R;
  const n = Math.max(0, Math.floor((zf - zr) / (2 * R + 0.3)) - 1);
  const zs = [zr, ...Array.from({ length: n }, (_, i) => zr + ((zf - zr) * (i + 1)) / (n + 1)), zf];
  return { zr, zf, zs };
}
export const tankTrack: PartType = {
  id: 'tank-track',
  name: 'Tank track (with motor)',
  category: 'Motion',
  description: 'A rubber track around its wheels, driven by its own gear motor (wire M+ and M- through a motor driver, as a TT motor: about 160 rpm and 3 kg*cm at 6 V). It always stands upright: put it on the bench and a chassis on top of two of them, or put it on a chassis\' underside and it hangs below it. Two tracks steer by driving one faster (or backwards), like a tank.',
  swatch: '#30333a',
  params: [
    { key: 'length', label: 'Length', kind: 'number', min: 6, max: 60, step: 0.5, unit: 'cm' },
    { key: 'r', label: 'Wheel radius (to the track)', kind: 'number', min: 0.8, max: 6, step: 0.1, unit: 'cm' },
    { key: 'width', label: 'Width', kind: 'number', min: 1, max: 10, step: 0.1, unit: 'cm' },
    { key: 'grip', label: 'Grip (friction)', kind: 'number', min: 0, max: 3, step: 0.05 },
  ],
  defaults: { length: 14, r: 1.6, width: 2.4, grip: 1.5 },
  mountBody: 'frame',
  upright: (p) => 2 * p.r + 0.7,
  build: (p) => {
    const L = p.length, R = p.r, W = p.width;
    const { zr, zf, zs } = trackLayout(L, R);
    const yf = 2 * R + 0.45; // the frame beam's centre (over the track)
    // the track itself: links along the loop round the wheels (moved as it runs: sim.ts, sync)
    const rc = R - 0.12, yc = R - yf, pitch = 0.62;
    const len = 2 * (zf - zr) + 2 * Math.PI * rc;
    const n = Math.max(8, Math.floor(len / pitch));
    const links: THREE.Mesh[] = [];
    for (let i = 0; i < n; i++) links.push(boxMesh(W, 0.22, (len / n) * 0.82, i % 2 ? '#26282d' : '#1d1f23'));
    const frameVis = group(
      boxMesh(W, 0.4, L - 2 * R + 1.2, '#4a4f57'),
      boxMesh(0.15, 2 * R - 0.2, L - 2 * R, '#3b3f46', -W / 2 - 0.12, -R + 0.1, 0),
      boxMesh(0.15, 2 * R - 0.2, L - 2 * R, '#3b3f46', W / 2 + 0.12, -R + 0.1, 0),
      boxMesh(1.2, 0.9, 2.6, '#e8c547', 0, 0.65, zr + 1.0), // the gear motor on top, over the sprocket
      ...links,
    );
    const look: TrackLook = { links, zr, zf, yc, rc, len };
    placeTrackLinks(look, 0);
    frameVis.userData.track = look;
    const wheels = zs.map((z, i) => ({
      name: i === 0 ? 'sprocket' : `wheel${i}`,
      pos: [0, R, z] as [number, number, number], rot: ROT_Y_TO_X, mass: i === 0 ? 12 : 8,
      // (its grip is the simulation's: along the track, less sideways; see mechanics.ts)
      colliders: [{ shape: { kind: 'cylinder' as const, halfHeight: W / 2, radius: R }, friction: 0, frictionMin: true }],
      visual: group(
        cylMesh(R - 0.25, W * 0.7, i === 0 ? '#5a5f68' : '#6b717c', 0, 0, 0, 24),
        cylMesh((R - 0.25) * 0.45, W * 0.72, '#e8c547', 0, 0, 0, 12),
      ),
    }));
    return {
      pins: [
        { id: 'M+', label: 'Motor +', body: 'frame', pos: [-0.3, 1.25, zr + 1.0], kind: 'motor' },
        { id: 'M-', label: 'Motor -', body: 'frame', pos: [0.3, 1.25, zr + 1.0], kind: 'motor' },
      ],
      bodies: [
        { name: 'frame', pos: [0, yf, 0], mass: 45, colliders: [{ shape: { kind: 'box', hx: W / 2, hy: 0.2, hz: (L - 2 * R + 1.2) / 2 } }], visual: frameVis },
        ...wheels,
      ],
      joints: wheels.map((w, i) => ({
        kind: 'revolute' as const, name: w.name, a: 'frame', b: w.name, anchor: w.pos, axis: [1, 0, 0] as [number, number, number],
        actuator: i === 0 ? { kind: 'motor' as const, maxTorque: 3, speed: 16.8, ratedVolts: 6 } : { kind: 'free' as const, maxTorque: 0.02, speed: 0, ratedVolts: 1 },
      })),
      // every wheel turns with the sprocket (the track goes round them all)
      mech: wheels.map((w) => ({ kind: 'chain' as const, body: w.name, at: [0, 0, 0] as [number, number, number], axis: [0, 1, 0] as [number, number, number], radius: R, group: 0 })),
    };
  },
};

// ------------------------------------------------------------------------------------------ roller wheels
function rollerWheel(kind: 'mecanum' | 'omni'): PartType {
  const mec = kind === 'mecanum';
  return {
    id: `${kind}-wheel`,
    name: mec ? 'Mecanum wheel' : 'Omni wheel',
    category: 'Motion',
    description: mec
      ? 'A wheel of rollers set at 45 degrees: it pushes diagonally. Four of them let a robot drive any way: forward (all forward), sideways (front-left and rear-right forward, the other two backward), turning on the spot. Put "left (A)" wheels at the front-left and rear-right, "right (B)" at the front-right and rear-left. Put it on a motor hub.'
      : 'A wheel with rollers round its rim: it grips the way it rolls and slides freely sideways. Three at 120 degrees (or four at 90) let a robot drive any way. Put it on a motor hub.',
    swatch: mec ? '#c8a23a' : '#5aa0d8',
    params: [
      { key: 'r', label: 'Radius', kind: 'number', min: 1, max: 15, step: 0.1, unit: 'cm' },
      { key: 'width', label: 'Width', kind: 'number', min: 0.5, max: 8, step: 0.1, unit: 'cm' },
      ...(mec ? [{ key: 'hand', label: 'Rollers lean', kind: 'select' as const, options: [{ value: 'L', label: 'left (A)' }, { value: 'R', label: 'right (B)' }] }] : []),
      { key: 'grip', label: 'Grip (friction)', kind: 'number', min: 0, max: 3, step: 0.05 },
    ],
    defaults: { r: 3, width: 2.5, ...(mec ? { hand: 'L' } : {}), grip: 1 },
    build: (p) => {
      const r = p.r, w = p.width, rr = Math.max(0.15, r * 0.14);
      // (which way its rollers lean, as the simulation counts it: checked with a 4-wheel robot that
      //  strafes straight with A at front-left and rear-right, B at front-right and rear-left)
      const sign = mec ? (p.hand === 'L' ? -1 : 1) : 0;
      const n = mec ? 10 : 12;
      const rollers: THREE.Object3D[] = [];
      const Y = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const tangent = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
        const dir = mec ? tangent.clone().multiplyScalar(Math.SQRT1_2).add(Y.clone().multiplyScalar(sign * Math.SQRT1_2)).normalize() : tangent;
        const len = mec ? w * 1.25 : (2 * Math.PI * (r - rr)) / n * 0.8;
        const roller = mesh(new THREE.CapsuleGeometry(rr, Math.max(0.05, len - 2 * rr), 4, 10), '#2a2c31', (r - rr) * Math.cos(a), 0, (r - rr) * Math.sin(a), { roughness: 0.9 });
        roller.quaternion.setFromUnitVectors(Y, dir);
        rollers.push(roller);
        if (!mec) { // (an omni wheel: a second, staggered row)
          const b = a + Math.PI / n;
          const t2 = new THREE.Vector3(-Math.sin(b), 0, Math.cos(b));
          const r2 = mesh(new THREE.CapsuleGeometry(rr, Math.max(0.05, len - 2 * rr), 4, 10), '#2a2c31', (r - rr) * Math.cos(b), w * 0.22 * (i % 2 ? 1 : -1), (r - rr) * Math.sin(b), { roughness: 0.9 });
          r2.quaternion.setFromUnitVectors(Y, t2);
          rollers.push(r2);
        }
      }
      return {
        bodies: [{
          name: 'body', pos: [0, w / 2, 0], mass: 40 * (r / 3) ** 2 * (w / 2.5),
          // (its own friction is none: the rollers' one-way grip is added by the simulation)
          colliders: [{ shape: { kind: 'cylinder', halfHeight: w / 2, radius: r }, friction: 0, frictionMin: true }],
          visual: group(
            cylMesh(r * 0.62, w * 0.9, mec ? '#c8a23a' : '#5aa0d8', 0, 0, 0, 24),
            cylMesh(r * 0.25, w * 1.02, '#4a4f57', 0, 0, 0, 16),
            ...rollers,
          ),
        }],
        joints: [],
        mech: [{ kind, body: 'body', at: [0, 0, 0], axis: [0, 1, 0], radius: r, group: sign || undefined }],
      };
    },
  };
}
export const mecanumWheel = rollerWheel('mecanum');
export const omniWheel = rollerWheel('omni');

export const MECHANICS: PartType[] = [gear, pulley, axle, tankTrack, mecanumWheel, omniWheel];
