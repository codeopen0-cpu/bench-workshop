// A board described by its connectors and nets (from KiCad, or made in the app) as a Bench Workshop
// part: a slab of the right size, its 3D model if there is one, a pin for every connector pad, the
// click-together ports, and its copper: pins on the same net are joined.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { boxMesh, group } from '../parts/geo';
import type { PartType, PinDef, PinKind, PortDef } from '../parts/types';

export interface Pad { num: string; net: string; x: number; y: number } // mm from the board's top-left corner
export interface Connector {
  ref: string;
  value: string;
  pads: Pad[];
  labels?: string[];
  port?: { gender: 'male' | 'female'; edge: 'left' | 'right' | 'top' | 'bottom'; order: string[]; x: number; y: number };
}
export interface BoardData { w: number; h: number; x0?: number; y0?: number; connectors: Connector[] }

export interface NetBoardOpts {
  id: string;
  name: string;
  category: string;
  description: string;
  color: string; // PCB colour (for the slab, and the list)
  mass: number; // g
  glb?: string; // 3D model URL (KiCad GLB export: metres, Y up, board top at y = 0, page coordinates)
  thickness?: number; // cm, default 0.16
  /** connectors that aren't wireable (USB sockets, jumpers...) */
  skip?: (c: Connector) => boolean;
  programmable?: PartType['programmable'];
  params?: PartType['params'];
  defaults?: PartType['defaults'];
}

const T = 0.16;
export const pinIdOf = (c: Connector, p: Pad) => `${c.ref}.${p.num}`;
const niceNet = (net: string) => net.replace(/^\+/, '').replace(/^Net-\(.*\)$/, '');

export function pinKindOfNet(net: string): PinKind {
  const n = net.toUpperCase();
  if (n === 'GND') return 'gnd';
  if (/^(SDA|SCL)$/.test(n)) return 'i2c';
  if (/^(\+?3V3|\+?5V|VB|VBUS|MOD\d_VB|SERVO_V|VSYS)$/.test(n)) return 'vout';
  if (/^(VIN|VIN_RAW|VBAT)$/.test(n)) return 'vin';
  if (/SPK|SHUNT|MOTOR/.test(n)) return 'motor';
  return 'io';
}

/** Board-frame position (cm) of a point given in mm from the board's top-left corner. */
export const boardPos = (d: BoardData, x: number, y: number, up = T): [number, number, number] => [(x - d.w / 2) / 10, up, (y - d.h / 2) / 10];

const glbCache = new Map<string, Promise<THREE.Group>>();
function loadGlb(url: string) {
  if (!glbCache.has(url))
    glbCache.set(url, new GLTFLoader().loadAsync(url).then((g) => mergeByMaterial(g.scene, url)));
  return glbCache.get(url)!;
}

/** A 3D model kept inside a file (a library or an imported board) as base64; cached by key. */
export function glbFromBase64(key: string, b64: string) {
  if (!glbCache.has(key)) {
    const bytes = Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));
    glbCache.set(key, new GLTFLoader().parseAsync(bytes.buffer, '').then((g) => mergeByMaterial(g.scene, key)));
  }
  return glbCache.get(key)!;
}

/** KiCad's 3D export is thousands of tiny meshes (every pad, pin and resistor body: a 6 x 10 cm
 *  board can be 10,000+), one draw call each, twice with shadows: ~290 ms a frame. Baked into one mesh per
 *  look (colour/finish), the same board is a dozen draw calls. */
function mergeByMaterial(scene: THREE.Object3D, url: string) {
  scene.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.MeshStandardMaterial; geos: THREE.BufferGeometry[] }>();
  let count = 0;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    count++;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const src = mats[0] as THREE.MeshStandardMaterial;
    const key = [src.color?.getHexString(), src.metalness?.toFixed(2), src.roughness?.toFixed(2), src.opacity?.toFixed(2), src.transparent, src.emissive?.getHexString()].join('|');
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', m.geometry.getAttribute('position').clone());
    const n = m.geometry.getAttribute('normal');
    if (n) g.setAttribute('normal', n.clone());
    if (m.geometry.index) g.setIndex(m.geometry.index.clone());
    g.applyMatrix4(m.matrixWorld);
    if (!n) g.computeVertexNormals();
    if (!buckets.has(key)) buckets.set(key, { mat: src, geos: [] });
    buckets.get(key)!.geos.push(g);
  });
  const out = new THREE.Group();
  for (const { mat, geos } of buckets.values()) {
    const flat = geos.some((g) => !g.index) ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos;
    const merged = mergeGeometries(flat, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  console.info(`[netboard] ${url}: ${count} meshes merged into ${out.children.length}`);
  return out;
}

export function netBoard(data: BoardData, o: NetBoardOpts): PartType {
  const skip = o.skip ?? ((c: Connector) => /^JP/.test(c.ref) || /USB|microSD/i.test(c.value));
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    description: o.description,
    swatch: o.color,
    params: o.params ?? [],
    defaults: o.defaults ?? {},
    programmable: o.programmable,
    build: () => {
      const th = o.thickness ?? T;
      const slab = boxMesh(data.w / 10, th, data.h / 10, o.color, 0, th / 2, 0);
      const visual = group(slab);
      if (o.glb) {
        // the KiCad model replaces the slab once it's loaded (shared by every copy of the part)
        loadGlb(o.glb).then((scene) => {
          const m = scene.clone(true);
          m.scale.setScalar(100); // metres -> cm
          m.position.set(-((data.x0 ?? 0) + data.w / 2) / 10, th, -((data.y0 ?? 0) + data.h / 2) / 10);
          m.traverse((x) => {
            x.userData = { ...x.userData, ...slab.userData, sharedGeo: true }; // (the geometry is shared: don't dispose it)
            const mm = x as THREE.Mesh;
            if (mm.isMesh) mm.material = Array.isArray(mm.material) ? mm.material.map((q) => q.clone()) : mm.material.clone();
          });
          visual.add(m);
          slab.visible = false;
        }).catch(() => { /* no model: the slab stays */ });
      }
      const pins: PinDef[] = [];
      const ports: PortDef[] = [];
      for (const c of data.connectors) {
        if (c.port) {
          const p = c.port;
          const normal: [number, number, number] = p.edge === 'left' ? [-1, 0, 0] : p.edge === 'right' ? [1, 0, 0] : p.edge === 'top' ? [0, 0, -1] : [0, 0, 1];
          // the contact point: just outside the edge, where a mated connector's contact meets it
          const ex = p.edge === 'left' ? 0 : p.edge === 'right' ? data.w : p.x;
          const ey = p.edge === 'top' ? 0 : p.edge === 'bottom' ? data.h : p.y;
          const at = boardPos(data, ex + normal[0] * 3.5, ey + normal[2] * 3.5, th + 0.25);
          ports.push({ id: c.ref, body: 'body', pos: at, normal, gender: p.gender, pins: p.order.map((n) => `${c.ref}.${n}`) as [string, string, string, string] });
          for (const pad of c.pads)
            pins.push({ id: pinIdOf(c, pad), label: `${c.ref} ${niceNet(pad.net) || pad.num} (port)`, body: 'body', pos: boardPos(data, pad.x, pad.y, th + 0.25), kind: 'port' });
          continue;
        }
        if (skip(c)) continue;
        c.pads.forEach((pad, i) => {
          if (!pad.net) return;
          const label = c.labels?.[i] ?? niceNet(pad.net) ?? pad.num;
          pins.push({ id: pinIdOf(c, pad), label: `${label} (${c.ref}.${pad.num})`, body: 'body', pos: boardPos(data, pad.x, pad.y, th + 0.6), kind: pinKindOfNet(pad.net) });
        });
      }
      return {
        bodies: [{
          name: 'body', pos: [0, 0, 0], mass: o.mass,
          colliders: [{ shape: { kind: 'box', hx: data.w / 20, hy: th / 2, hz: data.h / 20 }, pos: [0, th / 2, 0] }],
          visual,
        }],
        joints: [],
        pins,
        ports,
      };
    },
  };
}

/** Pins joined by the board's copper: every pair of connector pads on the same net. */
export function netShorts(data: BoardData): [string, string][] {
  const byNet = new Map<string, string[]>();
  for (const c of data.connectors)
    for (const p of c.pads) {
      if (!p.net) continue;
      if (!byNet.has(p.net)) byNet.set(p.net, []);
      byNet.get(p.net)!.push(pinIdOf(c, p));
    }
  const out: [string, string][] = [];
  for (const pins of byNet.values()) for (let i = 1; i < pins.length; i++) out.push([pins[0], pins[i]]);
  return out;
}

/** The first pin on a net (for devices: "the 3V3 pin", "the SDA pin"). */
export function pinOfNet(data: BoardData, net: string): string | undefined {
  for (const c of data.connectors) for (const p of c.pads) if (p.net === net) return pinIdOf(c, p);
  return undefined;
}
