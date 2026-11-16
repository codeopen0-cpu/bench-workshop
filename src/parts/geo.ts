// Small helpers for drawing parts out of boxes and cylinders.
import * as THREE from 'three';

export function mat(color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, ...extra });
}
export function mesh(geo: THREE.BufferGeometry, color: string, x = 0, y = 0, z = 0, extra = {}) {
  const m = new THREE.Mesh(geo, mat(color, extra));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
export function boxMesh(w: number, h: number, d: number, color: string, x = 0, y = 0, z = 0) {
  return mesh(new THREE.BoxGeometry(w, h, d), color, x, y, z);
}
export function cylMesh(r: number, h: number, color: string, x = 0, y = 0, z = 0, segs = 32) {
  return mesh(new THREE.CylinderGeometry(r, r, h, segs), color, x, y, z);
}
export function group(...children: THREE.Object3D[]) {
  const g = new THREE.Group();
  for (const c of children) g.add(c);
  return g;
}
/** A row of header pins (gold posts on black plastic) along X, centred, at height y. */
export function headerRow(n: number, pitch: number, x0: number, y: number, z: number) {
  const g = new THREE.Group();
  g.add(boxMesh(n * pitch, 0.25, 0.25, '#151618', x0 + ((n - 1) * pitch) / 2, y + 0.125, z));
  for (let i = 0; i < n; i++) g.add(boxMesh(0.064, 0.6, 0.064, '#d9b54a', x0 + i * pitch, y + 0.3, z));
  return g;
}
