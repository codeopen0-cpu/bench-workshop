// Imported 3D models (.stl): your own designs on the bench, to see how they look and how they work.
// A model becomes a part in "My parts": its look (the triangles) plus its solid shape for the physics,
// a few convex pieces worked out once, here, when it's imported (so holes, slots and hollows stay
// open, and running doesn't have to work them out again).
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import type { LibPart } from './format';
import type { V3 } from '../parts/types';

/** what one unit in the file is, in cm (an STL has no units: 3D printing and CAD use millimetres) */
export const UNITS = { mm: 0.1, cm: 1, m: 100, in: 2.54 } as const;
export type Unit = keyof typeof UNITS;
/** how heavy, g/cm^3 (a print: its walls plus the infill, about this much of a solid one) */
export const MATERIALS: { id: string; label: string; density: number }[] = [
  { id: 'pla20', label: '3D print, PLA, 20 % infill', density: 1.24 * 0.45 },
  { id: 'pla100', label: '3D print, PLA, solid', density: 1.24 },
  { id: 'petg20', label: '3D print, PETG, 20 % infill', density: 1.27 * 0.45 },
  { id: 'abs20', label: '3D print, ABS, 20 % infill', density: 1.04 * 0.45 },
  { id: 'wood', label: 'Wood (pine)', density: 0.5 },
  { id: 'plywood', label: 'Plywood', density: 0.65 },
  { id: 'acrylic', label: 'Acrylic', density: 1.18 },
  { id: 'rubber', label: 'Rubber', density: 1.15 },
  { id: 'alu', label: 'Aluminium', density: 2.7 },
  { id: 'steel', label: 'Steel', density: 7.85 },
];
/** most triangles a model may have (its file would be huge, and the bench slow) */
export const MAX_TRIANGLES = 400_000;

/** Read an .stl (binary or text). */
export function readStl(bytes: Uint8Array): THREE.BufferGeometry {
  const geo = new STLLoader().parse(bytes.slice().buffer);
  const n = (geo.getAttribute('position')?.count ?? 0) / 3;
  if (!n) throw new Error('there are no triangles in it');
  return geo;
}

export interface Prepared {
  geo: THREE.BufferGeometry; // indexed, cm, Y up, centred across, bottom on y = 0
  size: V3; // cm
  triangles: number;
  /** cm^3, if its surface is closed (else 0: worked out from the solid shape instead) */
  volume: number;
  closed: boolean;
}
/** The model in bench terms: centimetres, Y up, standing on y = 0, centred in x and z. */
export function prepareModel(src: THREE.BufferGeometry, unit: Unit, zUp: boolean, scale: number): Prepared {
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', (src.getAttribute('position') as THREE.BufferAttribute).clone());
  const k = UNITS[unit] * scale;
  geo.scale(k, k, k);
  if (zUp) geo.rotateX(-Math.PI / 2); // (CAD and slicers: Z is up; here Y is)
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  // the same corner shared by its triangles once (about 6 x smaller, and needed for the shape)
  const welded = mergeVertices(geo, Math.max(1e-5, 1e-4 * k));
  geo.dispose();
  geo = welded;
  // triangles squashed to a line or a point (two corners the same once welded) are nothing: drop them
  {
    const ix = geo.index!.array;
    const keep: number[] = [];
    for (let t = 0; t < ix.length; t += 3) if (ix[t] !== ix[t + 1] && ix[t + 1] !== ix[t + 2] && ix[t] !== ix[t + 2]) keep.push(ix[t], ix[t + 1], ix[t + 2]);
    if (keep.length !== ix.length) geo.setIndex(keep);
  }
  geo.computeBoundingBox();
  const size = geo.boundingBox!.getSize(new THREE.Vector3()).toArray() as V3;
  const idx = geo.index!.array, pos = geo.getAttribute('position').array as Float32Array;
  const triangles = idx.length / 3;
  // closed (watertight): every edge belongs to exactly two triangles. Then its volume is right.
  const edges = new Map<number, number>();
  const nv = pos.length / 3;
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(p, q) * nv + Math.max(p, q);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let closed = true;
  for (const n of edges.values()) if (n !== 2) { closed = false; break; }
  return { geo, size, triangles, volume: closed ? Math.abs(vol) : 0, closed };
}

export type Fit = 'detailed' | 'simple' | 'box';
export interface Hull { p: number[]; vol: number }

/** The solid shape: convex pieces. "detailed" splits the model into up to 24 (Rapier's V-HACD), so its
 *  holes and hollows stay open; "simple" wraps it in one (like shrink wrap); "box" is its box. */
export async function solidShape(prep: Prepared, fit: Fit): Promise<{ hulls: Hull[]; ms: number; how: string }> {
  const t0 = performance.now();
  const pos = prep.geo.getAttribute('position').array as Float32Array;
  const one = (pts: ArrayLike<number>) => hullOf(pts);
  if (fit === 'box') {
    const [w, h, d] = prep.size;
    const c: number[] = [];
    for (const x of [-w / 2, w / 2]) for (const y of [0, h]) for (const z of [-d / 2, d / 2]) c.push(x, y, z);
    return { hulls: [one(c)].filter(Boolean) as Hull[], ms: performance.now() - t0, how: 'its box' };
  }
  if (fit === 'detailed') {
    const R = (await import('@dimforge/rapier3d-compat')).default;
    await R.init();
    const desc = R.ColliderDesc.convexDecomposition(pos, new Uint32Array(prep.geo.index!.array), {
      resolution: 64, maxConvexHulls: 24, concavity: 0.01, convexHullApproximation: true,
    });
    const comp = desc?.shape as any;
    if (comp?.shapes?.length) {
      const hulls: Hull[] = [];
      const q = new THREE.Quaternion(), v = new THREE.Vector3();
      comp.shapes.forEach((s: any, k: number) => {
        const at = comp.positions?.[k] ?? { x: 0, y: 0, z: 0 }, r = comp.rotations?.[k] ?? { x: 0, y: 0, z: 0, w: 1 };
        q.set(r.x, r.y, r.z, r.w);
        const pts: number[] = [];
        const sv = s.vertices as Float32Array;
        for (let i = 0; i < sv.length; i += 3) {
          v.set(sv[i], sv[i + 1], sv[i + 2]).applyQuaternion(q).add(at as THREE.Vector3);
          pts.push(v.x, v.y, v.z);
        }
        const h = one(pts);
        if (h) hulls.push(h);
      });
      if (hulls.length) return { hulls, ms: performance.now() - t0, how: `${hulls.length} convex piece${hulls.length > 1 ? 's' : ''}` };
    }
    console.warn('[model] the detailed split found no pieces (an odd or open model?): wrapping it instead');
  }
  const h = one(pos);
  return { hulls: h ? [h] : [], ms: performance.now() - t0, how: 'one wrapped piece' };
}

/** A convex piece from points: only its corners kept (rounded to 0.01 mm), and its volume. */
function hullOf(points: ArrayLike<number>): Hull | null {
  const vs: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) vs.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
  if (vs.length < 4) return null;
  let hull: ConvexHull;
  try {
    hull = new ConvexHull().setFromPoints(vs);
  } catch {
    return null; // (flat: no solid)
  }
  const corners = new Set<THREE.Vector3>();
  let vol = 0;
  const o = vs[0];
  for (const f of hull.faces) {
    // each face as a fan of triangles: the volume between it and one point inside or on the hull
    const loop: THREE.Vector3[] = [];
    let e = f.edge;
    do { loop.push(e.head().point); e = e.next; } while (e !== f.edge);
    for (const p of loop) corners.add(p);
    for (let i = 1; i + 1 < loop.length; i++) {
      const a = loop[0].clone().sub(o), b = loop[i].clone().sub(o), c = loop[i + 1].clone().sub(o);
      vol += a.dot(b.cross(c)) / 6;
    }
  }
  if (corners.size < 4 || Math.abs(vol) < 1e-6) return null;
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return { p: [...corners].flatMap((p) => [r(p.x), r(p.y), r(p.z)]), vol: +Math.abs(vol).toFixed(4) };
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The part: its look and its solid shape, weighing `mass` grams. */
export function modelPart(o: { id: string; name: string; color: string; description?: string; prep: Prepared; hulls: Hull[]; mass: number }): LibPart {
  const pos = new Float32Array(o.prep.geo.getAttribute('position').array);
  const idx = new Uint32Array(o.prep.geo.index!.array);
  return {
    id: o.id,
    name: o.name,
    category: 'My models',
    description: o.description,
    swatch: o.color,
    mass: Math.max(0.5, +o.mass.toFixed(2)),
    shape: [
      { model: { v: b64(new Uint8Array(pos.buffer)), i: b64(new Uint8Array(idx.buffer)) }, color: o.color },
      ...o.hulls.map((h) => ({ hull: h })),
    ],
  };
}
