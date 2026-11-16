// The 3D objects of each part on the bench, made from its PartType.
import * as THREE from 'three';
import { PART_BY_ID } from './parts/catalog';
import type { PartBuild, PartType } from './parts/types';
import type { PartInst } from './project';

export interface PartView {
  inst: PartInst;
  type: PartType;
  build: PartBuild;
  root: THREE.Group; // the part's frame
  bodies: Map<string, THREE.Object3D>; // each body's frame (children of root)
  mountBody: string;
}

export function makeView(inst: PartInst): PartView {
  const type = PART_BY_ID.get(inst.type)!;
  const build = type.build({ ...type.defaults, ...inst.params });
  const root = new THREE.Group();
  root.name = inst.name;
  root.userData.uid = inst.uid;
  const bodies = new Map<string, THREE.Object3D>();
  for (const b of build.bodies) {
    const o = new THREE.Group();
    o.name = `${inst.name}/${b.name}`;
    o.position.set(...b.pos);
    if (b.rot) o.quaternion.set(...b.rot);
    o.userData = { uid: inst.uid, body: b.name, isBody: true };
    o.add(b.visual);
    b.visual.traverse((m) => {
      m.userData = { ...m.userData, uid: inst.uid, body: b.name };
    });
    root.add(o);
    bodies.set(b.name, o);
  }
  return { inst, type, build, root, bodies, mountBody: type.mountBody ?? build.bodies[0].name };
}

/** All meshes of a view (for picking and highlighting). */
export function viewMeshes(v: PartView): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const o of v.bodies.values())
    o.traverse((m) => {
      if ((m as THREE.Mesh).isMesh && m.userData.uid === v.inst.uid) out.push(m as THREE.Mesh);
    });
  return out;
}

export function setHighlight(v: PartView, on: boolean, color = 0x4f9cff) {
  for (const m of viewMeshes(v)) {
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
    for (const mat of mats) {
      if (!mat.emissive) continue;
      mat.emissive = new THREE.Color(on ? color : 0x000000);
      mat.emissiveIntensity = on ? 0.35 : 0;
    }
  }
}

export function disposeView(v: PartView) {
  v.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      if (!m.userData.sharedGeo) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const x of mats) x.dispose();
    }
  });
  v.root.removeFromParent();
}
