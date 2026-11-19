// The built-in parts bin. Every part's origin is the middle of the face it sits on, and its +Y
// points away from whatever it is placed on, so placing = "put this face on that surface".
import * as THREE from 'three';
import { ELECTRONICS } from './electronics';
import { POWER } from './power';
import { boxMesh, cylMesh, group, mesh } from './geo';
import { servoCaseLook, servoHornLook, servoLeadLook } from './servoLook';
import type { BodyDef, PartType, Q4 } from './types';

const MATERIALS: Record<string, { label: string; density: number }> = {
  plastic: { label: 'Plastic / PLA (1.24 g/cm3)', density: 1.24 },
  wood: { label: 'Wood / plywood (0.6)', density: 0.6 },
  aluminium: { label: 'Aluminium (2.7)', density: 2.7 },
  steel: { label: 'Steel (7.85)', density: 7.85 },
  foam: { label: 'Foam (0.05)', density: 0.05 },
  cardboard: { label: 'Cardboard (0.7)', density: 0.7 },
};
const materialOptions = Object.entries(MATERIALS).map(([value, m]) => ({ value, label: m.label }));

const ROT_Y_TO_Z: Q4 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // +90 deg about X: the body's Y axis becomes Z

const boxVolume = (w: number, h: number, d: number) => w * h * d;

// ---------------------------------------------------------------------------------------- structure

const block: PartType = {
  id: 'block',
  name: 'Block',
  category: 'Structure',
  description: 'A solid block. Glue things onto it, or use it as a body, a base or a weight.',
  swatch: '#c98a4b',
  params: [
    { key: 'w', label: 'Width', kind: 'number', min: 0.2, max: 200, step: 0.1, unit: 'cm' },
    { key: 'h', label: 'Height', kind: 'number', min: 0.1, max: 200, step: 0.1, unit: 'cm' },
    { key: 'd', label: 'Depth', kind: 'number', min: 0.2, max: 200, step: 0.1, unit: 'cm' },
    { key: 'material', label: 'Material', kind: 'select', options: materialOptions },
    { key: 'color', label: 'Colour', kind: 'color' },
  ],
  defaults: { w: 6, h: 3, d: 4, material: 'wood', color: '#c98a4b' },
  build: (p) => ({
    bodies: [
      {
        name: 'body',
        pos: [0, p.h / 2, 0],
        mass: boxVolume(p.w, p.h, p.d) * MATERIALS[p.material].density,
        colliders: [{ shape: { kind: 'box', hx: p.w / 2, hy: p.h / 2, hz: p.d / 2 } }],
        visual: boxMesh(p.w, p.h, p.d, p.color),
      },
    ],
    joints: [],
  }),
};

const plate: PartType = {
  ...block,
  id: 'plate',
  name: 'Plate',
  description: 'A flat sheet (a chassis, a deck, a bracket). Same as a block, just thin.',
  swatch: '#8fa3b8',
  defaults: { w: 12, h: 0.3, d: 9, material: 'plastic', color: '#8fa3b8' },
};

const rod: PartType = {
  id: 'rod',
  name: 'Rod',
  category: 'Structure',
  description: 'A round rod or post, standing up from where it is placed.',
  swatch: '#b0b6c2',
  params: [
    { key: 'r', label: 'Radius', kind: 'number', min: 0.05, max: 50, step: 0.05, unit: 'cm' },
    { key: 'len', label: 'Length', kind: 'number', min: 0.2, max: 300, step: 0.1, unit: 'cm' },
    { key: 'material', label: 'Material', kind: 'select', options: materialOptions },
    { key: 'color', label: 'Colour', kind: 'color' },
  ],
  defaults: { r: 0.4, len: 8, material: 'aluminium', color: '#b0b6c2' },
  build: (p) => ({
    bodies: [
      {
        name: 'body',
        pos: [0, p.len / 2, 0],
        mass: Math.PI * p.r * p.r * p.len * MATERIALS[p.material].density,
        colliders: [{ shape: { kind: 'cylinder', halfHeight: p.len / 2, radius: p.r } }],
        visual: cylMesh(p.r, p.len, p.color),
      },
    ],
    joints: [],
  }),
};

const ball: PartType = {
  id: 'ball',
  name: 'Ball',
  category: 'Structure',
  description: 'A ball: to roll, to throw at your robot, or as a test load.',
  swatch: '#e05d5d',
  params: [
    { key: 'r', label: 'Radius', kind: 'number', min: 0.1, max: 50, step: 0.1, unit: 'cm' },
    { key: 'material', label: 'Material', kind: 'select', options: materialOptions },
    { key: 'color', label: 'Colour', kind: 'color' },
  ],
  defaults: { r: 2, material: 'plastic', color: '#e05d5d' },
  build: (p) => ({
    bodies: [
      {
        name: 'body',
        pos: [0, p.r, 0],
        mass: (4 / 3) * Math.PI * p.r ** 3 * MATERIALS[p.material].density,
        colliders: [{ shape: { kind: 'ball', radius: p.r }, restitution: 0.4 }],
        visual: mesh(new THREE.SphereGeometry(p.r, 32, 20), p.color),
      },
    ],
    joints: [],
  }),
};

// ---------------------------------------------------------------------------------------- motion

const wheel: PartType = {
  id: 'wheel',
  name: 'Wheel',
  category: 'Motion',
  description: 'A rubber-tyred wheel. Put it on a motor hub or a servo horn: its axle lines up with the face you put it on.',
  swatch: '#30333a',
  params: [
    { key: 'r', label: 'Radius', kind: 'number', min: 0.5, max: 30, step: 0.1, unit: 'cm' },
    { key: 'width', label: 'Width', kind: 'number', min: 0.2, max: 10, step: 0.1, unit: 'cm' },
    { key: 'grip', label: 'Grip (friction)', kind: 'number', min: 0, max: 3, step: 0.05 },
  ],
  defaults: { r: 3.3, width: 2.6, grip: 1.2 },
  build: (p) => {
    const tyre = cylMesh(p.r, p.width, '#25272c', 0, 0, 0, 40);
    const hub = cylMesh(p.r * 0.45, p.width * 1.02, '#e8c547', 0, 0, 0, 24);
    const spoke = boxMesh(p.r * 1.5, p.width * 1.03, p.r * 0.18, '#e8c547');
    return {
      bodies: [
        {
          name: 'body',
          pos: [0, p.width / 2, 0],
          mass: 22 * (p.r / 3.3) ** 2 * (p.width / 2.6),
          colliders: [{ shape: { kind: 'cylinder', halfHeight: p.width / 2, radius: p.r }, friction: p.grip }],
          visual: group(tyre, hub, spoke),
        },
      ],
      joints: [],
    };
  },
};

const caster: PartType = {
  id: 'caster',
  name: 'Ball caster',
  category: 'Motion',
  description: 'A slippery ball under a small holder: the third "wheel" of a two-wheeled robot.',
  swatch: '#9aa0aa',
  params: [{ key: 'r', label: 'Ball radius', kind: 'number', min: 0.3, max: 3, step: 0.05, unit: 'cm' }],
  defaults: { r: 0.8 },
  build: (p) => {
    const holderH = p.r * 1.2;
    return {
      bodies: [
        {
          name: 'body',
          pos: [0, 0, 0],
          mass: 12,
          colliders: [
            { shape: { kind: 'box', hx: p.r * 1.3, hy: holderH / 2, hz: p.r * 1.3 }, pos: [0, holderH / 2, 0] },
            // the ball sticks out on the far side (+Y): flip the caster onto the underside of a chassis
            { shape: { kind: 'ball', radius: p.r }, pos: [0, holderH + p.r * 0.6, 0], friction: 0.02, restitution: 0 },
          ],
          visual: group(
            boxMesh(p.r * 2.6, holderH, p.r * 2.6, '#6b717c', 0, holderH / 2, 0),
            mesh(new THREE.SphereGeometry(p.r, 24, 16), '#d9dde4', 0, holderH + p.r * 0.6, 0, { metalness: 0.8, roughness: 0.25 }),
          ),
        },
      ],
      joints: [],
    };
  },
};

interface ServoSpec {
  id: string;
  name: string;
  description: string;
  w: number; h: number; d: number; // case
  ear: number; earY: number; // mounting ears: length each side, height
  shaftX: number; // output shaft offset along X from the centre
  boss: number; // height of the round boss on top
  horn: number; // horn arm length
  mass: number;
  torque: number; // kg*cm
  speed: number; // rad/s
  volts: number;
  color: string;
  model: string; // on its sticker
  sticker: string;
  clear?: boolean; // see-through case
  metalSpline?: boolean;
}

function servoType(s: ServoSpec): PartType {
  return {
    id: s.id,
    name: s.name,
    category: 'Motion',
    description: s.description,
    swatch: s.color,
    params: [{ key: 'start', label: 'Horn angle at start', kind: 'number', min: -90, max: 90, step: 1, unit: 'deg' }],
    defaults: { start: 0 },
    mountBody: 'case',
    build: (p) => {
      const topY = s.h + s.boss;
      const hornT = Math.max(0.15, s.d * 0.12);
      const start = (p.start * Math.PI) / 180;
      const caseBody: BodyDef = {
        name: 'case',
        pos: [0, 0, 0],
        mass: s.mass * 0.92,
        colliders: [
          { shape: { kind: 'box', hx: s.w / 2, hy: s.h / 2, hz: s.d / 2 }, pos: [0, s.h / 2, 0] },
          { shape: { kind: 'box', hx: s.w / 2 + s.ear, hy: 0.12, hz: s.d / 2 }, pos: [0, s.earY, 0] },
        ],
        visual: servoCaseLook(s),
      };
      const hornBody: BodyDef = {
        name: 'horn',
        pos: [s.shaftX, topY + hornT / 2, 0],
        rot: [0, Math.sin(start / 2), 0, Math.cos(start / 2)],
        mass: s.mass * 0.08,
        colliders: [
          { shape: { kind: 'cylinder', halfHeight: hornT / 2, radius: s.d * 0.32 } },
          { shape: { kind: 'box', hx: s.horn / 2, hy: hornT / 2, hz: s.d * 0.18 }, pos: [s.horn / 2, 0, 0] },
        ],
        visual: servoHornLook(s, hornT),
      };
      // the three-wire lead (brown GND, red V+, orange signal) ends in a plug beside the case
      const plugX = -s.w / 2 - 0.55;
      caseBody.visual.add(servoLeadLook(s, plugX, 0.45));
      return {
        pins: [
          { id: 'GND', label: 'GND (brown)', body: 'case', pos: [plugX - 0.25, 0.45, -0.25], kind: 'gnd' },
          { id: 'V+', label: 'V+ (red)', body: 'case', pos: [plugX - 0.25, 0.45, 0], kind: 'vin', vmin: 4, vmax: s.volts > 5 ? 7.4 : 6.5 },
          { id: 'SIG', label: 'Signal (orange)', body: 'case', pos: [plugX - 0.25, 0.45, 0.25], kind: 'in' },
        ],
        bodies: [caseBody, hornBody],
        joints: [
          {
            kind: 'revolute',
            name: 'shaft',
            a: 'case',
            b: 'horn',
            anchor: [s.shaftX, topY, 0],
            axis: [0, 1, 0],
            actuator: {
              kind: 'servo',
              maxTorque: s.torque,
              speed: s.speed,
              minAngle: -Math.PI / 2,
              maxAngle: Math.PI / 2,
              ratedVolts: s.volts,
            },
          },
        ],
      };
    },
  };
}

const sg90 = servoType({
  id: 'servo-sg90',
  name: 'Servo SG90 (micro)',
  description: 'The common 9 g micro servo: 1.8 kg*cm at 4.8 V, 180 deg travel. Glue things to its horn to move them.',
  w: 2.3, h: 2.25, d: 1.22, ear: 0.45, earY: 1.6, shaftX: 0.55, boss: 0.4, horn: 1.6,
  mass: 9, torque: 1.8, speed: 10.5, volts: 4.8, color: '#3d6fd8',
  model: 'SG90', sticker: '#1d4fb8', clear: true,
});
const mg996 = servoType({
  id: 'servo-mg996r',
  name: 'Servo MG996R (standard)',
  description: 'A standard-size metal-gear servo: 10 kg*cm at 6 V, 55 g. For arms and legs that lift real weight.',
  w: 4.07, h: 3.78, d: 1.97, ear: 0.7, earY: 2.8, shaftX: 1.0, boss: 0.5, horn: 2.4,
  mass: 55, torque: 10, speed: 7.5, volts: 6, color: '#202226',
  model: 'MG996R', sticker: '#2c5fd1', metalSpline: true,
});

const ttMotor: PartType = {
  id: 'motor-tt',
  name: 'Gear motor (TT, 1:48)',
  description: 'The yellow hobby gear motor: about 200 rpm and 0.8 kg*cm at 6 V. Put a wheel on its hub.',
  category: 'Motion',
  swatch: '#e8c547',
  params: [],
  defaults: {},
  mountBody: 'case',
  build: () => {
    const L = 6.4, H = 2.2, D = 1.9;
    const hubLen = 0.9;
    return {
      pins: [ // the two solder tabs on the motor's end cap
        { id: 'M+', label: 'Motor +', body: 'case', pos: [L / 2 + 0.05, H / 2 + 0.45, 0], kind: 'motor' },
        { id: 'M-', label: 'Motor -', body: 'case', pos: [L / 2 + 0.05, H / 2 - 0.45, 0], kind: 'motor' },
      ],
      bodies: [
        {
          name: 'case',
          pos: [0, 0, 0],
          mass: 28,
          colliders: [{ shape: { kind: 'box', hx: L / 2, hy: H / 2, hz: D / 2 }, pos: [0, H / 2, 0] }],
          visual: group(
            boxMesh(L * 0.62, H, D, '#e8c547', -L * 0.19, H / 2, 0),
            mesh(new THREE.CylinderGeometry(H * 0.42, H * 0.42, L * 0.4, 24), '#c7c9cc', L * 0.3, H / 2, 0, { metalness: 0.7, roughness: 0.3 }).rotateZ(Math.PI / 2),
          ),
        },
        {
          name: 'hub',
          pos: [-L * 0.25, H / 2, D / 2 + hubLen / 2],
          rot: ROT_Y_TO_Z,
          mass: 2,
          colliders: [{ shape: { kind: 'cylinder', halfHeight: hubLen / 2, radius: 0.45 } }],
          visual: group(cylMesh(0.45, hubLen, '#f2f2f2', 0, 0, 0, 6)),
        },
      ],
      joints: [
        {
          kind: 'revolute',
          name: 'shaft',
          a: 'case',
          b: 'hub',
          anchor: [-L * 0.25, H / 2, D / 2],
          axis: [0, 0, 1],
          actuator: { kind: 'motor', maxTorque: 0.8, speed: 21, ratedVolts: 6 },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------------------- power + boards (shapes only for now)

const protoBoard: PartType = {
  id: 'board-proto',
  name: 'Circuit board (blank)',
  category: 'Boards',
  description: 'A plain board of any size, standing in for electronics you will add later.',
  swatch: '#2f7d4f',
  params: [
    { key: 'w', label: 'Width', kind: 'number', min: 1, max: 50, step: 0.1, unit: 'cm' },
    { key: 'd', label: 'Depth', kind: 'number', min: 1, max: 50, step: 0.1, unit: 'cm' },
    { key: 'color', label: 'Colour', kind: 'color' },
  ],
  defaults: { w: 5, d: 7, color: '#2f7d4f' },
  build: (p) => ({
    bodies: [
      {
        name: 'body',
        pos: [0, 0.08, 0],
        mass: p.w * p.d * 0.16 * 1.85 + 5,
        colliders: [{ shape: { kind: 'box', hx: p.w / 2, hy: 0.08, hz: p.d / 2 } }],
        visual: boxMesh(p.w, 0.16, p.d, p.color),
      },
    ],
    joints: [],
  }),
};

export const PARTS: PartType[] = [block, plate, rod, ball, wheel, caster, sg90, mg996, ttMotor, ...POWER, protoBoard, ...ELECTRONICS];
export const PART_BY_ID = new Map(PARTS.map((p) => [p.id, p]));
/** Add part types made elsewhere (the example kit, imported boards); a type already there is replaced. */
export function registerParts(types: PartType[]) {
  for (const t of types) {
    const i = PARTS.findIndex((p) => p.id === t.id);
    if (i >= 0) PARTS[i] = t;
    else PARTS.push(t);
    PART_BY_ID.set(t.id, t);
  }
}
export function unregisterParts(ids: string[]) {
  for (const id of ids) {
    const i = PARTS.findIndex((p) => p.id === id);
    if (i >= 0) PARTS.splice(i, 1);
    PART_BY_ID.delete(id);
  }
}
export const CATEGORIES = ['Structure', 'Motion', 'Power', 'Boards', 'Electronics', 'Modules', 'Sensors', 'Courses', 'My boards'];
