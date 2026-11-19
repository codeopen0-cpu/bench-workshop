// Courses: things to drive a robot over, around and along. Each one is FIXED when put on the bench (it
// stays put; untick "Fixed in place" to let it move). Ramp, stairs, speed bumps, a wall, an arena, rough
// ground, an obstacle field and a line-track mat (black tape on white, the shapes line robots run on).
import * as THREE from 'three';
import { boxMesh, group, mat, mesh } from './geo';
import type { BodyDef, ColliderDef, PartType, Q4 } from './types';

const WOOD = 0.6; // g/cm3: courses are plywood
const ROT_Y_TO_Z: Q4 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/** the same random numbers each time for the same seed (so a course looks the same when reopened) */
function rng(seed: number) {
  let s = (Math.floor(seed) * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number, friction?: number): ColliderDef =>
  ({ shape: { kind: 'box', hx: w / 2, hy: h / 2, hz: d / 2 }, pos: [x, y, z], ...(friction !== undefined ? { friction } : {}) });
const body = (mass: number, colliders: ColliderDef[], visual: THREE.Object3D): BodyDef => ({ name: 'body', pos: [0, 0, 0], mass, colliders, visual });
const sizeParams = () => [
  { key: 'w', label: 'Width', kind: 'number' as const, min: 5, max: 400, step: 1, unit: 'cm' },
  { key: 'd', label: 'Depth', kind: 'number' as const, min: 5, max: 400, step: 1, unit: 'cm' },
];
const colorParam = { key: 'color', label: 'Colour', kind: 'color' as const };

// -------------------------------------------------------------------------------------------- ramp
const ramp: PartType = {
  id: 'course-ramp',
  name: 'Ramp',
  category: 'Courses',
  description: 'A slope to drive up, rising along +X: a wedge (ending in a drop) or a hill (up, a flat top, down). How steep: its height over its length.',
  swatch: '#b98b5a',
  fixed: true,
  params: [
    { key: 'len', label: 'Length', kind: 'number', min: 2, max: 300, step: 1, unit: 'cm' },
    { key: 'h', label: 'Height', kind: 'number', min: 0.5, max: 100, step: 0.5, unit: 'cm' },
    { key: 'd', label: 'Width', kind: 'number', min: 2, max: 300, step: 1, unit: 'cm' },
    { key: 'kind', label: 'Shape', kind: 'select', options: [{ value: 'wedge', label: 'Wedge (up, then a drop)' }, { value: 'hill', label: 'Hill (up, flat, down)' }] },
    colorParam,
  ],
  defaults: { len: 30, h: 6, d: 20, kind: 'wedge', color: '#b98b5a' },
  build: (p) => {
    const L = p.len, H = p.h, D = p.d;
    const outline: [number, number][] = p.kind === 'hill'
      ? [[-L / 2, 0], [L / 2, 0], [L / 6, H], [-L / 6, H]]
      : [[-L / 2, 0], [L / 2, 0], [L / 2, H]];
    const pts = outline.flatMap(([x, y]) => [[x, y, -D / 2], [x, y, D / 2]]).flat();
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y))), { depth: D, bevelEnabled: false });
    geo.translate(0, 0, -D / 2);
    const vol = (p.kind === 'hill' ? (L + L / 3) / 2 * H : L * H / 2) * D;
    return {
      bodies: [body(vol * WOOD, [{ shape: { kind: 'hull', points: new Float32Array(pts), volume: vol }, friction: 0.9 }], mesh(geo, p.color))],
      joints: [],
    };
  },
};

// ------------------------------------------------------------------------------------------ stairs
const stairs: PartType = {
  id: 'course-stairs',
  name: 'Stairs',
  category: 'Courses',
  description: 'Steps going up along +X: a climbing test for legs, tracks and big wheels.',
  swatch: '#a07850',
  fixed: true,
  params: [
    { key: 'steps', label: 'Steps', kind: 'number', min: 1, max: 30, step: 1 },
    { key: 'rise', label: 'Each step up', kind: 'number', min: 0.2, max: 30, step: 0.1, unit: 'cm' },
    { key: 'run', label: 'Each step deep', kind: 'number', min: 1, max: 60, step: 0.5, unit: 'cm' },
    { key: 'd', label: 'Width', kind: 'number', min: 2, max: 300, step: 1, unit: 'cm' },
    colorParam,
  ],
  defaults: { steps: 4, rise: 2, run: 6, d: 25, color: '#a07850' },
  build: (p) => {
    const n = Math.max(1, Math.round(p.steps)), L = n * p.run;
    const cols: ColliderDef[] = [];
    const g = new THREE.Group();
    let vol = 0;
    for (let i = 0; i < n; i++) {
      // each step a block from the floor up to its top (simple, and no gaps for wheels to catch)
      const x = -L / 2 + (i + 0.5) * p.run, h = (i + 1) * p.rise;
      cols.push(box(p.run, h, p.d, x, h / 2, 0, 0.9));
      g.add(boxMesh(p.run, h, p.d, i % 2 ? p.color : shade(p.color, 0.92), x, h / 2, 0));
      vol += p.run * h * p.d;
    }
    return { bodies: [body(vol * WOOD, cols, g)], joints: [] };
  },
};

// ------------------------------------------------------------------------------------ speed bumps
const bumps: PartType = {
  id: 'course-bumps',
  name: 'Speed bumps',
  category: 'Courses',
  description: 'A board with round bumps across it, to drive over (+X): suspension, grip and wheel size tests.',
  swatch: '#d6b04a',
  fixed: true,
  params: [
    ...sizeParams(),
    { key: 'count', label: 'Bumps', kind: 'number', min: 1, max: 40, step: 1 },
    { key: 'r', label: 'Bump height', kind: 'number', min: 0.2, max: 10, step: 0.1, unit: 'cm' },
    colorParam,
  ],
  defaults: { w: 60, d: 25, count: 4, r: 0.6, color: '#6b6f78' },
  build: (p) => {
    const n = Math.max(1, Math.round(p.count)), base = 0.4;
    const cols: ColliderDef[] = [box(p.w, base, p.d, 0, base / 2, 0)];
    const g = group(boxMesh(p.w, base, p.d, p.color, 0, base / 2, 0));
    for (let i = 0; i < n; i++) {
      const x = -p.w / 2 + ((i + 0.5) * p.w) / n;
      // a round bar half sunk in the board, lying across it (along Z)
      cols.push({ shape: { kind: 'cylinder', halfHeight: p.d / 2, radius: p.r }, pos: [x, base, 0], rot: ROT_Y_TO_Z, friction: 0.9 });
      // (the half above the board: after turning Y to Z, the arc from 90 to 270 degrees is the top)
      const bar = mesh(new THREE.CylinderGeometry(p.r, p.r, p.d, 24, 1, false, Math.PI / 2, Math.PI), '#e8c547', x, base, 0);
      bar.rotation.x = Math.PI / 2;
      g.add(bar);
    }
    return { bodies: [body(p.w * p.d * base * WOOD, cols, g)], joints: [] };
  },
};

// ----------------------------------------------------------------------------------- wall & arena
const wall: PartType = {
  id: 'course-wall',
  name: 'Wall',
  category: 'Courses',
  description: 'A wall, fixed in place: for distance sensors, bumpers and wall-following robots.',
  swatch: '#d8d2c4',
  fixed: true,
  params: [
    { key: 'w', label: 'Length', kind: 'number', min: 1, max: 400, step: 1, unit: 'cm' },
    { key: 'h', label: 'Height', kind: 'number', min: 0.5, max: 100, step: 0.5, unit: 'cm' },
    { key: 't', label: 'Thickness', kind: 'number', min: 0.2, max: 20, step: 0.1, unit: 'cm' },
    colorParam,
  ],
  defaults: { w: 40, h: 10, t: 1.2, color: '#d8d2c4' },
  build: (p) => ({ bodies: [body(p.w * p.h * p.t * WOOD, [box(p.w, p.h, p.t, 0, p.h / 2, 0)], boxMesh(p.w, p.h, p.t, p.color, 0, p.h / 2, 0))], joints: [] }),
};

const arena: PartType = {
  id: 'course-arena',
  name: 'Arena',
  category: 'Courses',
  description: 'A floor with walls all round (a sumo ring, a maze base, a pen for a robot to roam in).',
  swatch: '#9aa7b4',
  fixed: true,
  params: [
    ...sizeParams(),
    { key: 'h', label: 'Wall height', kind: 'number', min: 0.5, max: 60, step: 0.5, unit: 'cm' },
    { key: 'floor', label: 'Floor colour', kind: 'color' },
    colorParam,
  ],
  defaults: { w: 100, d: 100, h: 8, floor: '#e9e6df', color: '#9aa7b4' },
  build: (p) => {
    const t = 1.2, f = 0.3, W = p.w, D = p.d, H = p.h;
    const cols: ColliderDef[] = [box(W, f, D, 0, f / 2, 0)];
    const g = group(boxMesh(W, f, D, p.floor, 0, f / 2, 0));
    for (const [w, d, x, z] of [[W, t, 0, -D / 2 + t / 2], [W, t, 0, D / 2 - t / 2], [t, D - 2 * t, -W / 2 + t / 2, 0], [t, D - 2 * t, W / 2 - t / 2, 0]]) {
      cols.push(box(w, H, d, x, f + H / 2, z));
      g.add(boxMesh(w, H, d, p.color, x, f + H / 2, z));
    }
    return { bodies: [body((W * D * f + 2 * (W + D) * H * t) * WOOD, cols, g)], joints: [] };
  },
};

// ------------------------------------------------------------------------------------ rough ground
const rough: PartType = {
  id: 'course-rough',
  name: 'Rough ground',
  category: 'Courses',
  description: 'A board strewn with stones stuck to it: rough terrain for wheels, tracks and legs. Seed: another seed, other stones.',
  swatch: '#8a7d6b',
  fixed: true,
  params: [
    ...sizeParams(),
    { key: 'stones', label: 'Stones', kind: 'number', min: 1, max: 400, step: 1 },
    { key: 'size', label: 'Biggest stone', kind: 'number', min: 0.2, max: 15, step: 0.1, unit: 'cm' },
    { key: 'seed', label: 'Seed', kind: 'number', min: 1, max: 9999, step: 1 },
    colorParam,
  ],
  defaults: { w: 60, d: 40, stones: 60, size: 1.5, seed: 1, color: '#8a7d6b' },
  build: (p) => {
    const r = rng(p.seed), base = 0.4;
    const cols: ColliderDef[] = [box(p.w, base, p.d, 0, base / 2, 0, 0.9)];
    const g = group(boxMesh(p.w, base, p.d, p.color, 0, base / 2, 0));
    const stoneMat = mat('#a39a8c', { roughness: 0.95 });
    const n = Math.max(1, Math.round(p.stones));
    for (let i = 0; i < n; i++) {
      const rad = (0.35 + 0.65 * r()) * p.size / 2;
      const x = (r() - 0.5) * (p.w - 2 * rad), z = (r() - 0.5) * (p.d - 2 * rad);
      const y = base + rad * (r() * 0.5 - 0.1); // (sunk a little, some more)
      cols.push({ shape: { kind: 'ball', radius: rad }, pos: [x, y, z], friction: 0.9 });
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 1), stoneMat);
      s.position.set(x, y, z);
      s.rotation.set(r() * 6, r() * 6, r() * 6);
      s.castShadow = s.receiveShadow = true;
      g.add(s);
    }
    return { bodies: [body(p.w * p.d * base * WOOD, cols, g)], joints: [] };
  },
};

// ---------------------------------------------------------------------------------- obstacle field
const obstacles: PartType = {
  id: 'course-obstacles',
  name: 'Obstacle field',
  category: 'Courses',
  description: 'Posts and boxes scattered over a floor, with a clear start in the middle: for obstacle-avoiding robots. Seed: another seed, another layout.',
  swatch: '#c45b4a',
  fixed: true,
  params: [
    ...sizeParams(),
    { key: 'count', label: 'Obstacles', kind: 'number', min: 1, max: 100, step: 1 },
    { key: 'h', label: 'Height', kind: 'number', min: 1, max: 60, step: 0.5, unit: 'cm' },
    { key: 'clear', label: 'Clear middle', kind: 'number', min: 0, max: 100, step: 1, unit: 'cm' },
    { key: 'seed', label: 'Seed', kind: 'number', min: 1, max: 9999, step: 1 },
    { key: 'floor', label: 'Floor colour', kind: 'color' },
    colorParam,
  ],
  defaults: { w: 120, d: 120, count: 14, h: 12, clear: 30, seed: 1, floor: '#e9e6df', color: '#c45b4a' },
  build: (p) => {
    const r = rng(p.seed), f = 0.3;
    const cols: ColliderDef[] = [box(p.w, f, p.d, 0, f / 2, 0)];
    const g = group(boxMesh(p.w, f, p.d, p.floor, 0, f / 2, 0));
    const n = Math.max(1, Math.round(p.count));
    let vol = p.w * p.d * f;
    for (let i = 0, tries = 0; i < n && tries < n * 30; tries++) {
      const round = r() < 0.4;
      const sx = 3 + r() * 9, sz = round ? sx : 3 + r() * 9;
      const x = (r() - 0.5) * (p.w - sx), z = (r() - 0.5) * (p.d - sz);
      if (Math.abs(x) < p.clear / 2 + sx / 2 && Math.abs(z) < p.clear / 2 + sz / 2) continue; // (the start stays clear)
      if (round) {
        cols.push({ shape: { kind: 'cylinder', halfHeight: p.h / 2, radius: sx / 2 }, pos: [x, f + p.h / 2, z] });
        g.add(mesh(new THREE.CylinderGeometry(sx / 2, sx / 2, p.h, 24), shade(p.color, 0.85 + 0.15 * r()), x, f + p.h / 2, z));
      } else {
        const a = r() * Math.PI;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
        cols.push({ ...box(sx, p.h, sz, x, f + p.h / 2, z), rot: [q.x, q.y, q.z, q.w] });
        const m = boxMesh(sx, p.h, sz, shade(p.color, 0.85 + 0.15 * r()), x, f + p.h / 2, z);
        m.rotation.y = a;
        g.add(m);
      }
      vol += sx * sz * p.h;
      i++;
    }
    return { bodies: [body(vol * WOOD, cols, g)], joints: [] };
  },
};

// -------------------------------------------------------------------------------------- line track
/** the tape's path, as points around (or along) it, in a w x d area */
function trackPath(shape: string, w: number, d: number): { pts: THREE.Vector2[]; closed: boolean } {
  const pts: THREE.Vector2[] = [];
  const a = w / 2, b = d / 2;
  if (shape === 'oval') {
    // a stadium: two straights and two half circles
    const r = Math.min(a, b), s = Math.max(0, a - r);
    const N = 96;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * 2 * Math.PI;
      const cx = Math.cos(t) >= 0 ? s : -s;
      pts.push(new THREE.Vector2(cx + r * Math.cos(t), r * Math.sin(t)));
    }
    return { pts, closed: true };
  }
  if (shape === 'figure8') {
    const N = 160;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * 2 * Math.PI;
      pts.push(new THREE.Vector2(a * Math.sin(t), b * Math.sin(t) * Math.cos(t) * 2));
    }
    return { pts, closed: true };
  }
  if (shape === 'square') {
    // rounded corners (a robot can't turn on a point)
    const r = Math.min(a, b) * 0.3, N = 12;
    const corners: [number, number, number][] = [[a - r, b - r, 0], [-a + r, b - r, 90], [-a + r, -b + r, 180], [a - r, -b + r, 270]];
    for (const [cx, cy, deg] of corners) for (let i = 0; i <= N; i++) {
      const t = ((deg + (i / N) * 90) * Math.PI) / 180;
      pts.push(new THREE.Vector2(cx + r * Math.cos(t), cy + r * Math.sin(t)));
    }
    return { pts, closed: true };
  }
  if (shape === 'wavy') {
    // a loop with wiggles on its long sides
    const N = 200;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * 2 * Math.PI;
      const k = 1 + 0.12 * Math.sin(6 * t);
      pts.push(new THREE.Vector2(a * k * Math.cos(t), b * k * Math.sin(t)));
    }
    return { pts, closed: true };
  }
  // zigzag: a line from one end to the other with sharp-ish turns
  const zig = 5;
  for (let i = 0; i <= zig; i++) pts.push(new THREE.Vector2(-a + (i / zig) * 2 * a, (i % 2 ? 1 : -1) * b * 0.7));
  const smooth = new THREE.SplineCurve(pts).getSpacedPoints(120);
  return { pts: smooth, closed: false };
}

/** a flat ribbon `width` wide along the path, at height y (in the XZ plane: path's y is Z) */
function ribbon(path: THREE.Vector2[], closed: boolean, width: number, y: number) {
  const pos: number[] = [], idx: number[] = [];
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const prev = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], next = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dir = next.clone().sub(prev).normalize();
    const nx = -dir.y * width / 2, nz = dir.x * width / 2;
    pos.push(path[i].x + nx, y, path[i].y + nz, path[i].x - nx, y, path[i].y - nz);
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    idx.push(2 * i, 2 * j, 2 * i + 1, 2 * i + 1, 2 * j, 2 * j + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const lineTrack: PartType = {
  id: 'course-line',
  name: 'Line track',
  category: 'Courses',
  description: 'A white mat with a black tape line on it (an oval, a figure 8, a square, a wavy loop or a zigzag) for line-following robots. The tape is 1.9 cm wide, like electrical tape.',
  swatch: '#222222',
  fixed: true,
  params: [
    ...sizeParams(),
    { key: 'shape', label: 'Line', kind: 'select', options: [
      { value: 'oval', label: 'Oval' }, { value: 'figure8', label: 'Figure 8' }, { value: 'square', label: 'Rounded square' },
      { value: 'wavy', label: 'Wavy loop' }, { value: 'zigzag', label: 'Zigzag (start to finish)' }] },
    { key: 'tape', label: 'Tape width', kind: 'number', min: 0.3, max: 6, step: 0.1, unit: 'cm' },
    { key: 'margin', label: 'Margin', kind: 'number', min: 0, max: 50, step: 0.5, unit: 'cm' },
    { key: 'mat', label: 'Mat colour', kind: 'color' },
    colorParam,
  ],
  defaults: { w: 90, d: 60, shape: 'oval', tape: 1.9, margin: 8, mat: '#f2f2ee', color: '#111111' },
  build: (p) => {
    const f = 0.2;
    const { pts, closed } = trackPath(p.shape, Math.max(2, p.w - 2 * p.margin), Math.max(2, p.d - 2 * p.margin));
    // (the tape is only a look: as thin as real tape, it is nothing to bump into)
    const tape = new THREE.Mesh(ribbon(pts, closed, p.tape, f + 0.004), mat(p.color, { roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    tape.receiveShadow = true;
    return {
      bodies: [body(p.w * p.d * f * WOOD, [box(p.w, f, p.d, 0, f / 2, 0, 0.8)], group(boxMesh(p.w, f, p.d, p.mat, 0, f / 2, 0), tape))],
      joints: [],
    };
  },
};

/** a colour a little darker (k < 1) */
function shade(hex: string, k: number) {
  return '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
}

export const COURSES: PartType[] = [ramp, stairs, bumps, wall, arena, rough, obstacles, lineTrack];
